import { evaluateRules, toText, truthy, type ConditionRule } from "@automation-studio/core";
import { StepError } from "../errors.ts";
import { randomId } from "../security/crypto.ts";
import { safeRequest } from "../security/ssrf.ts";
import { authHeadersFor } from "./http.ts";
import type { IntegrationModule, NodeImplementation, StepContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers

function asArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }
  throw new StepError("config", `${label} must evaluate to a list (got ${typeof value}).`);
}

function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split(".").filter(Boolean)) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    if (!Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const passthroughTrigger = async (ctx: StepContext) => ({ output: ctx.scope.trigger });

const SAMPLE_FIELD = { key: "samplePayload", label: "Sample data for tests", type: "json" as const, description: "Used as trigger data when you test the workflow from the editor.", allowExpressions: false };

// ---------------------------------------------------------------------------
// Triggers

const manualTrigger: NodeImplementation = {
  type: "trigger.manual",
  integration: "core",
  kind: "trigger",
  name: "Manual trigger",
  description: "Start the workflow from the editor, the API, or an MCP client.",
  fields: [SAMPLE_FIELD],
  sampleOutput: { example: "value" },
  mode: "local",
  execute: passthroughTrigger,
};

const webhookTrigger: NodeImplementation = {
  type: "trigger.webhook",
  integration: "core",
  kind: "trigger",
  name: "Webhook",
  description: "Start the workflow when an HTTP request is sent to this workflow's unique URL.",
  credentialType: "webhook_secret",
  credentialRequired: false,
  fields: [
    {
      key: "method",
      label: "HTTP method",
      type: "select",
      default: "POST",
      options: [
        { value: "POST", label: "POST" },
        { value: "GET", label: "GET" },
        { value: "ANY", label: "Any method" },
      ],
    },
    {
      key: "responseMode",
      label: "Response",
      type: "select",
      default: "immediate",
      options: [
        { value: "immediate", label: "Respond immediately (202 Accepted)" },
        { value: "respond_node", label: "Wait for a 'Respond to webhook' step" },
      ],
    },
    { key: "responseTimeoutMs", label: "Response timeout (ms)", type: "number", default: 10000, min: 1000, max: 30000, showWhen: { key: "responseMode", equals: ["respond_node"] } },
    {
      key: "verification",
      label: "Request verification",
      type: "select",
      default: "none",
      description: "Verify callers with a shared secret connection.",
      options: [
        { value: "none", label: "None" },
        { value: "shared_secret", label: "Shared secret header" },
        { value: "hmac_sha256", label: "HMAC-SHA256 signature of the body" },
      ],
    },
    { key: "signatureHeader", label: "Secret / signature header", type: "string", default: "x-webhook-signature", showWhen: { key: "verification", equals: ["shared_secret", "hmac_sha256"] } },
    { key: "dedupeKey", label: "Deduplication key", type: "string", placeholder: "{{ trigger.body.id }}", description: "Requests with the same key start only one execution (within the workflow's dedupe window)." },
    SAMPLE_FIELD,
  ],
  sampleOutput: { method: "POST", query: {}, headers: { "content-type": "application/json" }, body: { name: "Ada Lovelace", email: "ada@example.com" } },
  mode: "local",
  execute: passthroughTrigger,
};

const scheduleTrigger: NodeImplementation = {
  type: "trigger.schedule",
  integration: "core",
  kind: "trigger",
  name: "Schedule",
  description: "Run on a cron schedule or a fixed interval.",
  fields: [
    {
      key: "mode",
      label: "Schedule type",
      type: "select",
      default: "cron",
      options: [
        { value: "cron", label: "Cron expression" },
        { value: "interval", label: "Every N minutes" },
      ],
    },
    { key: "cron", label: "Cron expression", type: "string", default: "0 9 * * 1-5", allowExpressions: false, description: "minute hour day-of-month month day-of-week (e.g. 0 9 * * 1-5 = weekdays 09:00)", showWhen: { key: "mode", equals: ["cron"] } },
    { key: "intervalMinutes", label: "Interval (minutes)", type: "number", default: 60, min: 1, max: 1440, allowExpressions: false, showWhen: { key: "mode", equals: ["interval"] } },
    { key: "timezone", label: "Time zone", type: "string", default: "UTC", allowExpressions: false, placeholder: "Europe/Berlin" },
  ],
  sampleOutput: { scheduledFor: "2026-01-01T09:00:00.000Z", firedAt: "2026-01-01T09:00:01.000Z", cron: "0 9 * * 1-5", timezone: "UTC" },
  mode: "local",
  execute: passthroughTrigger,
};

const tableTrigger: NodeImplementation = {
  type: "trigger.table_record",
  integration: "core",
  kind: "trigger",
  name: "Table record changed",
  description: "Run when a record in one of your data tables is created, updated or deleted.",
  fields: [
    { key: "tableId", label: "Table", type: "table", required: true, allowExpressions: false },
    {
      key: "on",
      label: "When a record is",
      type: "select",
      default: "created",
      options: [
        { value: "created", label: "Created" },
        { value: "updated", label: "Updated" },
        { value: "deleted", label: "Deleted" },
        { value: "any", label: "Created, updated or deleted" },
      ],
    },
  ],
  events: ["table.row.created", "table.row.updated", "table.row.deleted"],
  matchEvent: (config, eventType, payload) => payload.tableId === config.tableId && (config.on === "any" || eventType === `table.row.${config.on ?? "created"}`),
  sampleOutput: { event: "table.row.created", tableId: "tbl_123", row: { id: "row_1", data: { name: "Ada" } } },
  mode: "local",
  execute: passthroughTrigger,
};

const formTrigger: NodeImplementation = {
  type: "trigger.form_submission",
  integration: "core",
  kind: "trigger",
  name: "Form submitted",
  description: "Run when someone submits one of your forms.",
  fields: [{ key: "formId", label: "Form", type: "form", required: true, allowExpressions: false }],
  events: ["form.submitted"],
  matchEvent: (config, _type, payload) => payload.formId === config.formId,
  sampleOutput: { event: "form.submitted", formId: "frm_123", submission: { name: "Ada", email: "ada@example.com" }, rowId: "row_1" },
  mode: "local",
  execute: passthroughTrigger,
};

const failureTrigger: NodeImplementation = {
  type: "trigger.execution_failed",
  integration: "core",
  kind: "trigger",
  name: "Workflow failed",
  description: "Run when another workflow in this workspace fails (for alerts and incident handling).",
  fields: [{ key: "workflowId", label: "Only for workflow (optional)", type: "workflow", allowExpressions: false }],
  events: ["execution.failed"],
  matchEvent: (config, _type, payload) => !config.workflowId || payload.workflowId === config.workflowId,
  sampleOutput: { event: "execution.failed", executionId: "exe_123", workflowId: "wf_123", workflowName: "Lead intake", error: { message: "Request failed" } },
  mode: "local",
  execute: passthroughTrigger,
};

const httpPollTrigger: NodeImplementation = {
  type: "trigger.http_poll",
  integration: "core",
  kind: "trigger",
  name: "New items in a JSON feed",
  description: "Poll a JSON API on an interval and start one execution per new item.",
  credentialType: "http_auth",
  credentialRequired: false,
  fields: [
    { key: "url", label: "URL", type: "string", required: true, allowExpressions: false, placeholder: "https://api.example.com/items" },
    { key: "itemsPath", label: "Path to the list", type: "string", placeholder: "data.items", allowExpressions: false, description: "Dot path to the array in the response. Leave empty if the response is the array." },
    { key: "idField", label: "Unique ID field", type: "string", default: "id", allowExpressions: false },
    { key: "pollMinutes", label: "Check every (minutes)", type: "number", default: 15, min: 1, max: 1440, allowExpressions: false },
    { key: "headers", label: "Headers", type: "keyvalue", allowExpressions: false },
    { key: "emitExisting", label: "Process existing items on first check", type: "boolean", default: false },
  ],
  sampleOutput: { id: "123", title: "Example item" },
  mode: "live",
  execute: passthroughTrigger,
  async poll(ctx) {
    const res = await safeRequest(ctx.app.fetch, String(ctx.config.url), {
      headers: { accept: "application/json", ...((ctx.config.headers as Record<string, string>) ?? {}), ...authHeadersFor(ctx.credential) },
      timeoutMs: 30_000,
      maxBytes: 5_000_000,
      signal: ctx.signal,
    });
    if (res.status >= 400) throw new Error(`Feed returned HTTP ${res.status}`);
    const body = JSON.parse(res.body.toString("utf8"));
    const list = ctx.config.itemsPath ? getPath(body, String(ctx.config.itemsPath)) : body;
    if (!Array.isArray(list)) throw new Error("The configured path did not point to a list.");
    const idField = String(ctx.config.idField || "id");
    const seen = new Set<string>((ctx.state.seen as string[]) ?? []);
    const first = !ctx.state.initialized;
    const items = [];
    for (const item of list) {
      const id = toText(getPath(item, idField));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!first || ctx.config.emitExisting) items.push({ data: item, dedupeKey: id });
    }
    return { items: items.reverse(), state: { initialized: true, seen: [...seen].slice(-1000) } };
  },
};

