import type { AppConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import type { Queryable } from "./db/index.ts";
import { queueStats } from "./engine/queue.ts";

/**
 * Startup checks for unsafe production configuration. Errors stop the
 * process; warnings are logged. Set ALLOW_UNSAFE_PRODUCTION_CONFIG=true only
 * for short-lived staging experiments.
 */
export function checkProductionConfig(config: AppConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (config.env !== "production") return { errors, warnings };
  if (!config.encryptionKey) errors.push("ENCRYPTION_KEY is required.");
  if (!config.publicUrl.startsWith("https://")) errors.push("PUBLIC_URL must use https:// in production (webhooks, OAuth redirects and secure cookies depend on it).");
  if (!config.secureCookies) errors.push("SECURE_COOKIES must be true in production.");
  if (!config.databaseUrl) errors.push("DATABASE_URL (PostgreSQL) is required in production; the embedded database is for local use only.");
  if (config.allowRegistration) warnings.push("ALLOW_REGISTRATION is true: anyone who can reach the site can create an account. Set it to false once your accounts exist, or use SSO.");
  if (!process.env.METRICS_TOKEN) warnings.push("METRICS_TOKEN is not set: /metrics is disabled.");
  if (process.env.OUTBOUND_ALLOW_PRIVATE === "true") warnings.push("OUTBOUND_ALLOW_PRIVATE is ignored in production.");
  if (process.env.ALLOW_UNSAFE_PRODUCTION_CONFIG === "true" && errors.length) {
    warnings.push(...errors.map((e) => `UNSAFE (allowed by ALLOW_UNSAFE_PRODUCTION_CONFIG): ${e}`));
    return { errors: [], warnings };
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// PostgreSQL-backed rate-limit store (shared by all API instances)

interface StoreResult {
  current: number;
  ttl: number;
}

export function createPgRateLimitStore(db: Queryable) {
  return class PgRateLimitStore {
    constructor(
      _options?: unknown,
      private readonly prefix = "global",
    ) {}

    incr(key: string, cb: (err: Error | null, res?: StoreResult) => void, timeWindow: number) {
      db.query<{ count: number; ttl: number }>(
        `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 1)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limits.window_start + ($2 || ' milliseconds')::interval <= now() THEN 1 ELSE rate_limits.count + 1 END,
           window_start = CASE WHEN rate_limits.window_start + ($2 || ' milliseconds')::interval <= now() THEN now() ELSE rate_limits.window_start END
         RETURNING count, GREATEST(0, EXTRACT(EPOCH FROM (window_start + ($2 || ' milliseconds')::interval - now())) * 1000)::int AS ttl`,
        [`${this.prefix}:${key}`.slice(0, 500), String(timeWindow)],
      )
        .then((rows) => cb(null, { current: rows[0]!.count, ttl: rows[0]!.ttl }))
        // Fail open: a database hiccup must not lock everyone out.
        .catch(() => cb(null, { current: 0, ttl: timeWindow }));
    }

    /** One counter namespace per route (the plugin passes the route as `routeInfo`). */
    child(params: { routeInfo?: { method?: string | string[]; url?: string; path?: string }; groupId?: string }) {
      const r = params.routeInfo ?? {};
      const route = params.groupId ?? `${[r.method ?? ""].flat().join(",")}:${r.url ?? r.path ?? ""}`;
      if (route === ":") throw new Error("Rate-limit store child() received no route information.");
      return new PgRateLimitStore(undefined, route);
    }
  };
}

// ---------------------------------------------------------------------------
// Prometheus metrics

const http = { total: new Map<string, number>(), durationSum: 0, durationCount: 0 };
const startedAt = Date.now();

export function recordHttp(method: string, status: number, durationMs: number): void {
  const key = `${method}|${Math.floor(status / 100)}xx`;
  http.total.set(key, (http.total.get(key) ?? 0) + 1);
  http.durationSum += durationMs / 1000;
  http.durationCount += 1;
}

function line(name: string, value: number, labels: Record<string, string> = {}): string {
  const l = Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`)
    .join(",");
  return `${name}${l ? `{${l}}` : ""} ${Number.isFinite(value) ? value : 0}`;
}

/** Prometheus text exposition of platform and process metrics. */
export async function renderMetrics(app: AppContext): Promise<string> {
  const out: string[] = [];
  const help = (name: string, type: string, text: string) => out.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`);

  help("automation_executions", "gauge", "Executions by status (last 24 hours).");
  for (const r of await app.db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM executions WHERE created_at > now() - interval '24 hours' GROUP BY status")) {
    out.push(line("automation_executions", r.n, { status: r.status }));
  }
  help("automation_jobs", "gauge", "Queue jobs by status.");
  for (const [status, n] of Object.entries(await queueStats(app.db))) out.push(line("automation_jobs", n, { status }));
  const lag = await app.db.one<{ s: number | null }>("SELECT EXTRACT(EPOCH FROM (now() - min(run_at)))::float AS s FROM jobs WHERE status = 'pending' AND run_at <= now()");
  help("automation_queue_lag_seconds", "gauge", "Age of the oldest due job.");
  out.push(line("automation_queue_lag_seconds", Math.max(0, lag?.s ?? 0)));
  const waiting = await app.db.one<{ n: number }>("SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'");
  help("automation_pending_approvals", "gauge", "Pending human approvals.");
  out.push(line("automation_pending_approvals", waiting?.n ?? 0));
  const ai = await app.db.one<{ t: number }>("SELECT COALESCE(sum(input_tokens + output_tokens), 0)::int AS t FROM ai_usage WHERE created_at > now() - interval '24 hours'");
  help("automation_ai_tokens_24h", "gauge", "AI tokens used in the last 24 hours.");
  out.push(line("automation_ai_tokens_24h", ai?.t ?? 0));
  const workflows = await app.db.one<{ n: number }>("SELECT count(*)::int AS n FROM workflows WHERE status = 'active'");
  help("automation_active_workflows", "gauge", "Active workflows.");
  out.push(line("automation_active_workflows", workflows?.n ?? 0));

  help("automation_http_requests_total", "counter", "HTTP requests handled by this instance.");
  for (const [key, n] of http.total) {
    const [method, status] = key.split("|") as [string, string];
    out.push(line("automation_http_requests_total", n, { method, status }));
  }
  help("automation_http_request_duration_seconds", "summary", "HTTP request duration.");
  out.push(line("automation_http_request_duration_seconds_sum", http.durationSum), line("automation_http_request_duration_seconds_count", http.durationCount));
  const mem = process.memoryUsage();
  help("process_resident_memory_bytes", "gauge", "Resident memory.");
  out.push(line("process_resident_memory_bytes", mem.rss));
  help("process_uptime_seconds", "gauge", "Process uptime.");
  out.push(line("process_uptime_seconds", Math.round((Date.now() - startedAt) / 1000)));
  return `${out.join("\n")}\n`;
}
