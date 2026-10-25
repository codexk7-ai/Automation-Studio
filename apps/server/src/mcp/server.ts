import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { redact } from "@automation-studio/core";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { AppError } from "../errors.ts";
import type { ApiScope, Principal } from "../auth/principal.ts";
import { requireRole, requireScope } from "../auth/principal.ts";
import { getExecution, listExecutions, retryExecution } from "../services/executions.ts";
import { createWorkflow, getWorkflow, listWorkflows, runWorkflow, saveDraft, validateDefinition } from "../services/workflows.ts";

interface ToolMeta {
  name: string;
  scope: ApiScope;
  minRole: "viewer" | "editor";
  description: string;
}

/** Catalog used both to register tools and to answer list_available_tools. */
export const PLATFORM_TOOLS: ToolMeta[] = [
  { name: "list_workflows", scope: "read", minRole: "viewer", description: "List workflows with status and recent run statistics." },
  { name: "get_workflow", scope: "read", minRole: "viewer", description: "Get a workflow's draft definition, status and published version." },
  { name: "search_integrations", scope: "read", minRole: "viewer", description: "Search available integrations and their triggers/actions." },
  { name: "get_action_schema", scope: "read", minRole: "viewer", description: "Get the configuration fields, branches and sample output of a node type." },
  { name: "validate_workflow", scope: "read", minRole: "viewer", description: "Validate a workflow (saved draft or a provided definition) and return errors and warnings." },
  { name: "create_workflow_draft", scope: "write", minRole: "editor", description: "Create a new workflow as an unpublished draft. Drafts never run until a human publishes them." },
  { name: "update_workflow_draft", scope: "write", minRole: "editor", description: "Replace a workflow's draft definition (does not affect the published version)." },
  { name: "test_workflow", scope: "execute", minRole: "editor", description: "Start a test run of the draft. External side effects are simulated unless simulateExternal is false." },
  { name: "get_execution_status", scope: "read", minRole: "viewer", description: "Get an execution's status and per-step results (sensitive values redacted)." },
  { name: "get_execution_history", scope: "read", minRole: "viewer", description: "List recent executions, optionally filtered by workflow or status." },
  { name: "retry_execution", scope: "execute", minRole: "editor", description: "Retry a failed execution (failed steps only, or from the start)." },
  { name: "list_available_tools", scope: "read", minRole: "viewer", description: "List the platform tools and whether this token may call them." },
];

