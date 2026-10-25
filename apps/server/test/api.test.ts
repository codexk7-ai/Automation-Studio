import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildServer } from "../src/api/server.ts";
import type { App } from "../src/app.ts";
import { drain, testApp } from "./helpers.ts";

let app: App;
let server: FastifyInstance;
let base: string;

/** Minimal cookie-jar HTTP client for the API. */
class Session {
  cookie = "";
  csrf = "";
  async req(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && method !== "GET") headers["x-csrf-token"] = this.csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }
  async register(email: string) {
    const r = await this.req("POST", "/api/auth/register", { email, name: email.split("@")[0], password: "correct horse battery staple" });
    this.csrf = r.json.csrfToken;
    return r;
  }
}

let ext: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  // An external MCP server (test double) on localhost.
  const extServer = Fastify();
  const handler = createMcpHandler(() => {
    const s = new McpServer({ name: "external-test", version: "1.0.0" });
    s.registerTool("add", { description: "Add two numbers", inputSchema: z.object({ a: z.number(), b: z.number() }) }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
    s.registerTool("delete_everything", { description: "Dangerous tool", inputSchema: z.object({}) }, async () => ({ content: [{ type: "text", text: "boom" }] }));
    return s;
  });
  extServer.removeContentTypeParser("application/json");
  extServer.addContentTypeParser("application/json", { parseAs: "string" }, (_r, b, done) => done(null, b));
  extServer.all("/mcp", async (req, reply) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, String(v));
    const res = await handler.fetch(new Request(`http://127.0.0.1/mcp`, { method: req.method, headers, body: req.method === "POST" ? (req.body as string) : undefined }));
    reply.status(res.status);
    res.headers.forEach((v, k) => reply.header(k, v));
    return reply.send(await res.text());
  });
  await extServer.listen({ port: 0, host: "127.0.0.1" });
  const extPort = (extServer.server.address() as AddressInfo).port;
  ext = { url: `http://127.0.0.1:${extPort}/mcp`, close: () => extServer.close() };

  app = await testApp([`127.0.0.1:${extPort}`]);
  server = await buildServer(app.ctx);
  await server.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  app.ctx.config.publicUrl = base;
});

afterAll(async () => {
  await server.close();
  await app.close();
  await ext.close();
});

