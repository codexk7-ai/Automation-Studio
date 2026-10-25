import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { redact, toText } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { badRequest, notFound } from "../errors.ts";
import { StepError } from "../errors.ts";
import { authHeadersFor } from "../integrations/http.ts";
import { randomId } from "../security/crypto.ts";
import { validateJson } from "../security/jsonschema.ts";
import { assertUrlAllowed } from "../security/ssrf.ts";
import type { Principal } from "../auth/principal.ts";
import { authorize } from "../auth/principal.ts";
import { audit } from "../services/audit.ts";
import { loadCredential } from "../services/credentials.ts";

export interface DiscoveredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ToolPolicy {
  /** Tools are disabled until an admin explicitly enables them. */
  enabled: boolean;
  /** May an AI agent node choose to call this tool? */
  allowForAi: boolean;
}

export interface McpServerRow {
  id: string;
  workspace_id: string;
  name: string;
  url: string;
  credential_id: string | null;
  enabled: boolean;
  timeout_ms: number;
  tools: DiscoveredTool[];
  tool_policies: Record<string, ToolPolicy>;
  status: string;
  last_error: string | null;
  last_checked_at: string | null;
  created_at: string;
}

async function connect(app: AppContext, server: McpServerRow): Promise<Client> {
  assertUrlAllowed(server.url, app.policy);
  const credential = server.credential_id ? await loadCredential(app, server.workspace_id, server.credential_id) : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: app.fetch as unknown as typeof fetch,
    requestInit: { headers: authHeadersFor(credential) },
    redirectPolicy: "same-origin",
  });
  const client = new Client({ name: app.config.brandName, version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function withClient<T>(app: AppContext, server: McpServerRow, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await connect(app, server);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Sanitizes untrusted tool metadata from an external server. */
function sanitizeTool(t: { name: string; title?: string; description?: string; inputSchema?: unknown; annotations?: unknown }): DiscoveredTool | null {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(t.name)) return null;
  const schema = t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : { type: "object" };
  if (JSON.stringify(schema).length > 50_000) return null;
  return {
    name: t.name,
    title: t.title ? toText(t.title).slice(0, 200) : undefined,
    description: toText(t.description).slice(0, 2000),
    inputSchema: schema,
    annotations: t.annotations && typeof t.annotations === "object" ? (t.annotations as Record<string, unknown>) : undefined,
  };
}

export async function getServer(app: AppContext, workspaceId: string, id: string): Promise<McpServerRow> {
  const row = await app.db.one<McpServerRow>("SELECT * FROM mcp_servers WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  if (!row) throw notFound("MCP server");
  return row;
}

export async function listServers(app: AppContext, workspaceId: string): Promise<McpServerRow[]> {
  return app.db.query<McpServerRow>("SELECT * FROM mcp_servers WHERE workspace_id = $1 ORDER BY name", [workspaceId]);
}

export async function registerServer(app: AppContext, p: Principal, input: { name: string; url: string; credentialId?: string | null; timeoutMs?: number }): Promise<McpServerRow> {
  authorize(p, "admin", "admin");
  const name = toText(input.name).trim();
  if (!name || name.length > 200) throw badRequest("Name is required.");
  try {
    assertUrlAllowed(toText(input.url), app.policy);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  if (input.credentialId) {
    const c = await app.db.one<{ type: string }>("SELECT type FROM credentials WHERE id = $1 AND workspace_id = $2", [input.credentialId, p.workspaceId]);
    if (!c || c.type !== "http_auth") throw badRequest("MCP servers authenticate with an 'HTTP authentication' connection.");
  }
  const id = randomId("mcp");
  await app.db.query("INSERT INTO mcp_servers (id, workspace_id, name, url, credential_id, timeout_ms) VALUES ($1, $2, $3, $4, $5, $6)", [
    id,
    p.workspaceId,
    name,
    toText(input.url),
    input.credentialId ?? null,
    Math.min(120_000, Math.max(1000, Number(input.timeoutMs) || 30_000)),
  ]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "mcp_server.register", resourceType: "mcp_server", resourceId: id, details: { name, url: input.url }, ip: p.ip });
  return getServer(app, p.workspaceId, id);
}

export async function updateServer(app: AppContext, p: Principal, id: string, input: { name?: string; enabled?: boolean; timeoutMs?: number; toolPolicies?: Record<string, ToolPolicy> }): Promise<McpServerRow> {
  authorize(p, "admin", "admin");
  const s = await getServer(app, p.workspaceId, id);
  const policies = { ...s.tool_policies };
  for (const [tool, pol] of Object.entries(input.toolPolicies ?? {})) {
    if (!s.tools.some((t) => t.name === tool)) throw badRequest(`Unknown tool '${tool}'. Refresh the tool list first.`);
    policies[tool] = { enabled: pol.enabled === true, allowForAi: pol.enabled === true && pol.allowForAi === true };
  }
  await app.db.query("UPDATE mcp_servers SET name = $3, enabled = $4, timeout_ms = $5, tool_policies = $6 WHERE id = $1 AND workspace_id = $2", [
    id,
    p.workspaceId,
    input.name?.trim() || s.name,
    input.enabled ?? s.enabled,
    input.timeoutMs ? Math.min(120_000, Math.max(1000, input.timeoutMs)) : s.timeout_ms,
    policies,
  ]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "mcp_server.update", resourceType: "mcp_server", resourceId: id, details: { enabled: input.enabled, toolPolicies: input.toolPolicies }, ip: p.ip });
  return getServer(app, p.workspaceId, id);
}

export async function deleteServer(app: AppContext, p: Principal, id: string): Promise<void> {
  authorize(p, "admin", "admin");
  const rows = await app.db.query("DELETE FROM mcp_servers WHERE id = $1 AND workspace_id = $2 RETURNING id", [id, p.workspaceId]);
  if (!rows.length) throw notFound("MCP server");
  await audit(app, p, { workspaceId: p.workspaceId, action: "mcp_server.delete", resourceType: "mcp_server", resourceId: id, ip: p.ip });
}

/** Connects, lists tools and records connection health. */
export async function refreshTools(app: AppContext, p: Principal, id: string): Promise<McpServerRow> {
  authorize(p, "admin", "admin");
  const s = await getServer(app, p.workspaceId, id);
  try {
    const tools = await withClient(app, s, async (c) => {
      const all: DiscoveredTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await c.listTools(cursor ? { cursor } : undefined, { timeout: s.timeout_ms });
        for (const t of res.tools) {
          const clean = sanitizeTool(t as never);
          if (clean) all.push(clean);
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return all.slice(0, 500);
    });
    // New tools default to disabled; removed tools lose their policy.
    const policies: Record<string, ToolPolicy> = {};
    for (const t of tools) policies[t.name] = s.tool_policies[t.name] ?? { enabled: false, allowForAi: false };
    await app.db.query("UPDATE mcp_servers SET tools = $2, tool_policies = $3, status = 'connected', last_error = NULL, last_checked_at = now() WHERE id = $1", [id, tools, policies]);
  } catch (err) {
    await app.db.query("UPDATE mcp_servers SET status = 'error', last_error = $2, last_checked_at = now() WHERE id = $1", [id, toText((err as Error).message).slice(0, 1000)]);
  }
  await audit(app, p, { workspaceId: p.workspaceId, action: "mcp_server.refresh", resourceType: "mcp_server", resourceId: id, ip: p.ip });
  return getServer(app, p.workspaceId, id);
}

export interface ToolCallResult {
  isError: boolean;
  text: string;
  structured?: unknown;
}

/**
 * Invokes an external MCP tool after checking: server enabled, tool enabled
 * by an admin (and allowed for AI when the caller is an AI agent), and
 * arguments valid against the tool's declared input schema. Results are
 * untrusted content and are size-capped.
 */
export async function callExternalTool(
  app: AppContext,
  workspaceId: string,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: { executionId?: string; actor: string; purpose: "workflow" | "ai" | "test"; signal?: AbortSignal },
): Promise<ToolCallResult> {
  const s = await getServer(app, workspaceId, serverId).catch(() => {
    throw new StepError("config", "The MCP server is not registered in this workspace.");
  });
  if (!s.enabled) throw new StepError("config", `MCP server '${s.name}' is disabled.`);
  const tool = s.tools.find((t) => t.name === toolName);
  if (!tool) throw new StepError("config", `Tool '${toolName}' was not found on '${s.name}'. Refresh the tool list.`);
  const policy = s.tool_policies[toolName];
  if (!policy?.enabled) throw new StepError("policy", `Tool '${toolName}' has not been enabled by an administrator.`);
  if (opts.purpose === "ai" && !policy.allowForAi) throw new StepError("policy", `Tool '${toolName}' is not allowed for AI agents.`);
  const check = validateJson(tool.inputSchema, args);
  if (!check.valid) throw new StepError("config", `Invalid arguments for ${toolName}: ${check.errors.join("; ")}`);

  const started = Date.now();
  let status = "succeeded";
  let error: string | null = null;
  try {
    const result = await withClient(app, s, (c) => c.callTool({ name: toolName, arguments: args }, { timeout: s.timeout_ms, signal: opts.signal }));
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? toText((b as { text?: unknown }).text) : `[${toText((b as { type?: string })?.type)} content omitted]`))
      .join("\n")
      .slice(0, 100_000);
    const isError = result.isError === true;
    if (isError) status = "tool_error";
    return { isError, text, structured: result.structuredContent };
  } catch (err) {
    status = "failed";
    error = toText((err as Error).message).slice(0, 1000);
    throw new StepError("transient", `MCP call to ${s.name}/${toolName} failed: ${error}`);
  } finally {
    await app.db.query(
      "INSERT INTO mcp_tool_calls (workspace_id, direction, server_id, tool, actor, execution_id, status, duration_ms, error, arguments) VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, $9)",
      [workspaceId, serverId, toolName, opts.actor, opts.executionId ?? null, status, Date.now() - started, error, redact(args)],
    );
  }
}