// ---------------------------------------------------------------------------
// Logic

const RULES_FIELD = { key: "rules", label: "Conditions", type: "conditions" as const, required: true, default: [{ left: "", operator: "equals", right: "" }] };
const COMBINATOR_FIELD = {
  key: "combinator",
  label: "Match",
  type: "select" as const,
  default: "and",
  options: [
    { value: "and", label: "All conditions (AND)" },
    { value: "or", label: "Any condition (OR)" },
  ],
};

const condition: NodeImplementation = {
  type: "logic.condition",
  integration: "core",
  kind: "logic",
  name: "Condition (if / else)",
  description: "Route the workflow down the 'true' or 'false' branch.",
  fields: [RULES_FIELD, COMBINATOR_FIELD, { key: "caseSensitive", label: "Case-sensitive text comparison", type: "boolean", default: false }],
  branches: ["true", "false"],
  sampleOutput: { result: true },
  mode: "local",
  testable: true,
  async execute(ctx) {
    const result = evaluateRules((ctx.config.rules as ConditionRule[]) ?? [], ctx.config.combinator === "or" ? "or" : "and", ctx.config.caseSensitive === true);
    return { output: { result }, branch: result ? "true" : "false" };
  },
};

const switchNode: NodeImplementation = {
  type: "logic.switch",
  integration: "core",
  kind: "logic",
  name: "Switch (route by value)",
  description: "Route to the first case whose value equals the input, or to 'default'.",
  fields: [
    { key: "value", label: "Value to match", type: "string", required: true, placeholder: "{{ steps.classify.output.label }}" },
    { key: "cases", label: "Cases", type: "cases", default: [{ branch: "case1", equals: "" }], description: "Each case becomes an output branch." },
    { key: "caseSensitive", label: "Case-sensitive", type: "boolean", default: false },
  ],
  dynamicBranches: true,
  sampleOutput: { value: "sales", matched: "sales" },
  mode: "local",
  testable: true,
  async execute(ctx) {
    const value = toText(ctx.config.value);
    const cases = (ctx.config.cases as Array<{ branch: string; equals: unknown }>) ?? [];
    const norm = (s: string) => (ctx.config.caseSensitive ? s : s.toLowerCase());
    const hit = cases.find((c) => norm(toText(c.equals)) === norm(value));
    return { output: { value, matched: hit?.branch ?? "default" }, branch: hit?.branch ?? "default" };
  },
};

