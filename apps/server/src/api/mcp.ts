import { Readable } from "node:stream";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import type { Principal } from "../auth/principal.ts";
import { buildMcpServer } from "../mcp/server.ts";

/**
 * Streamable HTTP MCP endpoint at /mcp. Requires an API token
 * (`Authorization: Bearer as_…`); the token's scopes and its owner's current
 * role decide which tools succeed. Session cookies are not accepted here.
 */
export async function registerMcpRoute(server: FastifyInstance, app: AppContext): Promise<void> {
  const principals = new WeakMap<object, Principal>();
  const handler = createMcpHandler((ctx) => {
    const p = ctx.authInfo ? principals.get(ctx.authInfo) : undefined;
    if (!p) throw new Error("Unauthenticated MCP request");
    return buildMcpServer(app, p);
  });

  server.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    handler: async (req, reply) => {
      const p = req.principal;
      if (!p || p.actorType !== "api_token") {
        return reply
          .status(401)
          .header("www-authenticate", 'Bearer realm="automation-studio"')
          .send({ jsonrpc: "2.0", error: { code: -32001, message: "An API token is required (Authorization: Bearer as_…)." }, id: null });
      }
      const origin = req.headers.origin;
      if (origin && !app.config.corsOrigins.includes(origin) && new URL(app.config.publicUrl).origin !== origin) {
        return reply.status(403).send({ jsonrpc: "2.0", error: { code: -32002, message: "Origin not allowed." }, id: null });
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      }
      const url = `${app.config.publicUrl}${req.url}`;
      const request = new Request(url, { method: req.method, headers, body: req.method === "POST" ? (req.rawBody ?? JSON.stringify(req.body ?? null)) : undefined });
      const authInfo = { token: "redacted", clientId: p.tokenId ?? "token", scopes: p.scopes ?? [] };
      principals.set(authInfo, p);
      const response = await handler.fetch(request, { authInfo, parsedBody: req.body });
      reply.hijack();
      const raw = reply.raw;
      raw.statusCode = response.status;
      response.headers.forEach((value, key) => raw.setHeader(key, value));
      if (!response.body) {
        raw.end();
        return;
      }
      const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      req.raw.on("close", () => stream.destroy());
      stream.pipe(raw);
    },
  });
}
