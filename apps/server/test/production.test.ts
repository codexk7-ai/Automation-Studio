import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { checkProductionConfig, createPgRateLimitStore } from "../src/production.ts";
import { createCredential, loadCredential } from "../src/services/credentials.ts";
import { TEST_KEY, testApp, testUser } from "./helpers.ts";

describe("production configuration checks", () => {
  it("refuses unsafe production settings and allows a correct setup", () => {
    const base = loadConfig({ env: "production", encryptionKey: TEST_KEY, publicUrl: "http://example.com", secureCookies: false, databaseUrl: "", allowRegistration: true });
    const bad = checkProductionConfig(base);
    expect(bad.errors.join(" ")).toMatch(/https/);
    expect(bad.errors.join(" ")).toMatch(/SECURE_COOKIES/);
    expect(bad.errors.join(" ")).toMatch(/DATABASE_URL/);
    const good = checkProductionConfig({ ...base, publicUrl: "https://automate.example.com", secureCookies: true, databaseUrl: "postgres://x", allowRegistration: false });
    expect(good.errors).toEqual([]);
  });

  it("createApp fails fast in production with an unsafe config", async () => {
    await expect(createApp({ env: "production", encryptionKey: TEST_KEY, publicUrl: "http://x", secureCookies: false, databaseUrl: "", pgliteDataDir: "memory://", logLevel: "silent" })).rejects.toThrow(/Unsafe production configuration/);
  });
});

describe("operational endpoints", () => {
  it("serves readiness, guards /metrics with a token, and uses __Host- cookies when secure", async () => {
    const app = await testApp();
    const server = await buildServer(app.ctx);
    expect((await server.inject({ url: "/api/ready" })).json()).toMatchObject({ status: "ready", migrations: 3 });
    expect((await server.inject({ url: "/metrics" })).statusCode).toBe(404); // disabled without METRICS_TOKEN
    process.env.METRICS_TOKEN = "metrics-secret-token";
    expect((await server.inject({ url: "/metrics", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    const m = await server.inject({ url: "/metrics", headers: { authorization: "Bearer metrics-secret-token" } });
    expect(m.statusCode).toBe(200);
    expect(m.body).toContain("automation_jobs");
    expect(m.body).toContain("automation_http_requests_total");
    delete process.env.METRICS_TOKEN;
    await server.close();

    app.ctx.config.secureCookies = true;
    const secure = await buildServer(app.ctx);
    const reg = await secure.inject({ method: "POST", url: "/api/auth/register", payload: { email: `c-${Date.now()}@example.com`, password: "correct horse battery" } });
    expect(String(reg.headers["set-cookie"])).toMatch(/^__Host-as_session=.*Secure/);
    await secure.close();
    await app.close();
  });
});

describe("shared PostgreSQL rate-limit store", () => {
  it("keeps separate counters per route and per key, and resets after the window", async () => {
    const app = await testApp();
    const Store = createPgRateLimitStore(app.ctx.db);
    const root = new Store();
    const forms = root.child({ routeInfo: { method: "POST", url: "/api/public/forms/:slug" } });
    const login = root.child({ routeInfo: { method: "POST", url: "/api/auth/login" } });
    const incr = (s: InstanceType<typeof Store>, key: string, windowMs = 60_000) => new Promise<{ current: number; ttl: number }>((res) => s.incr(key, (_e, r) => res(r!), windowMs));
    for (let i = 0; i < 5; i++) await incr(login, "1.2.3.4");
    expect((await incr(login, "1.2.3.4")).current).toBe(6);
    expect((await incr(forms, "1.2.3.4")).current).toBe(1); // different route, separate counter
    expect((await incr(login, "5.6.7.8")).current).toBe(1); // different client
    await incr(forms, "9.9.9.9", 200);
    await new Promise((r) => setTimeout(r, 350));
    expect((await incr(forms, "9.9.9.9", 200)).current).toBe(1); // window expired
    expect(() => root.child({})).toThrow(/no route information/);
    await app.close();
  });
});

describe("encryption key rotation", () => {
  it("re-encrypts connections and 2FA secrets so they work only with the new key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-rotate-"));
    const NEW_KEY = "f".repeat(64);
    const opts = { env: "test" as const, pgliteDataDir: dir, databaseUrl: "", logLevel: "silent", workerMode: "off" as const, smtp: null };
    const app = await createApp({ ...opts, encryptionKey: TEST_KEY });
    const { principal } = await testUser(app);
    const cred = await createCredential(app.ctx, principal, { name: "Key", type: "http_auth", data: { authType: "bearer", token: "rotate-me-secret-1234" } });
    await app.ctx.db.query("UPDATE users SET totp_secret = $2 WHERE id = $1", [principal.userId, app.ctx.secrets.encrypt("JBSWY3DPEHPK3PXP", `totp:${principal.userId}`)]);
    await app.close();

    execFileSync(process.execPath, ["--import", "tsx", "apps/server/src/cli/rotate-key.ts"], {
      env: { ...process.env, ENCRYPTION_KEY: TEST_KEY, NEW_ENCRYPTION_KEY: NEW_KEY, PGLITE_DATA_DIR: dir, DATABASE_URL: "", NODE_ENV: "test", LOG_LEVEL: "silent" },
      stdio: "pipe",
    });

    const rotated = await createApp({ ...opts, encryptionKey: NEW_KEY });
    expect((await loadCredential(rotated.ctx, principal.workspaceId, cred.id)).data.token).toBe("rotate-me-secret-1234");
    const u = await rotated.ctx.db.one<{ totp_secret: string }>("SELECT totp_secret FROM users WHERE id = $1", [principal.userId]);
    expect(rotated.ctx.secrets.decrypt(u!.totp_secret, `totp:${principal.userId}`)).toBe("JBSWY3DPEHPK3PXP");
    await rotated.close();

    const old = await createApp({ ...opts, encryptionKey: TEST_KEY });
    await expect(loadCredential(old.ctx, principal.workspaceId, cred.id)).rejects.toThrow();
    await old.close();
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