const filter: NodeImplementation = {
  type: "logic.filter",
  integration: "core",
  kind: "logic",
  name: "Filter (only continue if)",
  description: "Stop this path unless the conditions are met.",
  fields: [RULES_FIELD, COMBINATOR_FIELD],
  sampleOutput: { passed: true },
  mode: "local",
  testable: true,
  async execute(ctx) {
    const passed = evaluateRules((ctx.config.rules as ConditionRule[]) ?? [], ctx.config.combinator === "or" ? "or" : "and");
    if (!passed) ctx.log("Filter conditions not met; downstream steps on this path are skipped.");
    return { output: { passed }, stop: !passed };
  },
};

const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
const MAX_DELAY_MS = 30 * 86_400_000;

const delay: NodeImplementation = {
  type: "logic.delay",
  integration: "core",
  kind: "logic",
  name: "Delay",
  description: "Pause the workflow for a duration or until a date/time (max 30 days). The pause is durable across restarts.",
  fields: [
    {
      key: "mode",
      label: "Delay",
      type: "select",
      default: "duration",
      options: [
        { value: "duration", label: "For a duration" },
        { value: "until", label: "Until a date/time" },
      ],
    },
    { key: "amount", label: "Amount", type: "number", default: 5, min: 0, showWhen: { key: "mode", equals: ["duration"] } },
    {
      key: "unit",
      label: "Unit",
      type: "select",
      default: "minutes",
      showWhen: { key: "mode", equals: ["duration"] },
      options: Object.keys(UNIT_MS).map((u) => ({ value: u, label: u })),
    },
    { key: "until", label: "Resume at (ISO date/time)", type: "string", placeholder: "{{ addDays(now(), 1) }}", showWhen: { key: "mode", equals: ["until"] } },
  ],
  sampleOutput: { resumedAt: "2026-01-01T09:05:00.000Z", scheduledFor: "2026-01-01T09:05:00.000Z" },
  mode: "local",
  async execute(ctx) {
    let until: number;
    if (ctx.config.mode === "until") {
      until = Date.parse(toText(ctx.config.until));
      if (Number.isNaN(until)) throw new StepError("config", "Resume time is not a valid date.");
    } else {
      until = Date.now() + Math.max(0, Number(ctx.config.amount) || 0) * (UNIT_MS[String(ctx.config.unit)] ?? 60_000);
    }
    if (until - Date.now() > MAX_DELAY_MS) throw new StepError("config", "Delays are limited to 30 days.");
    if (until <= Date.now()) return { output: { resumedAt: new Date().toISOString(), scheduledFor: new Date(until).toISOString() } };
    return { wait: { until: new Date(until).toISOString(), reason: "delay" } };
  },
  async resume(ctx) {
    const until = Date.parse(String((ctx.waitState as { until?: string })?.until));
    if (Date.now() < until) return null;
    return { output: { resumedAt: new Date().toISOString(), scheduledFor: new Date(until).toISOString() } };
  },
  async mock(ctx) {
    ctx.log("Test run: delay skipped.");
    return { output: { resumedAt: new Date().toISOString(), skippedInTest: true, _mock: true } };
  },
};

