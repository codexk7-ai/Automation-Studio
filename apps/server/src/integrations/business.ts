import { lookup } from "node:dns/promises";
import { toText } from "@automation-studio/core";
import pg from "pg";
import type { AppContext } from "../context.ts";
import { StepError } from "../errors.ts";
import { isPublicAddress } from "../security/ssrf.ts";
import { apiCall } from "./http.ts";
import type { IntegrationModule, LoadedCredential, NodeImplementation, StepContext } from "./types.ts";

// ---------------------------------------------------------------------------
// HubSpot CRM (private app access token)

const HUBSPOT = "https://api.hubapi.com";

function hubspotHeaders(ctx: StepContext): Record<string, string> {
  const token = toText(ctx.credential?.data.accessToken);
  if (!token) throw new StepError("config", "The HubSpot connection has no access token.");
  return { authorization: `Bearer ${token}` };
}

async function findContact(ctx: StepContext, email: string) {
  const res = await apiCall<{ results?: Array<{ id: string; properties: Record<string, unknown> }> }>(ctx.app, {
    method: "POST",
    url: `${HUBSPOT}/crm/v3/objects/contacts/search`,
    headers: hubspotHeaders(ctx),
    json: { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], properties: ["email", "firstname", "lastname", "company", "phone", "lifecyclestage", "hs_lead_status"], limit: 1 },
    signal: ctx.signal,
    provider: "HubSpot",
  });
  return res.data.results?.[0] ?? null;
}

