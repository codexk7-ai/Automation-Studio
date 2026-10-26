import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { WorkflowDefinitionInput } from "@automation-studio/core";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.ts";
import type { Principal } from "../src/auth/principal.ts";
import { createCredential, testCredential } from "../src/services/credentials.ts";
import { createWorkflow, publishWorkflow, runWorkflow } from "../src/services/workflows.ts";
import { drain, executionState, mockServer, testApp, testUser } from "./helpers.ts";

/**
 * Integration verification without third-party accounts:
 * - SMTP and PostgreSQL run against real protocol servers.
 * - SaaS adapters run against a local server standing in for each provider's
 *   official host; it asserts the documented request shape (method, path,
 *   auth headers, body) and answers with documented response shapes.
 */

let app: App;
let p: Principal;
let provider: Awaited<ReturnType<typeof mockServer>>;
const calls: Array<{ method: string; url: string; headers: Record<string, unknown>; body: string }> = [];
const PROVIDER_HOSTS = ["api.anthropic.com", "sheets.googleapis.com", "www.googleapis.com", "graph.facebook.com", "api.hubapi.com", "hooks.slack.com"];

function reply(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  provider = await mockServer(async (req, res) => {
    const [, host, ...rest] = (req.url ?? "").split("/");
    const path = `/${rest.join("/")}`;
    calls.push({ method: req.method!, url: `https://${host}${path}`, headers: req.headers, body: req.body });
    const u = new URL(`https://${host}${path}`);
    if (host === "api.anthropic.com" && u.pathname === "/v1/messages") {
      const body = JSON.parse(req.body);
      const wantsJson = body.output_config?.format?.type === "json_schema";
      const text = wantsJson ? JSON.stringify({ label: "hot", confidence: 0.92, reasoning: "Budget and timeline stated." }) : "A concise summary.";
      return reply(res, 200, { id: "msg_test", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30 } });
    }
    if (host === "sheets.googleapis.com") {
      if (req.method === "GET") return reply(res, 200, { range: "Sheet1!1:1", values: [["Name", "Email", "Notes"]] });
      return reply(res, 200, { spreadsheetId: "abc", updates: { updatedRange: "Sheet1!A2:C2", updatedRows: 1 } });
    }
    if (host === "files" && u.pathname === "/video.mp4") {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.alloc(4096, 7));
      return;
    }
    if (host === "www.googleapis.com" && u.pathname === "/upload/youtube/v3/videos" && req.method === "POST") {
      res.writeHead(200, { location: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION1" });
      res.end();
      return;
    }
    if (host === "www.googleapis.com" && u.pathname === "/upload/youtube/v3/videos" && req.method === "PUT") {
      return reply(res, 200, { kind: "youtube#video", id: "NEWVIDEO01a", status: { uploadStatus: "uploaded", privacyStatus: "private" } });
    }
    if (host === "www.googleapis.com" && u.pathname === "/youtube/v3/videos") {
      return reply(res, 200, { items: [{ id: "dQw4w9WgXcQ", snippet: { title: "Demo", description: "Desc", tags: ["a"], channelId: "UC1", channelTitle: "Ch", publishedAt: "2026-01-01T00:00:00Z", categoryId: "22" }, statistics: { viewCount: "10", likeCount: "2", commentCount: "1" }, contentDetails: { duration: "PT1M" } }] });
    }
    if (host === "graph.facebook.com") return reply(res, 200, { messaging_product: "whatsapp", contacts: [{ input: "15551234567", wa_id: "15551234567" }], messages: [{ id: "wamid.TEST", message_status: "accepted" }] });
    if (host === "api.hubapi.com") {
      if (u.pathname.endsWith("/search")) return reply(res, 200, { total: 0, results: [] });
      return reply(res, 201, { id: "901", properties: JSON.parse(req.body).properties });
    }
    if (host === "hooks.slack.com") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    reply(res, 404, { error: "unexpected path" });
  });
  app = await testApp([provider.hostKey]);
  // Route the providers' official hosts to the local stand-in (the adapters still build the real URLs).
  const original = app.ctx.fetch;
  app.ctx.fetch = ((input: string | URL | Request, init?: object) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (PROVIDER_HOSTS.includes(url.hostname)) return original(`${provider.url}/${url.hostname}${url.pathname}${url.search}`, init as never);
    return original(input, init as never);
  }) as typeof original;
  p = (await testUser(app)).principal;
});