const loop: NodeImplementation = {
  type: "logic.loop",
  integration: "core",
  kind: "logic",
  name: "Loop over items",
  description: "Run a sub-workflow once per item (bounded). The sub-workflow receives { item, index }.",
  fields: [
    { key: "items", label: "Items", type: "string", required: true, placeholder: "{{ steps.find.output.rows }}" },
    { key: "workflowId", label: "Sub-workflow", type: "workflow", required: true, allowExpressions: false },
    { key: "maxIterations", label: "Maximum iterations", type: "number", default: 100, min: 1, max: 1000, allowExpressions: false },
    { key: "continueOnError", label: "Continue when an item fails", type: "boolean", default: true },
  ],
  sampleOutput: { count: 2, succeeded: 2, failed: 0, results: [{ index: 0, status: "succeeded", output: {} }] },
  mode: "local",
  defaultTimeoutMs: 15 * 60_000,
  async execute(ctx) {
    const items = asArray(ctx.config.items, "Items");
    const max = Math.min(1000, Number(ctx.config.maxIterations) || 100);
    if (items.length > max) throw new StepError("config", `Loop received ${items.length} items, more than the configured maximum of ${max}.`);
    const results = [];
    let failed = 0;
    for (let index = 0; index < items.length; index++) {
      if (ctx.signal.aborted) throw new StepError("cancelled", "Loop cancelled.");
      const r = await ctx.runSubworkflow(String(ctx.config.workflowId), { item: items[index], index, parentExecutionId: ctx.executionId });
      if (r.status !== "succeeded") {
        failed++;
        if (!ctx.config.continueOnError) throw new StepError("permanent", `Item ${index} failed in sub-workflow (execution ${r.executionId}).`, { executionId: r.executionId, error: r.error });
      }
      results.push({ index, status: r.status, executionId: r.executionId, output: r.output });
    }
    return { output: { count: items.length, succeeded: items.length - failed, failed, results } };
  },
};

const callWorkflow: NodeImplementation = {
  type: "flow.call_workflow",
  integration: "core",
  kind: "logic",
  name: "Run sub-workflow",
  description: "Run another workflow with input data and use its result.",
  fields: [
    { key: "workflowId", label: "Workflow", type: "workflow", required: true, allowExpressions: false },
    { key: "input", label: "Input", type: "json", default: {} },
  ],
  sampleOutput: { status: "succeeded", output: {} },
  mode: "local",
  defaultTimeoutMs: 10 * 60_000,
  async execute(ctx) {
    const r = await ctx.runSubworkflow(String(ctx.config.workflowId), ctx.config.input ?? {});
    if (r.status !== "succeeded") throw new StepError("permanent", `Sub-workflow failed (execution ${r.executionId}).`, { executionId: r.executionId, error: r.error });
    return { output: { status: r.status, executionId: r.executionId, output: r.output } };
  },
};