const upsertContact: NodeImplementation = {
  type: "hubspot.upsert_contact",
  integration: "hubspot",
  kind: "action",
  name: "HubSpot: create or update contact",
  description: "Find a contact by email and update it, or create it.",
  credentialType: "hubspot",
  credentialRequired: true,
  sideEffects: "external",
  fields: [
    { key: "email", label: "Email", type: "string", required: true },
    { key: "properties", label: "Properties", type: "keyvalue", default: { firstname: "", lastname: "", company: "" }, description: "HubSpot internal property names." },
  ],
  sampleOutput: { id: "12345", created: true, properties: {} },
  mode: "live",
  async execute(ctx) {
    const email = toText(ctx.config.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StepError("config", "A valid email is required.");
    const properties = Object.fromEntries(Object.entries((ctx.config.properties as Record<string, unknown>) ?? {}).filter(([, v]) => v !== "" && v !== null && v !== undefined).map(([k, v]) => [k, toText(v)]));
    const existing = await findContact(ctx, email);
    if (existing) {
      const res = await apiCall<{ id: string; properties: Record<string, unknown> }>(ctx.app, { method: "PATCH", url: `${HUBSPOT}/crm/v3/objects/contacts/${existing.id}`, headers: hubspotHeaders(ctx), json: { properties }, signal: ctx.signal, provider: "HubSpot" });
      return { output: { id: res.data.id, created: false, properties: res.data.properties } };
    }
    const res = await apiCall<{ id: string; properties: Record<string, unknown> }>(ctx.app, { method: "POST", url: `${HUBSPOT}/crm/v3/objects/contacts`, headers: hubspotHeaders(ctx), json: { properties: { ...properties, email } }, signal: ctx.signal, provider: "HubSpot" });
    return { output: { id: res.data.id, created: true, properties: res.data.properties } };
  },
  async mock(ctx) {
    return { output: { id: "mock-contact", created: true, properties: { email: toText(ctx.config.email), ...((ctx.config.properties as object) ?? {}) }, _mock: true } };
  },
};

const getContact: NodeImplementation = {
  type: "hubspot.find_contact",
  integration: "hubspot",
  kind: "action",
  name: "HubSpot: find contact by email",
  description: "Look up a contact by email.",
  credentialType: "hubspot",
  credentialRequired: true,
  fields: [{ key: "email", label: "Email", type: "string", required: true }],
  sampleOutput: { found: true, id: "12345", properties: { email: "ada@example.com" } },
  mode: "live",
  testable: true,
  async execute(ctx) {
    const c = await findContact(ctx, toText(ctx.config.email).trim().toLowerCase());
    return { output: { found: !!c, id: c?.id ?? null, properties: c?.properties ?? null } };
  },
  async mock() {
    return { output: { found: false, id: null, properties: null, _mock: true } };
  },
};

// ---------------------------------------------------------------------------
// Slack incoming webhook

const slackMessage: NodeImplementation = {
  type: "slack.send_webhook_message",
  integration: "slack",
  kind: "action",
  name: "Slack: post message (incoming webhook)",
  description: "Post a message to the channel bound to a Slack incoming webhook (internal notifications, failure alerts).",
  credentialType: "slack_webhook",
  credentialRequired: true,
  sideEffects: "external",
  fields: [{ key: "text", label: "Message (Slack mrkdwn)", type: "text", required: true }],
  sampleOutput: { ok: true },
  mode: "live",
  async execute(ctx) {
    const url = toText(ctx.credential?.data.url);
    if (!/^https:\/\/hooks\.slack\.com\/services\//.test(url)) throw new StepError("config", "The Slack connection must contain an https://hooks.slack.com/services/… webhook URL.");
    await apiCall(ctx.app, { method: "POST", url, json: { text: toText(ctx.config.text).slice(0, 39_000) }, signal: ctx.signal, provider: "Slack" });
    return { output: { ok: true } };
  },
  async mock(ctx) {
    return { output: { ok: true, text: toText(ctx.config.text), _mock: true } };
  },
};

// ---------------------------------------------------------------------------
// External PostgreSQL

async function assertDbHost(app: AppContext, host: string, port: number): Promise<void> {
  if (app.config.outboundAllowlist.includes(`${host.toLowerCase()}:${port}`) || app.policy.allowPrivate) return;
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) {
    throw new StepError("policy", `Database host ${host} is private or unresolvable. An administrator must add ${host}:${port} to OUTBOUND_ALLOWLIST.`);
  }
}

async function withPg<T>(app: AppContext, cred: LoadedCredential | undefined, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  if (!cred) throw new StepError("config", "Select a PostgreSQL connection.");
  const d = cred.data;
  const host = toText(d.host);
  const port = Number(d.port) || 5432;
  await assertDbHost(app, host, port);
  const client = new pg.Client({
    host,
    port,
    database: toText(d.database),
    user: toText(d.user),
    password: toText(d.password),
    ssl: d.ssl === true ? { rejectUnauthorized: d.sslVerify !== false } : undefined,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    query_timeout: 35_000,
  });
  await client.connect().catch((err: Error) => {
    throw new StepError("transient", `Could not connect to PostgreSQL: ${err.message}`);
  });
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const quoteIdent = (s: string) => {
  if (!IDENT.test(s)) throw new StepError("config", `Invalid identifier '${s}'.`);
  return `"${s}"`;
};

const pgQuery: NodeImplementation = {
  type: "postgres.query",
  integration: "postgres",
  kind: "action",
  name: "PostgreSQL: run parameterized query",
  description: "Run one SQL statement written by a workspace admin. Values must be passed as $1, $2… parameters — never interpolated. Read-only by default.",
  credentialType: "postgres",
  credentialRequired: true,
  sideEffects: "external",
  minRole: "admin",
  fields: [
    { key: "sql", label: "SQL (single statement)", type: "text", required: true, allowExpressions: false, placeholder: "SELECT * FROM customers WHERE email = $1" },
    { key: "params", label: "Parameters ($1, $2…)", type: "string_list", description: "Expressions allowed here." },
    { key: "readOnly", label: "Read-only transaction", type: "boolean", default: true },
    { key: "maxRows", label: "Maximum rows returned", type: "number", default: 1000, min: 1, max: 10000 },
  ],
  sampleOutput: { rowCount: 1, rows: [{ id: 1 }] },
  mode: "live",
  testable: true,
  async execute(ctx) {
    const sql = toText(ctx.rawConfig.sql).trim().replace(/;\s*$/, "");
    if (!sql || sql.includes(";")) throw new StepError("config", "Provide exactly one SQL statement (no semicolons).");
    const params = (Array.isArray(ctx.config.params) ? ctx.config.params : []).map((p) => (p !== null && typeof p === "object" ? JSON.stringify(p) : p));
    return {
      output: await withPg(ctx.app, ctx.credential, async (c) => {
        await c.query(ctx.config.readOnly === false ? "BEGIN" : "BEGIN READ ONLY");
        try {
          const res = await c.query(sql, params);
          await c.query("COMMIT");
          return { rowCount: res.rowCount ?? 0, rows: res.rows.slice(0, Number(ctx.config.maxRows) || 1000), truncated: res.rows.length > (Number(ctx.config.maxRows) || 1000) };
        } catch (err) {
          await c.query("ROLLBACK").catch(() => undefined);
          throw new StepError("permanent", `PostgreSQL: ${(err as Error).message}`);
        }
      }),
    };
  },
  async mock() {
    return { output: { rowCount: 0, rows: [], _mock: true } };
  },
};

const pgInsert: NodeImplementation = {
  type: "postgres.insert_row",
  integration: "postgres",
  kind: "action",
  name: "PostgreSQL: insert row",
  description: "Insert one row into a table using generated, parameterized SQL.",
  credentialType: "postgres",
  credentialRequired: true,
  sideEffects: "external",
  minRole: "editor",
  fields: [
    { key: "schema", label: "Schema", type: "string", default: "public", allowExpressions: false },
    { key: "table", label: "Table", type: "string", required: true, allowExpressions: false },
    { key: "data", label: "Column values", type: "keyvalue", required: true },
  ],
  sampleOutput: { inserted: 1, row: { id: 1 } },
  mode: "live",
  async execute(ctx) {
    const data = (ctx.config.data as Record<string, unknown>) ?? {};
    const cols = Object.keys(data);
    if (!cols.length) throw new StepError("config", "Provide at least one column value.");
    const sql = `INSERT INTO ${quoteIdent(toText(ctx.config.schema) || "public")}.${quoteIdent(toText(ctx.config.table))} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`;
    const values = cols.map((c) => (data[c] !== null && typeof data[c] === "object" ? JSON.stringify(data[c]) : data[c]));
    return {
      output: await withPg(ctx.app, ctx.credential, async (c) => {
        try {
          const res = await c.query(sql, values);
          return { inserted: res.rowCount ?? 0, row: res.rows[0] ?? null };
        } catch (err) {
          throw new StepError("permanent", `PostgreSQL: ${(err as Error).message}`);
        }
      }),
    };
  },
  async mock(ctx) {
    return { output: { inserted: 1, row: ctx.config.data, _mock: true } };
  },
};

export const hubspotIntegration: IntegrationModule = {
  definition: {
    id: "hubspot",
    name: "HubSpot CRM",
    description: "Create, update and look up CRM contacts.",
    category: "CRM",
    version: "1.0.0",
    icon: "users",
    credentialTypes: ["hubspot"],
    docsUrl: "https://developers.hubspot.com/docs/api/private-apps",
    prerequisites: ["A HubSpot account and a private app token with crm.objects.contacts.read/write scopes. API limits depend on your HubSpot plan."],
    availability: "live+mock",
    scopes: ["crm.objects.contacts.read", "crm.objects.contacts.write"],
    rateLimits: "Per HubSpot plan (e.g. 100-190 requests per 10 seconds per app).",
  },
  nodes: [upsertContact, getContact],
  credentialTypes: [
    {
      id: "hubspot",
      name: "HubSpot private app",
      description: "Private app access token.",
      fields: [{ key: "accessToken", label: "Access token", type: "string", required: true, sensitive: true }],
      async test(data, app) {
        await apiCall(app, { url: `${HUBSPOT}/crm/v3/objects/contacts`, query: { limit: 1 }, headers: { authorization: `Bearer ${toText(data.accessToken)}` }, provider: "HubSpot" });
        return { ok: true, message: "HubSpot token accepted." };
      },
    },
  ],
};

export const slackIntegration: IntegrationModule = {
  definition: {
    id: "slack",
    name: "Slack",
    description: "Post notifications to Slack channels through incoming webhooks.",
    category: "Communication",
    version: "1.0.0",
    icon: "hash",
    credentialTypes: ["slack_webhook"],
    docsUrl: "https://api.slack.com/messaging/webhooks",
    prerequisites: ["A Slack app with an incoming webhook installed in your workspace (free)."],
    availability: "live+mock",
    rateLimits: "About 1 message per second per webhook.",
  },
  nodes: [slackMessage],
  credentialTypes: [
    {
      id: "slack_webhook",
      name: "Slack incoming webhook",
      description: "Webhook URL bound to one channel.",
      fields: [{ key: "url", label: "Webhook URL", type: "string", required: true, sensitive: true, placeholder: "https://hooks.slack.com/services/…" }],
    },
  ],
};

export const postgresIntegration: IntegrationModule = {
  definition: {
    id: "postgres",
    name: "PostgreSQL",
    description: "Query and insert into your own PostgreSQL databases with parameterized SQL.",
    category: "Developer",
    version: "1.0.0",
    icon: "database",
    credentialTypes: ["postgres"],
    prerequisites: ["Network access to the database. Private hosts must be allowlisted by an administrator (OUTBOUND_ALLOWLIST). Use a least-privilege database user."],
    availability: "live+mock",
  },
  nodes: [pgQuery, pgInsert],
  credentialTypes: [
    {
      id: "postgres",
      name: "PostgreSQL connection",
      description: "Connection details for an external PostgreSQL database.",
      fields: [
        { key: "host", label: "Host", type: "string", required: true },
        { key: "port", label: "Port", type: "number", default: 5432 },
        { key: "database", label: "Database", type: "string", required: true },
        { key: "user", label: "User", type: "string", required: true },
        { key: "password", label: "Password", type: "string", sensitive: true },
        { key: "ssl", label: "Use SSL", type: "boolean", default: true },
        { key: "sslVerify", label: "Verify SSL certificate", type: "boolean", default: true },
      ],
      describe: (d) => ({ account: `${toText(d.user)}@${toText(d.host)}/${toText(d.database)}` }),
      async test(data, app) {
        await withPg(app, { id: "test", name: "test", type: "postgres", data }, async (c) => c.query("SELECT 1"));
        return { ok: true, message: "Connected." };
      },
    },
  ],
};
