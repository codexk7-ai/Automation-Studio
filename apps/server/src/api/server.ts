import { existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { AppError, forbidden, StepError, unauthorized } from "../errors.ts";
import type { Principal } from "../auth/principal.ts";
import { firstWorkspaceFor, principalFromApiToken, resolveSession, roleIn } from "../services/accounts.ts";
import { createPgRateLimitStore, recordHttp, renderMetrics } from "../production.ts";
import { safeEqual } from "../security/crypto.ts";
import { registerApiRoutes } from "./routes.ts";
import { registerHookRoutes } from "./hooks.ts";
import { registerMcpRoute } from "./mcp.ts";

/** `__Host-` prefix (secure, host-only, path=/) whenever cookies are secure. */
export function sessionCookieName(config: { secureCookies: boolean }): string {
  return config.secureCookies ? "__Host-as_session" : "as_session";
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
    sessionInfo?: { sessionId: string; userId: string; workspaceId: string | null; csrf: string; token: string };
    rawBody?: string;
  }
}

/** Returns the authenticated principal or throws 401. */
export function need(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const OWN_SECRET_PATHS = new Set(["/metrics", "/api/internal/tick"]);
/** Paths owned by the API (everything else is the single-page app). */
const isApiPath = (url: string) => /^\/(api|hooks)(\/|\?|$)/.test(url) || /^\/mcp(\/|\?|$)/.test(url);

export interface ServerOptions {
  /** Serverless deployments: runs due schedules and queued jobs within a time budget (see /api/internal/tick). */
  tick?: (budgetMs: number) => Promise<{ processed: number }>;
}

export async function buildServer(app: AppContext, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    // Vercel's edge always sets X-Forwarded-For to the real client address.
    trustProxy: process.env.TRUST_PROXY === "true" || !!process.env.VERCEL,
  });

  // Keep the raw body (webhook signature verification) and parse JSON ourselves.
  server.removeContentTypeParser(["application/json", "text/plain"]);
  server.addContentTypeParser(["application/json", "application/*+json"], { parseAs: "string", bodyLimit: 12 * 1024 * 1024 }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, "invalid_json", "Request body is not valid JSON."), undefined);
    }
  });
  server.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  server.addContentTypeParser(["text/plain", "text/csv", "application/xml", "text/xml"], { parseAs: "string", bodyLimit: 12 * 1024 * 1024 }, (req, body, done) => {
    req.rawBody = body as string;
    done(null, body);
  });

  await server.register(cookie);
  await server.register(rateLimit, {
    global: true,
    max: 900,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.principal?.tokenId ?? req.principal?.userId ?? req.ip,
    // Several API instances share limits through PostgreSQL; the embedded database is single-process.
    ...(app.db.driver === "pg" ? { store: createPgRateLimitStore(app.db) as never } : {}),
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: { code: "rate_limited", message: `Too many requests. Retry in ${Math.ceil(ctx.ttl / 1000)}s.` } }),
  });

  // Security headers (CSP allows inline styles for the canvas library).
  server.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("x-frame-options", "DENY");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (!isApiPath(req.url)) {
      reply.header("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    }
    if (app.config.secureCookies) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    return payload;
  });

  // Authentication: bearer API token or session cookie (+ CSRF on unsafe methods).
  server.addHook("onRequest", async (req) => {
    const auth = req.headers.authorization;
    // /metrics and the queue tick use their own secrets, not API tokens.
    if (auth?.startsWith("Bearer ") && !OWN_SECRET_PATHS.has(req.url.split("?")[0]!)) {
      const p = await principalFromApiToken(app, auth.slice(7).trim(), req.ip);
      if (!p) throw unauthorized("Invalid or expired API token.");
      req.principal = p;
      return;
    }
    const token = req.cookies[sessionCookieName(app.config)];
    if (!token) return;
    const s = await resolveSession(app, token);
    if (!s) return;
    const workspaceId = s.workspaceId ?? (await firstWorkspaceFor(app, s.userId));
    if (!workspaceId) return;
    const role = await roleIn(app, s.userId, workspaceId);
    if (!role) return;
    req.sessionInfo = { ...s, workspaceId, token };
    req.principal = { actorType: "user", userId: s.userId, workspaceId, role, ip: req.ip };
    // Workspace policy: members must enroll in 2FA before using anything but the auth endpoints.
    if (req.url.startsWith("/api") && !req.url.startsWith("/api/auth/") && !req.url.startsWith("/api/meta")) {
      const policy = await app.db.one<{ required: boolean; enrolled: boolean }>(
        "SELECT COALESCE((w.settings->>'require2fa')::boolean, false) AS required, u.totp_enabled AS enrolled FROM workspaces w, users u WHERE w.id = $1 AND u.id = $2",
        [workspaceId, s.userId],
      );
      if (policy?.required && !policy.enrolled) throw new AppError(403, "mfa_enrollment_required", "This workspace requires two-factor authentication. Set it up in your account settings.");
    }
    if (!SAFE_METHODS.has(req.method) && req.url.startsWith("/api") && !req.url.startsWith("/api/auth/login") && !req.url.startsWith("/api/auth/register")) {
      const header = req.headers["x-csrf-token"];
      if (header !== s.csrf) throw forbidden("Missing or invalid CSRF token. Reload the page and try again.");
    }
  });

  // Access log (no query strings: they may carry tokens) and request metrics.
  server.addHook("onResponse", async (req, reply) => {
    const ms = reply.elapsedTime;
    recordHttp(req.method, reply.statusCode, ms);
    const path = req.url.split("?")[0]!;
    if (path === "/api/health" || path === "/metrics") return;
    app.log[reply.statusCode >= 500 ? "error" : "info"]("request", { method: req.method, path: path.replace(/\/hooks\/w\/[^/]+/, "/hooks/w/:key"), status: reply.statusCode, ms: Math.round(ms), actor: req.principal?.tokenId ?? req.principal?.userId ?? null });
  });

  // Serverless queue tick (Vercel Cron / scheduled GitHub Action), only with CRON_SECRET.
  server.get("/api/internal/tick", { config: { rateLimit: false } }, async (req, reply) => {
    const secret = process.env.CRON_SECRET;
    const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!opts.tick || !secret) return reply.status(404).send({ error: { code: "not_found", message: "Not found." } });
    if (!given || !safeEqual(given, secret)) return reply.status(401).send({ error: { code: "unauthorized", message: "Invalid tick secret." } });
    const budget = Math.max(1000, Number(process.env.TICK_BUDGET_MS ?? 45_000));
    const started = Date.now();
    const result = await opts.tick(budget);
    return { ok: true, processed: result.processed, ms: Date.now() - started };
  });

  // Prometheus metrics, only with METRICS_TOKEN (Authorization: Bearer <token>).
  server.get("/metrics", { config: { rateLimit: false } }, async (req, reply) => {
    const token = process.env.METRICS_TOKEN;
    const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!token || !given || !safeEqual(given, token)) return reply.status(token ? 401 : 404).send("not found");
    return reply.header("content-type", "text/plain; version=0.0.4").send(await renderMetrics(app));
  });

  server.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown; code?: string }, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      void reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof StepError) {
      const status = err.kind === "policy" || err.kind === "auth" ? 403 : err.kind === "config" ? 422 : err.retryable ? 502 : 400;
      void reply.status(status).send({ error: { code: err.kind, message: err.message } });
      return;
    }
    if (err.statusCode === 429) {
      void reply.status(429).send({ error: { code: "rate_limited", message: err.message } });
      return;
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      void reply.status(err.statusCode).send({ error: { code: err.code ?? "bad_request", message: err.message } });
      return;
    }
    app.log.error("unhandled request error", { method: req.method, url: req.url.split("?")[0], error: err.message, stack: err.stack?.split("\n").slice(0, 5).join(" | ") });
    void reply.status(500).send({ error: { code: "internal", message: "Something went wrong. The error was logged." } });
  });

  await registerApiRoutes(server, app);
  await registerHookRoutes(server, app);
  await registerMcpRoute(server, app);

  // Serve the built web app (single-page app fallback).
  const dist = app.config.webDistDir;
  if (existsSync(join(dist, "index.html"))) {
    await server.register(fastifyStatic, { root: dist, wildcard: false, index: false, maxAge: "1h" });
    server.setNotFoundHandler((req, reply) => {
      if ((req.method === "GET" || req.method === "HEAD") && !isApiPath(req.url)) {
        const file = req.url.split("?")[0]!;
        if (/\.[a-z0-9]+$/i.test(file) && existsSync(join(dist, file))) return reply.sendFile(file.slice(1));
        return reply.header("cache-control", "no-cache").sendFile("index.html");
      }
      return reply.status(404).send({ error: { code: "not_found", message: "Not found." } });
    });
  } else {
    server.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found", message: "Not found. (Web app not built: run `npm run build` or use `npm run dev`.)" } }));
  }
  return server;
}