function ok(data: unknown): CallToolResult {
  const safe = redact(data) as Record<string, unknown>;
  return { content: [{ type: "text", text: JSON.stringify(safe, null, 2).slice(0, 200_000) }], structuredContent: Array.isArray(safe) ? { items: safe } : safe };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Builds a per-request MCP server bound to one authenticated principal. */
export function buildMcpServer(app: AppContext, principal: Principal): McpServer {
  const server = new McpServer({ name: `${app.config.brandName} MCP`, version: "0.1.0" });

  const guarded = <A>(meta: ToolMeta, fn: (args: A) => Promise<unknown>) => {
    return async (args: A): Promise<CallToolResult> => {
      const started = Date.now();
      let status = "succeeded";
      let error: string | null = null;
      try {
        requireScope(principal, meta.scope);
        requireRole(principal, meta.minRole);
        return ok(await fn(args));
      } catch (err) {
        status = "failed";
        error = err instanceof AppError ? err.message : (err as Error).message;
        const details = err instanceof AppError && err.details ? `\n${JSON.stringify(err.details).slice(0, 4000)}` : "";
        return fail(`${error}${details}`);
      } finally {
        await app.db.query(
          "INSERT INTO mcp_tool_calls (workspace_id, direction, tool, actor, status, duration_ms, error, arguments) VALUES ($1, 'inbound', $2, $3, $4, $5, $6, $7)",
          [principal.workspaceId, meta.name, principal.tokenId ? `token:${principal.tokenId}` : principal.userId, status, Date.now() - started, error, redact(args ?? {})],
        );
      }
    };
  };
  const meta = (name: string) => PLATFORM_TOOLS.find((t) => t.name === name)!;
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    "list_workflows",
    { description: meta("list_workflows").description, inputSchema: z.object({ status: z.enum(["draft", "active", "paused", "archived", "all"]).optional(), search: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() }), annotations: readOnly },
    guarded(meta("list_workflows"), (a: { status?: string; search?: string; limit?: number }) => listWorkflows(app, principal.workspaceId, a)),
  );

  server.registerTool(
    "get_workflow",
    { description: meta("get_workflow").description, inputSchema: z.object({ workflowId: z.string().max(64) }), annotations: readOnly },
    guarded(meta("get_workflow"), async (a: { workflowId: string }) => {
      const wf = await getWorkflow(app, principal.workspaceId, a.workflowId);
      const { webhook_key: _k, ...rest } = wf;
      return rest;
    }),
  );

  server.registerTool(
    "search_integrations",
    { description: meta("search_integrations").description, inputSchema: z.object({ query: z.string().max(200).optional() }), annotations: readOnly },
    guarded(meta("search_integrations"), async (a: { query?: string }) => {
      const q = (a.query ?? "").toLowerCase();
      const nodes = app.registry.nodeDefinitions();
      return app.registry
        .integrationDefinitions()
        .map((i) => ({ ...i, nodes: nodes.filter((n) => n.integration === i.id).map((n) => ({ type: n.type, name: n.name, kind: n.kind, description: n.description })) }))
        .filter((i) => !q || JSON.stringify(i).toLowerCase().includes(q));
    }),
  );

  server.registerTool(
    "get_action_schema",
    { description: meta("get_action_schema").description, inputSchema: z.object({ type: z.string().max(128) }), annotations: readOnly },
    guarded(meta("get_action_schema"), async (a: { type: string }) => {
      const def = app.registry.nodeDefinition(a.type);
      if (!def) throw new AppError(404, "not_found", `Unknown node type '${a.type}'.`);
      return def;
    }),
  );

  server.registerTool(
    "validate_workflow",
    { description: meta("validate_workflow").description, inputSchema: z.object({ workflowId: z.string().max(64).optional(), definition: z.record(z.string(), z.unknown()).optional() }), annotations: readOnly },
    guarded(meta("validate_workflow"), async (a: { workflowId?: string; definition?: unknown }) => {
      const def = a.definition ?? (a.workflowId ? (await getWorkflow(app, principal.workspaceId, a.workflowId)).draft_definition : undefined);
      if (!def) throw new AppError(400, "bad_request", "Provide workflowId or definition.");
      const { definition: _d, ...result } = await validateDefinition(app, principal, def, false);
      return result;
    }),
  );

  server.registerTool(
    "create_workflow_draft",
    {
      description: meta("create_workflow_draft").description,
      inputSchema: z.object({ name: z.string().min(1).max(200), description: z.string().max(4000).optional(), definition: z.record(z.string(), z.unknown()).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guarded(meta("create_workflow_draft"), async (a: { name: string; description?: string; definition?: unknown }) => {
      const wf = await createWorkflow(app, principal, a);
      const { definition: _d, ...validation } = await validateDefinition(app, principal, wf.draft_definition, false);
      return { workflowId: wf.id, status: wf.status, validation };
    }),
  );

  server.registerTool(
    "update_workflow_draft",
    {
      description: meta("update_workflow_draft").description,
      inputSchema: z.object({ workflowId: z.string().max(64), definition: z.record(z.string(), z.unknown()), name: z.string().max(200).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guarded(meta("update_workflow_draft"), async (a: { workflowId: string; definition: unknown; name?: string }) => {
      const res = await saveDraft(app, principal, a.workflowId, { definition: a.definition, name: a.name });
      const { definition: _d, ...validation } = res.validation;
      return { workflowId: a.workflowId, validation };
    }),
  );

  server.registerTool(
    "test_workflow",
    {
      description: meta("test_workflow").description,
      inputSchema: z.object({ workflowId: z.string().max(64), payload: z.unknown().optional(), simulateExternal: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded(meta("test_workflow"), async (a: { workflowId: string; payload?: unknown; simulateExternal?: boolean }) =>
      runWorkflow(app, principal, a.workflowId, { payload: a.payload, mode: "test", useMocks: a.simulateExternal !== false, source: "mcp" }),
    ),
  );

  server.registerTool(
    "get_execution_status",
    { description: meta("get_execution_status").description, inputSchema: z.object({ executionId: z.string().max(64) }), annotations: readOnly },
    guarded(meta("get_execution_status"), async (a: { executionId: string }) => {
      const e = await getExecution(app, principal.workspaceId, a.executionId);
      const { definition: _d, ...rest } = e;
      return rest;
    }),
  );

  server.registerTool(
    "get_execution_history",
    {
      description: meta("get_execution_history").description,
      inputSchema: z.object({ workflowId: z.string().max(64).optional(), status: z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]).optional(), limit: z.number().int().min(1).max(100).optional() }),
      annotations: readOnly,
    },
    guarded(meta("get_execution_history"), (a: { workflowId?: string; status?: string; limit?: number }) => listExecutions(app, principal.workspaceId, a)),
  );

  server.registerTool(
    "retry_execution",
    {
      description: meta("retry_execution").description,
      inputSchema: z.object({ executionId: z.string().max(64), strategy: z.enum(["failed_steps", "from_start"]).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded(meta("retry_execution"), (a: { executionId: string; strategy?: "failed_steps" | "from_start" }) => retryExecution(app, principal, a.executionId, a.strategy)),
  );

  server.registerTool(
    "list_available_tools",
    { description: meta("list_available_tools").description, inputSchema: z.object({}), annotations: readOnly },
    guarded(meta("list_available_tools"), async () =>
      PLATFORM_TOOLS.map((t) => {
        let allowed = true;
        try {
          requireScope(principal, t.scope);
          requireRole(principal, t.minRole);
        } catch {
          allowed = false;
        }
        return { name: t.name, scope: t.scope, description: t.description, allowed };
      }),
    ),
  );

  return server;
}
