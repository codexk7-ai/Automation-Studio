import type { IncomingMessage, ServerResponse } from "node:http";
import { attachDatabasePool, getDeadline, waitUntil } from "@vercel/functions";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./api/server.ts";
import { createApp, type App } from "./app.ts";

/**
 * Vercel Function entry: one function serves /api, /hooks, /mcp and /metrics
 * (the web app is static on Vercel's CDN). There is no always-on worker:
 * queued work is drained right after the request that created it (waitUntil),
 * and /api/internal/tick (cron) picks up schedules, delays and retries.
 * Bodies reach Fastify untouched (Vercel helpers are disabled) so webhook
 * signatures verify against the exact bytes.
 */
process.env.NODE_ENV ||= "production";

/** Longest a background drain may run after a response (stays under maxDuration). */
const DRAIN_BUDGET_MS = Number(process.env.DRAIN_BUDGET_MS ?? 25_000);

let booting: Promise<{ app: App; server: FastifyInstance }> | null = null;
let draining: Promise<unknown> | null = null;
let again = false;

function boot() {
  booting ??= (async () => {
    const app = await createApp();
    if (app.ctx.db.pool) attachDatabasePool(app.ctx.db.pool as Parameters<typeof attachDatabasePool>[0]);
    // Instead of waking a worker loop, drain the queue in the background of the current invocation.
    app.ctx.notifyWork = () => {
      if (draining) {
        again = true;
        return;
      }
      draining = (async () => {
        do {
          again = false;
          await app.worker.drainFor(budget(DRAIN_BUDGET_MS)).catch((err: unknown) => app.ctx.log.error("background drain failed", { error: String(err) }));
        } while (again);
      })().finally(() => {
        draining = null;
      });
      waitUntil(draining);
    };
    const server = await buildServer(app.ctx, { tick: (ms) => app.worker.tick(budget(ms)) });
    await server.ready();
    return { app, server };
  })().catch((err: unknown) => {
    booting = null; // retry on the next request instead of caching a failed boot
    throw err;
  });
  return booting;
}

/** Caps a budget by the invocation's own deadline, leaving 5 s to finish up. */
function budget(ms: number): number {
  const deadline = getDeadline();
  return deadline ? Math.max(0, Math.min(ms, deadline.getTime() - Date.now() - 5000)) : ms;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let server: FastifyInstance;
  try {
    ({ server } = await boot());
  } catch (err) {
    console.error("startup failed", err);
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "unavailable", message: "The service is starting or misconfigured. Check the deployment logs." } }));
    return;
  }
  await new Promise<void>((resolve) => {
    res.on("finish", resolve);
    res.on("close", resolve);
    server.routing(req, res);
  });
}
