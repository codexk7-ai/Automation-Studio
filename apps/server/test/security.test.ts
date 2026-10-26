import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.ts";
import type { App } from "../src/app.ts";
import { base32Encode, hotp, totpAt, verifyTotp } from "../src/security/totp.ts";
import { resetSsoCaches } from "../src/services/sso.ts";
import { mockServer, testApp } from "./helpers.ts";

let app: App;
let server: FastifyInstance;

/** Cookie-aware client over fastify.inject. */
class Client {
  cookie = "";
  csrf = "";
  async req(method: string, url: string, payload?: unknown) {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && method !== "GET") headers["x-csrf-token"] = this.csrf;
    const res = await server.inject({ method: method as never, url, payload: payload as never, headers });
    const set = res.headers["set-cookie"];
    if (set) this.cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, json, headers: res.headers };
  }
  async register(email: string) {
    const r = await this.req("POST", "/api/auth/register", { email, name: email.split("@")[0], password: "correct horse battery" });
    this.csrf = r.json.csrfToken;
    return r;
  }
}

beforeAll(async () => {
  app = await testApp();
  server = await buildServer(app.ctx);
});
afterAll(async () => {
  await server.close();
  await app.close();
});

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC test vectors (SHA1, 8 digits truncated to 6)", () => {
    const secret = Buffer.from("12345678901234567890");
    // RFC 6238 Appendix B (SHA1): T=59 -> 94287082, T=1111111109 -> 07081804 (last 6 digits).
    expect(hotp(secret, Math.floor(59 / 30))).toBe("287082");
    expect(hotp(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpAt(base32Encode(secret), 1234567890 * 1000)).toBe("005924");
  });

  it("rejects replays and codes outside the window", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const t = 1_800_000_000_000;
    const code = totpAt(secret, t);
    const counter = verifyTotp(secret, code, 0, t)!;
    expect(counter).toBeGreaterThan(0);
    expect(verifyTotp(secret, code, counter, t)).toBeNull(); // reuse
    expect(verifyTotp(secret, totpAt(secret, t - 120_000), 0, t)).toBeNull(); // too old
    expect(verifyTotp(secret, "abc123", 0, t)).toBeNull();
  });
});