const respondWebhook: NodeImplementation = {
  type: "flow.respond_webhook",
  integration: "core",
  kind: "logic",
  name: "Respond to webhook",
  description: "Send the HTTP response for a webhook trigger set to 'Wait for a Respond to webhook step'.",
  fields: [
    { key: "status", label: "Status code", type: "number", default: 200, min: 100, max: 599 },
    { key: "contentType", label: "Content type", type: "string", default: "application/json" },
    { key: "body", label: "Body", type: "json", default: { ok: true } },
    { key: "headers", label: "Headers", type: "keyvalue" },
  ],
  sampleOutput: { status: 200, body: { ok: true } },
  mode: "local",
  async execute(ctx) {
    const headers = Object.fromEntries(Object.entries((ctx.config.headers as Record<string, unknown>) ?? {}).filter(([k]) => /^[a-zA-Z0-9-]{1,64}$/.test(k) && !/^(set-cookie|content-length|transfer-encoding|connection)$/i.test(k)).map(([k, v]) => [k, toText(v)]));
    return { output: { status: Math.min(599, Math.max(100, Number(ctx.config.status) || 200)), contentType: toText(ctx.config.contentType) || "application/json", headers, body: ctx.config.body ?? null } };
  },
};

const stopError: NodeImplementation = {
  type: "flow.stop_error",
  integration: "core",
  kind: "logic",
  name: "Stop and fail",
  description: "Fail the execution with a custom message (useful after a condition).",
  fields: [{ key: "message", label: "Error message", type: "string", required: true, default: "Stopped by workflow" }],
  mode: "local",
  async execute(ctx) {
    throw new StepError("permanent", toText(ctx.config.message) || "Stopped by workflow");
  },
};