afterAll(async () => {
  await app.close();
  await provider.close();
});

async function runLive(definition: WorkflowDefinitionInput, payload: unknown = {}) {
  const wf = await createWorkflow(app.ctx, p, { name: `Live ${Date.now()}`, definition });
  await publishWorkflow(app.ctx, p, wf.id);
  const { executionId } = await runWorkflow(app.ctx, p, wf.id, { mode: "manual", payload });
  await drain(app);
  return executionState(app, executionId);
}

const single = (node: Record<string, unknown>): WorkflowDefinitionInput => ({
  schemaVersion: 1,
  nodes: [{ id: "trigger", type: "trigger.manual", name: "Start", config: {} }, { id: "step", name: "Step", config: {}, ...node } as never],
  edges: [{ id: "e1", source: "trigger", target: "step" }],
});

const last = (host: string) => [...calls].reverse().find((c) => c.url.includes(host))!;

describe("SMTP (real SMTP server)", () => {
  it("delivers with authentication, headers and attachment, and records it as sent", async () => {
    const received: Array<{ auth: string; raw: string }> = [];
    const smtp = new SMTPServer({
      authOptional: false,
      disabledCommands: ["STARTTLS"],
      onAuth(auth, _session, cb) {
        if (auth.username === "mailer" && auth.password === "smtp-pass-123") return cb(null, { user: auth.username });
        cb(new Error("Invalid credentials"));
      },
      onData(stream, session, cb) {
        let raw = "";
        stream.on("data", (d) => (raw += d));
        stream.on("end", () => {
          received.push({ auth: String(session.user), raw });
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
    const port = (smtp.server.address() as AddressInfo).port;
    app.ctx.config.outboundAllowlist.push(`127.0.0.1:${port}`);

    const cred = await createCredential(app.ctx, p, { name: "Local SMTP", type: "smtp", data: { host: "127.0.0.1", port, secure: false, username: "mailer", password: "smtp-pass-123", from: "Team <team@example.com>" } });
    expect((await testCredential(app.ctx, p, cred.id)).ok).toBe(true);
    const bad = await createCredential(app.ctx, p, { name: "Bad SMTP", type: "smtp", data: { host: "127.0.0.1", port, username: "mailer", password: "wrong" } });
    expect((await testCredential(app.ctx, p, bad.id)).ok).toBe(false);

    const state = await runLive(
      single({ type: "email.send", credentialId: cred.id, config: { to: "{{ trigger.email }}", subject: "Hello {{ trigger.name }}", body: "Your report is attached.", attachmentName: "report.csv", attachmentContent: "a,b\n1,2", attachmentType: "text/csv" } }),
      { email: "ada@example.com", name: "Ada" },
    );
    await new Promise<void>((r) => smtp.close(() => r()));
    expect(state.status).toBe("succeeded");
    expect(state.steps.step!.output).toMatchObject({ provider: "smtp", delivered: true, status: "sent" });
    expect(received).toHaveLength(1);
    expect(received[0]!.auth).toBe("mailer");
    const mail = await simpleParser(received[0]!.raw);
    expect(mail.subject).toBe("Hello Ada");
    expect(mail.text?.trim()).toBe("Your report is attached.");
    expect((mail.to as { text: string }).text).toBe("ada@example.com");
    expect(mail.from?.text).toContain("team@example.com");
    expect(mail.attachments[0]?.filename).toBe("report.csv");
    expect(mail.attachments[0]?.content.toString()).toBe("a,b\n1,2");
    // The SMTP password never appears in the stored step input/output.
    expect(JSON.stringify(state.steps.step)).not.toContain("smtp-pass-123");
  });
});

describe("PostgreSQL (real wire protocol)", () => {
  it("inserts and queries with parameters and enforces read-only mode", async () => {
    const db = new PGlite();
    await db.exec("CREATE TABLE customers (id serial primary key, email text not null, plan text)");
    const server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" });
    await server.start();
    const port = Number(server.getServerConn().split(":").pop());
    app.ctx.config.outboundAllowlist.push(`127.0.0.1:${port}`);
    const cred = await createCredential(app.ctx, p, { name: "Local PG", type: "postgres", data: { host: "127.0.0.1", port, database: "postgres", user: "postgres", password: "x", ssl: false } });
    expect((await testCredential(app.ctx, p, cred.id)).ok).toBe(true);

    const insert = await runLive(single({ type: "postgres.insert_row", credentialId: cred.id, config: { table: "customers", data: { email: "{{ trigger.email }}", plan: "pro" } } }), { email: "x'); DROP TABLE customers; --" });
    expect(insert.status).toBe("succeeded");
    expect((insert.steps.step!.output as { row: { email: string } }).row.email).toBe("x'); DROP TABLE customers; --");

    const query = await runLive(single({ type: "postgres.query", credentialId: cred.id, config: { sql: "SELECT email, plan FROM customers WHERE plan = $1", params: ["{{ trigger.plan }}"] } }), { plan: "pro" });
    expect(query.status).toBe("succeeded");
    expect((query.steps.step!.output as { rows: unknown[] }).rows).toEqual([{ email: "x'); DROP TABLE customers; --", plan: "pro" }]);

    const blocked = await runLive(single({ type: "postgres.query", credentialId: cred.id, config: { sql: "DELETE FROM customers", readOnly: true } }));
    expect(blocked.status).toBe("failed");
    expect(JSON.stringify(blocked.steps.step!.error)).toMatch(/read-only/i);
    const multi = await runLive(single({ type: "postgres.query", credentialId: cred.id, config: { sql: "SELECT 1; DROP TABLE customers" } }));
    expect(multi.status).toBe("failed");
    expect((await db.query("SELECT count(*)::int AS n FROM customers")).rows[0]).toEqual({ n: 1 });
    await server.stop();
    await db.close();
  });
});

describe("Provider API contracts (official request shapes)", () => {
  it("Anthropic: official SDK request with structured output, fallbacks, no sampling params; usage recorded", async () => {
    const cred = await createCredential(app.ctx, p, { name: "Anthropic", type: "ai_provider", data: { provider: "anthropic", apiKey: "sk-ant-test-key-000000000000" } });
    const state = await runLive(single({ type: "ai.classify", credentialId: cred.id, config: { text: "We have budget and need it by Friday", categories: ["hot", "warm", "cold"] } }));
    expect(state.status).toBe("succeeded");
    expect(state.steps.step!.output).toMatchObject({ label: "hot", confidence: 0.92, provider: "anthropic", model: "claude-opus-5-5" });
    const call = last("api.anthropic.com");
    expect(call.method).toBe("POST");
    // The SDK (v1.x) sends the API key as a bearer token: exactly the workspace's key,
    // never the server process's ambient ANTHROPIC_AUTH_TOKEN.
    expect(call.headers.authorization).toBe("Bearer sk-ant-test-key-000000000000");
    expect(call.headers["anthropic-version"]).toBeTruthy();
    expect(String(call.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    const body = JSON.parse(call.body);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.properties.label.enum).toEqual(["hot", "warm", "cold"]);
    expect(body.output_config.effort).toBe("medium");
    expect(body.temperature).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    const usage = await app.ctx.db.one<{ input_tokens: number; estimated_cost_usd: number }>("SELECT input_tokens, estimated_cost_usd FROM ai_usage WHERE provider = 'anthropic' ORDER BY id DESC LIMIT 1");
    expect(usage).toMatchObject({ input_tokens: 120 });
    expect(Number(usage!.estimated_cost_usd)).toBeCloseTo((120 * 4 + 30 * 20) / 1e6, 8);
    expect(JSON.stringify(state.steps.step)).not.toContain("sk-ant-test-key");
  });

  it("Google Sheets: reads the header row, appends mapped values as RAW with a bearer token", async () => {
    const cred = await createCredential(app.ctx, p, { name: "Google", type: "google", data: {} });
    await app.ctx.db.query("UPDATE credentials SET encrypted_data = $2 WHERE id = $1", [cred.id, app.ctx.secrets.encryptJson({ access_token: "ya29.test-token", refresh_token: "r", expires_at: Date.now() + 3_600_000 }, `credential:${p.workspaceId}:${cred.id}`)]);
    const state = await runLive(single({ type: "sheets.append_row", credentialId: cred.id, config: { spreadsheetId: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit", sheet: "Sheet1", values: { Email: "{{ trigger.email }}", name: "Ada" } } }), { email: "ada@example.com" });
    expect(state.status).toBe("succeeded");
    const get = calls.find((c) => c.url.startsWith("https://sheets.googleapis.com/v4/spreadsheets/1AbCdEfGhIjKlMnOp/values/") && c.method === "GET")!;
    expect(decodeURIComponent(get.url)).toContain("'Sheet1'!1:1");
    const append = last("sheets.googleapis.com");
    expect(append.method).toBe("POST");
    expect(append.url).toContain(":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS");
    expect(append.headers.authorization).toBe("Bearer ya29.test-token");
    expect(JSON.parse(append.body)).toEqual({ values: [["Ada", "ada@example.com", ""]] });
  });

  it("YouTube: video details with an API key", async () => {
    const cred = await createCredential(app.ctx, p, { name: "YT key", type: "google", data: { apiKey: "AIzaTestKey000000000000000000000000000" } });
    const state = await runLive(single({ type: "youtube.get_video", credentialId: cred.id, config: { videoId: "https://youtu.be/dQw4w9WgXcQ" } }));
    expect(state.status).toBe("succeeded");
    expect(state.steps.step!.output).toMatchObject({ id: "dQw4w9WgXcQ", title: "Demo", viewCount: 10, durationIso: "PT1M" });
    const call = last("www.googleapis.com");
    expect(call.url).toContain("/youtube/v3/videos?part=snippet%2Cstatistics%2CcontentDetails&id=dQw4w9WgXcQ&key=AIzaTestKey");
  });

  it("YouTube: resumable upload sends metadata, then the exact bytes to the session URL", async () => {
    const cred = await createCredential(app.ctx, p, { name: "YT oauth", type: "google", data: {} });
    await app.ctx.db.query("UPDATE credentials SET encrypted_data = $2 WHERE id = $1", [cred.id, app.ctx.secrets.encryptJson({ access_token: "ya29.upload", expires_at: Date.now() + 3_600_000 }, `credential:${p.workspaceId}:${cred.id}`)]);
    const state = await runLive(single({ type: "youtube.upload_video", credentialId: cred.id, config: { sourceUrl: `${provider.url}/files/video.mp4`, title: "Launch video", description: "Our launch", tags: ["launch", "product"], privacyStatus: "unlisted", madeForKids: false } }));
    expect(state.status).toBe("succeeded");
    expect(state.steps.step!.output).toMatchObject({ id: "NEWVIDEO01a", uploadStatus: "uploaded", bytes: 4096 });
    const ups = calls.filter((c) => c.url.includes("/upload/youtube/v3/videos"));
    const init = ups.at(-2)!;
    expect(init.method).toBe("POST");
    expect(init.url).toContain("uploadType=resumable&part=snippet,status&notifySubscribers=false");
    expect(init.headers.authorization).toBe("Bearer ya29.upload");
    expect(init.headers["x-upload-content-length"]).toBe("4096");
    expect(init.headers["x-upload-content-type"]).toBe("video/mp4");
    expect(JSON.parse(init.body)).toEqual({ snippet: { title: "Launch video", description: "Our launch", tags: ["launch", "product"], categoryId: "22" }, status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false } });
    const upload = ups.at(-1)!;
    expect(upload.method).toBe("PUT");
    expect(upload.url).toContain("upload_id=SESSION1");
    expect(upload.headers["content-length"]).toBe("4096");
    expect(upload.body.length).toBe(4096);
  });

  it("WhatsApp: template message to the Graph API, and signed inbound webhooks start workflows", async () => {
    const cred = await createCredential(app.ctx, p, { name: "WA", type: "whatsapp_cloud", data: { accessToken: "EAAtesttoken", phoneNumberId: "1234567890", appSecret: "app-secret-xyz", verifyToken: "verify-me", apiVersion: "v23.0" } });
    const state = await runLive(single({ type: "whatsapp.send_template", credentialId: cred.id, config: { to: "+1 (555) 123-4567", templateName: "order_update", languageCode: "en_US", bodyParameters: ["Ada", "#42"], consentConfirmed: "true" } }));
    expect(state.status).toBe("succeeded");
    expect(state.steps.step!.output).toMatchObject({ messageId: "wamid.TEST", status: "accepted" });
    const call = last("graph.facebook.com");
    expect(call.url).toBe("https://graph.facebook.com/v23.0/1234567890/messages");
    expect(call.headers.authorization).toBe("Bearer EAAtesttoken");
    expect(JSON.parse(call.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15551234567",
      type: "template",
      template: { name: "order_update", language: { code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ada" }, { type: "text", text: "#42" }] }] },
    });
    const noConsent = await runLive(single({ type: "whatsapp.send_text", credentialId: cred.id, config: { to: "15551234567", body: "hi", consentConfirmed: "false" } }));
    expect(noConsent.status).toBe("failed");

    // Inbound webhook: verification handshake and signed event.
    const { buildServer } = await import("../src/api/server.ts");
    const server = await buildServer(app.ctx);
    const wf = await createWorkflow(app.ctx, p, {
      name: "WA inbound",
      definition: {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.whatsapp_message", name: "Incoming", config: {}, credentialId: cred.id },
          { id: "echo", type: "transform.set", name: "Echo", config: { fields: { from: "{{ trigger.from }}", text: "{{ trigger.text }}" } } },
        ],
        edges: [{ id: "e1", source: "trigger", target: "echo" }],
      },
    });
    await publishWorkflow(app.ctx, p, wf.id);
    const verify = await server.inject({ method: "GET", url: `/hooks/whatsapp/${cred.id}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345` });
    expect(verify.body).toBe("12345");
    const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "1234567890" }, contacts: [{ wa_id: "15551234567", profile: { name: "Ada" } }], messages: [{ id: "wamid.IN1", from: "15551234567", timestamp: "1767225600", type: "text", text: { body: "Price?" } }] } }] }] });
    const unsigned = await server.inject({ method: "POST", url: `/hooks/whatsapp/${cred.id}`, headers: { "content-type": "application/json" }, payload });
    expect(unsigned.statusCode).toBe(401);
    const sig = createHmac("sha256", "app-secret-xyz").update(payload).digest("hex");
    const signed = await server.inject({ method: "POST", url: `/hooks/whatsapp/${cred.id}`, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${sig}` }, payload });
    expect(signed.json()).toEqual({ received: true, executions: 1 });
    await drain(app);
    const exec = await app.ctx.db.one<{ id: string }>("SELECT id FROM executions WHERE workflow_id = $1", [wf.id]);
    expect((await executionState(app, exec!.id)).steps.echo!.output).toEqual({ from: "15551234567", text: "Price?" });
    await server.close();
  });

  it("HubSpot: searches by email then creates the contact", async () => {
    const cred = await createCredential(app.ctx, p, { name: "HubSpot", type: "hubspot", data: { accessToken: "pat-na1-test" } });
    const state = await runLive(single({ type: "hubspot.upsert_contact", credentialId: cred.id, config: { email: "Ada@Example.com", properties: { firstname: "Ada", company: "" } } }));
    expect(state.status).toBe("succeeded");
    expect(state.steps.step!.output).toMatchObject({ id: "901", created: true });
    const hs = calls.filter((c) => c.url.includes("api.hubapi.com")).slice(-2);
    expect(hs[0]!.url).toBe("https://api.hubapi.com/crm/v3/objects/contacts/search");
    expect(JSON.parse(hs[0]!.body).filterGroups[0].filters[0]).toEqual({ propertyName: "email", operator: "EQ", value: "ada@example.com" });
    expect(hs[1]!.url).toBe("https://api.hubapi.com/crm/v3/objects/contacts");
    expect(JSON.parse(hs[1]!.body)).toEqual({ properties: { firstname: "Ada", email: "ada@example.com" } });
    expect(hs[1]!.headers.authorization).toBe("Bearer pat-na1-test");
  });

  it("Slack: posts to the incoming webhook and rejects non-Slack URLs", async () => {
    const good = await createCredential(app.ctx, p, { name: "Slack", type: "slack_webhook", data: { url: "https://hooks.slack.com/services/T000/B000/XXXX" } });
    const state = await runLive(single({ type: "slack.send_webhook_message", credentialId: good.id, config: { text: "Deploy done: {{ trigger.v }}" } }), { v: "1.2" });
    expect(state.status).toBe("succeeded");
    const call = last("hooks.slack.com");
    expect(call.url).toBe("https://hooks.slack.com/services/T000/B000/XXXX");
    expect(JSON.parse(call.body)).toEqual({ text: "Deploy done: 1.2" });
    const evil = await createCredential(app.ctx, p, { name: "Evil", type: "slack_webhook", data: { url: "https://attacker.example/collect" } });
    expect((await runLive(single({ type: "slack.send_webhook_message", credentialId: evil.id, config: { text: "x" } }))).status).toBe("failed");
  });
});