describe("two-factor sign-in", () => {
  it("enrolls, requires a code at login, blocks reuse, accepts a recovery code once", async () => {
    const c = new Client();
    const email = `mfa-${Date.now()}@example.com`;
    await c.register(email);
    const setup = await c.req("POST", "/api/auth/2fa/setup");
    expect(setup.json.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((await c.req("POST", "/api/auth/2fa/confirm", { code: "000000" })).status).toBe(400);
    // Use the previous time step so the login below (current step) is not a "reuse".
    const confirm = await c.req("POST", "/api/auth/2fa/confirm", { code: totpAt(setup.json.secret, Date.now() - 30_000) });
    expect(confirm.status).toBe(200);
    expect(confirm.json.recoveryCodes).toHaveLength(10);

    const fresh = new Client();
    const login = await fresh.req("POST", "/api/auth/login", { email, password: "correct horse battery" });
    expect(login.json.mfaRequired).toBe(true);
    expect(fresh.cookie).toBe(""); // no session before the second factor
    expect((await fresh.req("POST", "/api/auth/login/mfa", { mfaToken: login.json.mfaToken, code: "123456" })).status).toBe(401);
    expect((await fresh.req("POST", "/api/auth/login/mfa", { mfaToken: `${login.json.mfaToken}x`, code: totpAt(setup.json.secret) })).status).toBe(401);
    const code = totpAt(setup.json.secret);
    const ok = await fresh.req("POST", "/api/auth/login/mfa", { mfaToken: login.json.mfaToken, code });
    expect(ok.status).toBe(200);
    fresh.csrf = ok.json.csrfToken;
    expect((await fresh.req("GET", "/api/workflows")).status).toBe(200);

    const again = new Client();
    const l2 = await again.req("POST", "/api/auth/login", { email, password: "correct horse battery" });
    expect((await again.req("POST", "/api/auth/login/mfa", { mfaToken: l2.json.mfaToken, code })).status).toBe(401); // replay
    const rc = confirm.json.recoveryCodes[0];
    expect((await again.req("POST", "/api/auth/login/mfa", { mfaToken: l2.json.mfaToken, code: rc })).status).toBe(200);
    const third = new Client();
    const l3 = await third.req("POST", "/api/auth/login", { email, password: "correct horse battery" });
    expect((await third.req("POST", "/api/auth/login/mfa", { mfaToken: l3.json.mfaToken, code: rc })).status).toBe(401); // recovery code is single-use
    const row = await app.ctx.db.one<{ totp_secret: string }>("SELECT totp_secret FROM users WHERE lower(email) = $1", [email]);
    expect(row!.totp_secret.startsWith("v1.")).toBe(true); // encrypted at rest
  });

  it("locks the account after repeated wrong codes, even with fresh challenges", async () => {
    const c = new Client();
    const email = `lock-${Date.now()}@example.com`;
    await c.register(email);
    const setup = await c.req("POST", "/api/auth/2fa/setup");
    await c.req("POST", "/api/auth/2fa/confirm", { code: totpAt(setup.json.secret, Date.now() - 30_000) });
    for (let i = 0; i < 8; i++) {
      const l = await new Client().req("POST", "/api/auth/login", { email, password: "correct horse battery" });
      expect((await new Client().req("POST", "/api/auth/login/mfa", { mfaToken: l.json.mfaToken, code: "000000" })).status).toBe(401);
    }
    // Locked: even the correct password (and therefore any code) is refused for 15 minutes.
    const blocked = await new Client().req("POST", "/api/auth/login", { email, password: "correct horse battery" });
    expect(blocked.status).toBe(401);
    expect(blocked.json.error.message).toMatch(/Too many failed attempts/);
  });

  it("enforces a workspace 2FA requirement for members", async () => {
    const owner = new Client();
    await owner.register(`own2fa-${Date.now()}@example.com`);
    expect((await owner.req("PATCH", "/api/workspace", { settings: { require2fa: true } })).status).toBe(400); // owner must enroll first
    const s = await owner.req("POST", "/api/auth/2fa/setup");
    await owner.req("POST", "/api/auth/2fa/confirm", { code: totpAt(s.json.secret) });
    expect((await owner.req("PATCH", "/api/workspace", { settings: { require2fa: true } })).status).toBe(200);
    const memberEmail = `member2fa-${Date.now()}@example.com`;
    const added = await owner.req("POST", "/api/members", { email: memberEmail, role: "editor" });
    const member = new Client();
    const l = await member.req("POST", "/api/auth/login", { email: memberEmail, password: added.json.temporaryPassword });
    member.csrf = l.json.csrfToken;
    const ws = await owner.req("GET", "/api/auth/me");
    await member.req("POST", "/api/auth/switch-workspace", { workspaceId: ws.json.workspace.id });
    const blocked = await member.req("GET", "/api/workflows");
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe("mfa_enrollment_required");
    const ms = await member.req("POST", "/api/auth/2fa/setup");
    await member.req("POST", "/api/auth/2fa/confirm", { code: totpAt(ms.json.secret) });
    expect((await member.req("GET", "/api/workflows")).status).toBe(200);
  });
});

describe("record-level permissions", () => {
  it("members only see and change their own rows when row access is 'own'; admins see all", async () => {
    const owner = new Client();
    await owner.register(`rows-${Date.now()}@example.com`);
    const t = (await owner.req("POST", "/api/tables", { name: "Deals", rowAccess: "own", columns: [{ name: "Title", type: "text", required: true }] })).json;
    const ownerRow = (await owner.req("POST", `/api/tables/${t.id}/rows`, { data: { title: "Owner deal" } })).json;
    const editors = [];
    for (const n of [1, 2]) {
      const email = `rep${n}-${Date.now()}@example.com`;
      const added = await owner.req("POST", "/api/members", { email, role: "editor" });
      const c = new Client();
      const l = await c.req("POST", "/api/auth/login", { email, password: added.json.temporaryPassword });
      c.csrf = l.json.csrfToken;
      const ws = await owner.req("GET", "/api/auth/me");
      await c.req("POST", "/api/auth/switch-workspace", { workspaceId: ws.json.workspace.id });
      editors.push({ c, userId: added.json.userId as string });
    }
    const [a, b] = editors as [{ c: Client; userId: string }, { c: Client; userId: string }];
    const aRow = (await a.c.req("POST", `/api/tables/${t.id}/rows`, { data: { title: "A's deal" } })).json;
    await b.c.req("POST", `/api/tables/${t.id}/rows`, { data: { title: "B's deal" } });

    const aList = await a.c.req("GET", `/api/tables/${t.id}/rows`);
    expect(aList.json.rows.map((r: { data: { title: string } }) => r.data.title)).toEqual(["A's deal"]);
    expect(aList.json.total).toBe(1);
    expect((await b.c.req("PATCH", `/api/tables/${t.id}/rows/${aRow.id}`, { data: { title: "hijack" } })).status).toBe(404);
    expect((await b.c.req("DELETE", `/api/tables/${t.id}/rows/${aRow.id}`)).status).toBe(404);
    expect((await a.c.req("PATCH", `/api/tables/${t.id}/rows/${ownerRow.id}`, { data: { title: "x" } })).status).toBe(404);
    expect((await owner.req("GET", `/api/tables/${t.id}/rows`)).json.total).toBe(3);

    // Admin reassigns A's deal to B; members cannot reassign.
    expect((await a.c.req("PUT", `/api/tables/${t.id}/rows/${aRow.id}/owner`, { ownerId: a.userId })).status).toBe(403);
    expect((await owner.req("PUT", `/api/tables/${t.id}/rows/${aRow.id}/owner`, { ownerId: b.userId })).status).toBe(200);
    expect((await a.c.req("GET", `/api/tables/${t.id}/rows`)).json.total).toBe(0);
    expect((await b.c.req("GET", `/api/tables/${t.id}/rows`)).json.total).toBe(2);
  });
});

describe("OpenID Connect SSO", () => {
  let idp: Awaited<ReturnType<typeof mockServer>>;
  let privateKey: KeyObject;
  const claimsOverride: Record<string, unknown> = {};
  let tamper = false;

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = (claims: Record<string, unknown>) => {
    const h = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
    const p = b64(claims);
    const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url");
    return `${h}.${p}.${tamper ? s.slice(0, -4) + "AAAA" : s}`;
  };
  const nonces = new Map<string, string>();

  beforeAll(async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKey = pair.privateKey;
    const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
    idp = await mockServer(async (req, res) => {
      const url = new URL(req.url!, idp.url);
      const json = (o: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url.pathname === "/.well-known/openid-configuration") return json({ issuer: idp.url, authorization_endpoint: `${idp.url}/authorize`, token_endpoint: `${idp.url}/token`, jwks_uri: `${idp.url}/jwks` });
      if (url.pathname === "/jwks") return json({ keys: [jwk] });
      if (url.pathname === "/token") {
        const form = new URLSearchParams(req.body);
        expect(form.get("code_verifier")).toBeTruthy();
        expect(form.get("client_secret")).toBe("sso-secret");
        const now = Math.floor(Date.now() / 1000);
        return json({ access_token: "at", token_type: "Bearer", id_token: sign({ iss: idp.url, aud: "studio", sub: "u-123", email: "sso.user@corp.example", email_verified: true, name: "SSO User", iat: now, exp: now + 300, nonce: nonces.get(form.get("code")!), ...claimsOverride }) });
      }
      res.writeHead(404);
      res.end();
    });
    app.ctx.policy.allowlist.push(idp.hostKey);
    app.ctx.config.oidc = { issuer: idp.url, clientId: "studio", clientSecret: "sso-secret", allowedDomains: ["corp.example"], autoCreate: true, label: "Sign in with Corp SSO" };
    resetSsoCaches();
  });
  afterAll(async () => {
    await idp.close();
    app.ctx.config.oidc = null;
  });

  async function flow() {
    const c = new Client();
    const start = await c.req("GET", "/api/auth/sso/start");
    expect(start.status).toBe(302);
    const auth = new URL(String(start.headers.location));
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("scope")).toBe("openid email profile");
    const code = `code-${Math.random()}`;
    nonces.set(code, auth.searchParams.get("nonce")!);
    const cb = await c.req("GET", `/api/auth/sso/callback?code=${encodeURIComponent(code)}&state=${auth.searchParams.get("state")}`);
    return { c, cb, state: auth.searchParams.get("state")!, code };
  }

  it("signs in with a verified ID token and creates the account", async () => {
    const { c, cb, state, code } = await flow();
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe("/");
    const me = await c.req("GET", "/api/auth/me");
    expect(me.json.user.email).toBe("sso.user@corp.example");
    // State is single-use.
    const replay = await new Client().req("GET", `/api/auth/sso/callback?code=${code}&state=${state}`);
    expect(String(replay.headers.location)).toContain("sso_error");
  });

  it("rejects tampered signatures, wrong audience and disallowed domains", async () => {
    tamper = true;
    expect(String((await flow()).cb.headers.location)).toMatch(/sso_error=.*signature/i);
    tamper = false;
    claimsOverride.aud = "someone-else";
    expect(String((await flow()).cb.headers.location)).toMatch(/sso_error=.*audience/i);
    delete claimsOverride.aud;
    claimsOverride.email = "intruder@evil.example";
    claimsOverride.sub = "u-999";
    expect(String((await flow()).cb.headers.location)).toMatch(/sso_error=.*not%20allowed/i);
    delete claimsOverride.email;
    delete claimsOverride.sub;
    claimsOverride.exp = Math.floor(Date.now() / 1000) - 3600;
    expect(String((await flow()).cb.headers.location)).toMatch(/sso_error=.*expired/i);
    delete claimsOverride.exp;
  });
});