const approval: NodeImplementation = {
  type: "human.approval",
  integration: "core",
  kind: "logic",
  name: "Human approval",
  description: "Pause until a workspace member approves or rejects (e.g. before sending AI-drafted messages).",
  fields: [
    { key: "title", label: "Title", type: "string", required: true, default: "Approval needed" },
    { key: "message", label: "Message for the approver", type: "text" },
    { key: "data", label: "Data to review", type: "json", description: "Shown to the approver, e.g. the drafted email." },
    { key: "timeoutHours", label: "Expire after (hours)", type: "number", default: 72, min: 1, max: 720 },
  ],
  branches: ["approved", "rejected"],
  sampleOutput: { decision: "approved", comment: "Looks good", decidedBy: "user_1", data: {} },
  mode: "local",
  async execute(ctx) {
    const id = randomId("apr");
    const expiresAt = new Date(Date.now() + (Number(ctx.config.timeoutHours) || 72) * 3_600_000);
    await ctx.app.db.query(
      `INSERT INTO approvals (id, workspace_id, execution_id, node_id, title, message, data, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ctx.workspaceId, ctx.executionId, ctx.nodeId, toText(ctx.config.title).slice(0, 300), toText(ctx.config.message).slice(0, 10_000), ctx.config.data ?? null, expiresAt],
    );
    return { wait: { until: expiresAt.toISOString(), reason: "approval", state: { approvalId: id } } };
  },
  async resume(ctx) {
    const id = (ctx.waitState as { approvalId?: string })?.approvalId;
    const row = await ctx.app.db.one<{ status: string; comment: string | null; decided_by: string | null; data: unknown; expires_at: string }>(
      "SELECT status, comment, decided_by, data, expires_at FROM approvals WHERE id = $1 AND workspace_id = $2",
      [id, ctx.workspaceId],
    );
    if (!row) throw new StepError("permanent", "Approval request not found.");
    if (row.status === "pending" && Date.parse(row.expires_at) > Date.now()) return null;
    if (row.status === "pending") await ctx.app.db.query("UPDATE approvals SET status = 'expired' WHERE id = $1", [id]);
    const decision = row.status === "approved" ? "approved" : row.status === "pending" ? "expired" : row.status;
    return { output: { decision, comment: row.comment, decidedBy: row.decided_by, data: row.data }, branch: decision === "approved" ? "approved" : "rejected" };
  },
  async mock(ctx) {
    ctx.log("Test run: approval auto-approved.");
    return { output: { decision: "approved", comment: "Auto-approved in test run", data: ctx.config.data ?? null, _mock: true }, branch: "approved" };
  },
};

// ---------------------------------------------------------------------------
// Transform

const setFields: NodeImplementation = {
  type: "transform.set",
  integration: "core",
  kind: "data",
  name: "Set fields",
  description: "Build an object from mapped values (rename, combine and format data).",
  fields: [{ key: "fields", label: "Fields", type: "keyvalue", required: true, default: { name: "{{ trigger.body.name }}" } }],
  sampleOutput: { name: "Ada" },
  mode: "local",
  testable: true,
  async execute(ctx) {
    return { output: { ...((ctx.config.fields as Record<string, unknown>) ?? {}) } };
  },
};

const mapItems: NodeImplementation = {
  type: "transform.map",
  integration: "core",
  kind: "data",
  name: "Map list items",
  description: "Transform each item of a list. Use {{ item }} and {{ index }} in the mapping.",
  fields: [
    { key: "items", label: "List", type: "string", required: true, placeholder: "{{ steps.read.output.rows }}" },
    { key: "mapping", label: "Output fields per item", type: "keyvalue", required: true, default: { email: "{{ lower(item.email) }}" } },
    { key: "maxItems", label: "Maximum items", type: "number", default: 10000, min: 1, max: 100000, allowExpressions: false },
  ],
  rawFields: ["mapping"],
  sampleOutput: { count: 1, items: [{ email: "ada@example.com" }] },
  mode: "local",
  testable: true,
  async execute(ctx) {
    const items = asArray(ctx.config.items, "List");
    if (items.length > (Number(ctx.config.maxItems) || 10000)) throw new StepError("config", `List has ${items.length} items, more than the maximum.`);
    const mapping = (ctx.rawConfig.mapping as Record<string, unknown>) ?? {};
    const out = items.map((item, index) => ctx.render(mapping, { item, index }));
    return { output: { count: out.length, items: out } };
  },
};

const listOps: NodeImplementation = {
  type: "transform.list",
  integration: "core",
  kind: "data",
  name: "Filter, sort & limit list",
  description: "Keep items matching conditions (use {{ item.field }}), sort, de-duplicate and limit.",
  fields: [
    { key: "items", label: "List", type: "string", required: true },
    { key: "rules", label: "Keep items where", type: "conditions", default: [] },
    COMBINATOR_FIELD,
    { key: "sortBy", label: "Sort by field", type: "string", allowExpressions: false, placeholder: "score" },
    {
      key: "sortDirection",
      label: "Sort direction",
      type: "select",
      default: "asc",
      options: [
        { value: "asc", label: "Ascending" },
        { value: "desc", label: "Descending" },
      ],
    },
    { key: "uniqueBy", label: "Remove duplicates by field", type: "string", allowExpressions: false, placeholder: "email" },
    { key: "limit", label: "Limit", type: "number", min: 1, max: 100000 },
  ],
  rawFields: ["rules"],
  sampleOutput: { count: 1, items: [] },
  mode: "local",
  testable: true,
  async execute(ctx) {
    let items = asArray(ctx.config.items, "List");
    const rules = (ctx.rawConfig.rules as ConditionRule[]) ?? [];
    if (rules.length) {
      items = items.filter((item, index) => evaluateRules(ctx.render(rules, { item, index }) as ConditionRule[], ctx.config.combinator === "or" ? "or" : "and"));
    }
    if (ctx.config.uniqueBy) {
      const seen = new Set<string>();
      items = items.filter((it) => {
        const k = toText(getPath(it, String(ctx.config.uniqueBy))).toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    if (ctx.config.sortBy) {
      const key = String(ctx.config.sortBy);
      const dir = ctx.config.sortDirection === "desc" ? -1 : 1;
      items = [...items].sort((a, b) => {
        const x = getPath(a, key);
        const y = getPath(b, key);
        const nx = Number(x);
        const ny = Number(y);
        const c = !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : toText(x).localeCompare(toText(y));
        return c * dir;
      });
    }
    if (ctx.config.limit) items = items.slice(0, Number(ctx.config.limit));
    return { output: { count: items.length, items } };
  },
};

const aggregate: NodeImplementation = {
  type: "transform.aggregate",
  integration: "core",
  kind: "data",
  name: "Aggregate list",
  description: "Count, sum, average, min/max or group-count a list of items.",
  fields: [
    { key: "items", label: "List", type: "string", required: true },
    {
      key: "operation",
      label: "Operation",
      type: "select",
      default: "count",
      options: ["count", "sum", "avg", "min", "max", "group_count"].map((v) => ({ value: v, label: v.replace("_", " ") })),
    },
    { key: "field", label: "Field", type: "string", allowExpressions: false, placeholder: "amount" },
  ],
  sampleOutput: { result: 3 },
  mode: "local",
  testable: true,
  async execute(ctx) {
    const items = asArray(ctx.config.items, "List");
    const field = ctx.config.field ? String(ctx.config.field) : "";
    const values = items.map((i) => (field ? getPath(i, field) : i));
    const nums = values.map(Number).filter((n) => !Number.isNaN(n));
    switch (ctx.config.operation) {
      case "sum":
        return { output: { result: nums.reduce((a, b) => a + b, 0) } };
      case "avg":
        return { output: { result: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0 } };
      case "min":
        return { output: { result: nums.length ? Math.min(...nums) : null } };
      case "max":
        return { output: { result: nums.length ? Math.max(...nums) : null } };
      case "group_count": {
        const groups: Record<string, number> = {};
        for (const v of values) groups[toText(v)] = (groups[toText(v)] ?? 0) + 1;
        return { output: { result: groups } };
      }
      default:
        return { output: { result: items.length } };
    }
  },
};

const textOps: NodeImplementation = {
  type: "transform.text",
  integration: "core",
  kind: "data",
  name: "Text utilities",
  description: "Extract emails, URLs or numbers, strip HTML, count words, or split text.",
  fields: [
    { key: "text", label: "Text", type: "text", required: true },
    {
      key: "operation",
      label: "Operation",
      type: "select",
      default: "extract_emails",
      options: [
        { value: "extract_emails", label: "Extract email addresses" },
        { value: "extract_urls", label: "Extract URLs" },
        { value: "extract_numbers", label: "Extract numbers" },
        { value: "extract_phones", label: "Extract phone numbers" },
        { value: "strip_html", label: "Strip HTML tags" },
        { value: "word_count", label: "Count words" },
        { value: "split_lines", label: "Split into lines" },
      ],
    },
  ],
  sampleOutput: { result: ["ada@example.com"] },
  mode: "local",
  testable: true,
  async execute(ctx) {
    const text = toText(ctx.config.text).slice(0, 2_000_000);
    const uniq = (xs: string[]) => [...new Set(xs)];
    switch (ctx.config.operation) {
      case "extract_emails":
        return { output: { result: uniq(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) } };
      case "extract_urls":
        return { output: { result: uniq(text.match(/https?:\/\/[^\s<>"')]+/g) ?? []) } };
      case "extract_numbers":
        return { output: { result: (text.match(/-?\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(",", "."))) } };
      case "extract_phones":
        return { output: { result: uniq((text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? []).map((p) => p.trim())) } };
      case "strip_html":
        return { output: { result: text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() } };
      case "word_count":
        return { output: { result: text.trim() ? text.trim().split(/\s+/).length : 0 } };
      case "split_lines":
        return { output: { result: text.split(/\r?\n/).filter((l) => l.trim() !== "") } };
      default:
        throw new StepError("config", "Unknown text operation.");
    }
  },
};

export const coreIntegration: IntegrationModule = {
  definition: {
    id: "core",
    name: "Built-in",
    description: "Triggers, logic, flow control, approvals and data transformation built into the platform.",
    category: "Built-in",
    version: "1.0.0",
    icon: "zap",
    credentialTypes: ["webhook_secret"],
    prerequisites: [],
    availability: "local",
  },
  nodes: [
    manualTrigger,
    webhookTrigger,
    scheduleTrigger,
    tableTrigger,
    formTrigger,
    failureTrigger,
    httpPollTrigger,
    condition,
    switchNode,
    filter,
    delay,
    loop,
    callWorkflow,
    respondWebhook,
    stopError,
    approval,
    setFields,
    mapItems,
    listOps,
    aggregate,
    textOps,
  ],
  credentialTypes: [
    {
      id: "webhook_secret",
      name: "Webhook secret",
      description: "Shared secret used to verify incoming webhook requests.",
      fields: [{ key: "secret", label: "Secret", type: "string", required: true, sensitive: true, description: "At least 16 characters. Callers send it (or an HMAC signature using it) in the configured header." }],
    },
  ],
};

export { asArray, getPath, truthy };
