import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createApp } from "../app.ts";
import { buildMcpServer } from "../mcp/server.ts";
import { principalFromApiToken } from "../services/accounts.ts";

/**
 * stdio transport for MCP clients that cannot use HTTP. Authenticates with an
 * API token from AUTOMATION_STUDIO_TOKEN. Opens the database directly, so with
 * the embedded database (PGlite) it must not run while the API server runs —
 * prefer the HTTP endpoint (/mcp) in that setup. Logs go to stderr only.
 */
async function main() {
  const token = process.env.AUTOMATION_STUDIO_TOKEN ?? "";
  process.env.LOG_LEVEL ??= "warn";
  const app = await createApp();
  const principal = await principalFromApiToken(app.ctx, token);
  if (!principal) {
    process.stderr.write("AUTOMATION_STUDIO_TOKEN is missing, revoked or invalid. Create a token under Team & API.\n");
    process.exit(1);
  }
  // Executions started over stdio are processed by this process's worker too.
  if (app.ctx.config.workerMode === "embedded") app.worker.start();
  serveStdio(() => buildMcpServer(app.ctx, principal));
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