describe("auth, CSRF and tenancy", () => {
  it("registers, enforces CSRF and rejects anonymous access", async () => {
    expect((await new Session().req("GET", "/api/workflows")).status).toBe(401);
    const s = new Session();
    const reg = await s.register(`owner-${Date.now()}@example.com`);
    expect(reg.status).toBe(200);
    const me = await s.req("GET", "/api/auth/me");
    expect(me.json.role).toBe("owner");
    const noCsrf = await fetch(`${base}/api/workflows`, { method: "POST", headers: { cookie: s.cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect(noCsrf.status).toBe(403);
    expect((await s.req("POST", "/api/workflows", { name: "ok" })).status).toBe(200);
  });

  it("isolates workspaces: no cross-tenant reads of workflows or credentials", async () => {
    const a = new Session();
    await a.register(`a-${Date.now()}@example.com`);
    const b = new Session();
    await b.register(`b-${Date.now()}@example.com`);
    const wf = (await a.req("POST", "/api/workflows", { name: "A's workflow" })).json;
    const cred = (await a.req("POST", "/api/credentials", { name: "A key", type: "http_auth", data: { authType: "bearer", token: "super-secret-token-123" } })).json;
    expect((await b.req("GET", `/api/workflows/${wf.id}`)).status).toBe(404);
    expect((await b.req("GET", "/api/credentials")).json).toEqual([]);
    // B cannot reference A's credential in its workflow.
    const bw = (await b.req("POST", "/api/workflows", { name: "B" })).json;
    const def = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.manual", name: "T", config: {} },
        { id: "h", type: "http.request", name: "H", config: { url: "https://example.com" }, credentialId: cred.id },
      ],
      edges: [{ id: "e", source: "trigger", target: "h" }],
    };
    const saved = await b.req("PUT", `/api/workflows/${bw.id}`, { definition: def });
    expect(saved.json.validation.errors.map((e: { code: string }) => e.code)).toContain("invalid_credential");
  });

  it("never returns credential secrets", async () => {
    const s = new Session();
    await s.register(`c-${Date.now()}@example.com`);
    const created = await s.req("POST", "/api/credentials", { name: "Secret", type: "http_auth", data: { authType: "bearer", token: "tok_live_abcdefghijklmnop" } });
    expect(JSON.stringify(created.json)).not.toContain("tok_live_abcdefghijklmnop");
    const list = await s.req("GET", "/api/credentials");
    expect(JSON.stringify(list.json)).not.toContain("tok_live_abcdefghijklmnop");
    const row = await app.ctx.db.one<{ encrypted_data: string }>("SELECT encrypted_data FROM credentials WHERE id = $1", [created.json.id]);
    expect(row!.encrypted_data).not.toContain("tok_live");
  });

  it("enforces roles: viewers cannot create workflows", async () => {
    const owner = new Session();
    await owner.register(`own-${Date.now()}@example.com`);
    const email = `viewer-${Date.now()}@example.com`;
    const added = await owner.req("POST", "/api/members", { email, role: "viewer" });
    expect(added.json.temporaryPassword).toBeTruthy();
    const viewer = new Session();
    const login = await viewer.req("POST", "/api/auth/login", { email, password: added.json.temporaryPassword });
    viewer.csrf = login.json.csrfToken;
    // Switch to the owner's workspace.
    const me = await owner.req("GET", "/api/auth/me");
    await viewer.req("POST", "/api/auth/switch-workspace", { workspaceId: me.json.workspace.id });
    expect((await viewer.req("GET", "/api/workflows")).status).toBe(200);
    expect((await viewer.req("POST", "/api/workflows", { name: "nope" })).status).toBe(403);
  });
});

describe("end-to-end workflow", () => {
  it("creates, saves, validates, publishes and runs from a signed webhook", async () => {
    const s = new Session();
    await s.register(`e2e-${Date.now()}@example.com`);
    const wf = (await s.req("POST", "/api/workflows", { name: "Webhook E2E" })).json;
    const secret = (await s.req("POST", "/api/credentials", { name: "Hook secret", type: "webhook_secret", data: { secret: "s3cr3t-value-for-hmac" } })).json;
    const def = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.webhook", name: "Hook", config: { method: "POST", verification: "hmac_sha256", signatureHeader: "x-signature", dedupeKey: "{{ trigger.body.id }}" }, credentialId: secret.id },
        { id: "shape", type: "transform.set", name: "Shape", config: { fields: { greeting: "Hello {{ trigger.body.name }}" } } },
        { id: "check", type: "logic.condition", name: "VIP?", config: { rules: [{ left: "{{ trigger.body.vip }}", operator: "is_true" }] } },
        { id: "vip", type: "transform.set", name: "VIP", config: { fields: { tier: "vip" } } },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "shape" },
        { id: "e2", source: "shape", target: "check" },
        { id: "e3", source: "check", target: "vip", branch: "true" },
      ],
    };
    const saved = await s.req("PUT", `/api/workflows/${wf.id}`, { definition: def });
    expect(saved.json.validation.valid).toBe(true);
    const loaded = await s.req("GET", `/api/workflows/${wf.id}`);
    expect(loaded.json.draft_definition.nodes).toHaveLength(4);
    const pub = await s.req("POST", `/api/workflows/${wf.id}/publish`, { note: "v1" });
    expect(pub.json.version).toBe(1);
    const hookUrl = (await s.req("GET", `/api/workflows/${wf.id}`)).json.webhookUrl as string;
    expect(hookUrl).toMatch(/\/hooks\/w\//);

    const payload = JSON.stringify({ id: "evt_1", name: "Ada", vip: true });
    const bad = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", "x-signature": "sha256=deadbeef" }, body: payload });
    expect(bad.status).toBe(401);
    const sig = createHmac("sha256", "s3cr3t-value-for-hmac").update(payload).digest("hex");
    const good = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", "x-signature": `sha256=${sig}` }, body: payload });
    expect(good.status).toBe(202);
    const { executionId } = (await good.json()) as { executionId: string };
    const dup = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", "x-signature": `sha256=${sig}` }, body: payload });
    expect(((await dup.json()) as { duplicate: boolean }).duplicate).toBe(true);

    await drain(app);
    const exec = await s.req("GET", `/api/executions/${executionId}`);
    expect(exec.json.status).toBe("succeeded");
    const steps = Object.fromEntries(exec.json.steps.map((st: { node_id: string }) => [st.node_id, st]));
    expect(steps.shape.output).toEqual({ greeting: "Hello Ada" });
    expect(steps.vip.status).toBe("succeeded");
    expect(JSON.stringify(exec.json.trigger_data)).not.toContain("x-signature");

    // Pause blocks the webhook; resume re-enables it.
    await s.req("POST", `/api/workflows/${wf.id}/pause`);
    const paused = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", "x-signature": `sha256=${sig}` }, body: payload });
    expect(paused.status).toBe(409);
    await s.req("POST", `/api/workflows/${wf.id}/resume`);
    expect((await s.req("GET", `/api/workflows/${wf.id}`)).json.status).toBe("active");

    // Versions and export/import round trip.
    expect((await s.req("GET", `/api/workflows/${wf.id}/versions`)).json).toHaveLength(1);
    const exported = await s.req("GET", `/api/workflows/${wf.id}/export`);
    expect(exported.json.format).toBe("automation-studio.workflow");
    expect(exported.json.definition.nodes[0].credentialId).toBeNull();
    const imported = await s.req("POST", "/api/workflows/import", exported.json);
    expect(imported.status).toBe(200);
  });

  it("rejects publishing invalid workflows", async () => {
    const s = new Session();
    await s.register(`inv-${Date.now()}@example.com`);
    const wf = (await s.req("POST", "/api/workflows", { name: "Invalid" })).json;
    await s.req("PUT", `/api/workflows/${wf.id}`, {
      definition: { schemaVersion: 1, nodes: [{ id: "trigger", type: "trigger.manual", name: "T", config: {} }, { id: "h", type: "http.request", name: "H", config: {} }], edges: [{ id: "e", source: "trigger", target: "h" }] },
    });
    const pub = await s.req("POST", `/api/workflows/${wf.id}/publish`);
    expect(pub.status).toBe(422);
    expect(pub.json.error.details.errors[0].code).toBe("required_field");
  });

  it("instantiates the lead template; a form submission triggers AI scoring (mock adapter) and an approval", async () => {
    const s = new Session();
    await s.register(`tpl-${Date.now()}@example.com`);
    const inst = await s.req("POST", "/api/templates/lead-intake-qualification/instantiate", {});
    expect(inst.status).toBe(200);
    const wfId = inst.json.workflow.id;
    const pub = await s.req("POST", `/api/workflows/${wfId}/publish`);
    expect(pub.status).toBe(200);
    const slug = inst.json.created.forms[0].slug;
    const submit = await fetch(`${base}/api/public/forms/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Grace Hopper", email: "grace@example.com", company: "Navy", message: "We have budget and need a demo next week" }) });
    expect(submit.status).toBe(200);
    await drain(app);
    const list = await s.req("GET", `/api/executions?workflowId=${wfId}`);
    expect(list.json.items).toHaveLength(1);
    const exec = await s.req("GET", `/api/executions/${list.json.items[0].id}`);
    expect(exec.json.status).toBe("waiting");
    const steps = Object.fromEntries(exec.json.steps.map((st: { node_id: string }) => [st.node_id, st]));
    expect(steps.qualify.output._mock).toBe(true);
    expect(["hot", "warm", "cold"]).toContain(steps.qualify.output.label);
    const approvals = await s.req("GET", "/api/approvals");
    expect(approvals.json).toHaveLength(1);
    await s.req("POST", `/api/approvals/${approvals.json[0].id}/decision`, { decision: "approved" });
    await drain(app);
    const done = await s.req("GET", `/api/executions/${list.json.items[0].id}`);
    expect(done.json.status).toBe("succeeded");
    const outbox = await s.req("GET", "/api/outbox");
    expect(outbox.json[0].status).toBe("captured");
    expect(outbox.json[0].to_addresses).toBe("grace@example.com");
  });
});

describe("MCP", () => {
  it("exposes permissioned platform tools to API-token clients", async () => {
    const s = new Session();
    await s.register(`mcp-${Date.now()}@example.com`);
    const readTok = (await s.req("POST", "/api/api-tokens", { name: "read", scopes: ["read"] })).json.token as string;
    const fullTok = (await s.req("POST", "/api/api-tokens", { name: "full", scopes: ["read", "write", "execute"] })).json.token as string;

    const connect = async (token: string) => {
      const client = new Client({ name: "test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      return client;
    };
    const reader = await connect(readTok);
    const tools = await reader.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("create_workflow_draft");
    const denied = await reader.callTool({ name: "create_workflow_draft", arguments: { name: "Nope" } });
    expect(denied.isError).toBe(true);
    const search = await reader.callTool({ name: "search_integrations", arguments: { query: "whatsapp" } });
    expect(JSON.stringify(search.content)).toContain("whatsapp.send_template");
    await reader.close();

    const writer = await connect(fullTok);
    const created = await writer.callTool({ name: "create_workflow_draft", arguments: { name: "From MCP" } });
    expect(created.isError).toBeFalsy();
    const workflowId = (created.structuredContent as { workflowId: string }).workflowId;
    const test = await writer.callTool({ name: "test_workflow", arguments: { workflowId, payload: { hello: "world" } } });
    expect(test.isError).toBeFalsy();
    await drain(app);
    const status = await writer.callTool({ name: "get_execution_status", arguments: { executionId: (test.structuredContent as { executionId: string }).executionId } });
    expect((status.structuredContent as { status: string }).status).toBe("succeeded");
    await writer.close();

    const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(anon.status).toBe(401);
    const calls = await app.ctx.db.query("SELECT tool, status FROM mcp_tool_calls WHERE direction = 'inbound'");
    expect(calls.length).toBeGreaterThan(3);
  });

  it("registers an external MCP server; tools stay disabled until an admin enables them", async () => {
    const s = new Session();
    await s.register(`ext-${Date.now()}@example.com`);
    const reg = await s.req("POST", "/api/mcp-servers", { name: "Calc", url: ext.url });
    expect(reg.status).toBe(200);
    const refreshed = await s.req("POST", `/api/mcp-servers/${reg.json.id}/refresh`);
    expect(refreshed.json.status).toBe("connected");
    expect(refreshed.json.tools.map((t: { name: string }) => t.name).sort()).toEqual(["add", "delete_everything"]);
    expect(refreshed.json.tool_policies.add.enabled).toBe(false);

    const blocked = await s.req("POST", `/api/mcp-servers/${reg.json.id}/tools/add/test`, { arguments: { a: 1, b: 2 } });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.message).toMatch(/not been enabled/);
    await s.req("PATCH", `/api/mcp-servers/${reg.json.id}`, { toolPolicies: { add: { enabled: true, allowForAi: false } } });
    const badArgs = await s.req("POST", `/api/mcp-servers/${reg.json.id}/tools/add/test`, { arguments: { a: "x" } });
    expect(badArgs.status).not.toBe(200);
    const ok = await s.req("POST", `/api/mcp-servers/${reg.json.id}/tools/add/test`, { arguments: { a: 2, b: 3 } });
    expect(ok.json.text).toBe("5");

    // Used from a workflow step.
    const wf = (await s.req("POST", "/api/workflows", { name: "MCP flow" })).json;
    await s.req("PUT", `/api/workflows/${wf.id}`, {
      definition: {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "T", config: {} },
          { id: "calc", type: "mcp.call_tool", name: "Calc", config: { serverId: reg.json.id, tool: "add", arguments: { a: "{{ trigger.a }}", b: 10 } } },
        ],
        edges: [{ id: "e", source: "trigger", target: "calc" }],
      },
    });
    await s.req("POST", `/api/workflows/${wf.id}/publish`);
    const run = await s.req("POST", `/api/workflows/${wf.id}/run`, { mode: "manual", payload: { a: 5 } });
    await drain(app);
    const exec = await s.req("GET", `/api/executions/${run.json.executionId}`);
    expect(exec.json.status).toBe("succeeded");
    expect(exec.json.steps.find((st: { node_id: string }) => st.node_id === "calc").output.json).toBe(15);
  });
});

describe("tables and forms", () => {
  it("validates rows, filters, imports and exports CSV safely", async () => {
    const s = new Session();
    await s.register(`tbl-${Date.now()}@example.com`);
    const t = (await s.req("POST", "/api/tables", { name: "Contacts", columns: [{ name: "Name", type: "text", required: true }, { name: "Email", type: "email", unique: true }, { name: "Score", type: "number" }] })).json;
    expect((await s.req("POST", `/api/tables/${t.id}/rows`, { data: { name: "Ada", email: "not-an-email" } })).status).toBe(400);
    await s.req("POST", `/api/tables/${t.id}/rows`, { data: { name: "Ada", email: "ada@example.com", score: 9 } });
    expect((await s.req("POST", `/api/tables/${t.id}/rows`, { data: { name: "Dup", email: "ADA@example.com" } })).status).toBe(400);
    const imp = await s.req("POST", `/api/tables/${t.id}/import`, { csv: "Name,Email,Score\nAlan,alan@example.com,3\n=HYPERLINK(\"x\"),evil@example.com,1\n,missing@example.com,2" });
    expect(imp.json.imported).toBe(2);
    expect(imp.json.errors).toHaveLength(1);
    const filtered = await s.req("GET", `/api/tables/${t.id}/rows?filters=${encodeURIComponent(JSON.stringify([{ column: "score", op: "gt", value: 2 }]))}&sort=score&direction=asc`);
    expect(filtered.json.rows.map((r: { data: { name: string } }) => r.data.name)).toEqual(["Alan", "Ada"]);
    const csv = await fetch(`${base}/api/tables/${t.id}/export`, { headers: { cookie: s.cookie } });
    const text = await csv.text();
    expect(text).toContain("'=HYPERLINK");
  });
});
