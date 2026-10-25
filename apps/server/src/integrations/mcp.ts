import { toText } from "@automation-studio/core";
import { StepError } from "../errors.ts";
import { callExternalTool } from "../mcp/client.ts";
import type { IntegrationModule, NodeImplementation } from "./types.ts";

const callTool: NodeImplementation = {
  type: "mcp.call_tool",
  integration: "mcp",
  kind: "action",
  name: "Call MCP tool",
  description: "Call a tool on a registered external MCP server. Only tools an administrator enabled can be called; arguments are validated against the tool's schema.",
  sideEffects: "external",
  fields: [
    { key: "serverId", label: "MCP server", type: "mcp_server", required: true, allowExpressions: false },
    { key: "tool", label: "Tool name", type: "string", required: true, allowExpressions: false },
    { key: "arguments", label: "Arguments", type: "json", default: {} },
    { key: "failOnToolError", label: "Fail when the tool reports an error", type: "boolean", default: true },
  ],
  sampleOutput: { isError: false, text: "Tool result text", structured: null },
  mode: "live",
  testable: true,
  defaultTimeoutMs: 130_000,
  async execute(ctx) {
    const args = ctx.config.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args)) throw new StepError("config", "Arguments must be a JSON object.");
    const r = await callExternalTool(ctx.app, ctx.workspaceId, String(ctx.config.serverId), toText(ctx.config.tool), args as Record<string, unknown>, {
      executionId: ctx.executionId,
      actor: `execution:${ctx.executionId}`,
      purpose: "workflow",
      signal: ctx.signal,
    });
    if (r.isError && ctx.config.failOnToolError !== false) throw new StepError("permanent", `Tool reported an error: ${r.text.slice(0, 500)}`);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(r.text);
    } catch {
      /* text result */
    }
    return { output: { isError: r.isError, text: r.text, json: parsed, structured: r.structured ?? null } };
  },
  async mock(ctx) {
    return { output: { isError: false, text: `[mock] ${toText(ctx.config.tool)} not called in test run`, json: null, structured: null, _mock: true } };
  },
};

export const mcpIntegration: IntegrationModule = {
  definition: {
    id: "mcp",
    name: "MCP servers",
    description: "Call tools on external Model Context Protocol servers you register.",
    category: "AI",
    version: "1.0.0",
    icon: "plug",
    credentialTypes: ["http_auth"],
    prerequisites: ["A reachable MCP server (Streamable HTTP transport) and, if required, its access token."],
    availability: "live+mock",
  },
  nodes: [callTool],
};
