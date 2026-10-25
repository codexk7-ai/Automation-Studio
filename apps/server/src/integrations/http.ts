import { toText } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { errorKindForStatus, parseRetryAfter, StepError } from "../errors.ts";
import { safeRequest } from "../security/ssrf.ts";
import type { IntegrationModule, LoadedCredential, NodeImplementation } from "./types.ts";

/** Builds auth headers from an `http_auth` connection. */
export function authHeadersFor(credential?: LoadedCredential): Record<string, string> {
  if (!credential || credential.type !== "http_auth") return {};
  const d = credential.data;
  switch (d.authType) {
    case "bearer":
      return { authorization: `Bearer ${toText(d.token)}` };
    case "basic":
      return { authorization: `Basic ${Buffer.from(`${toText(d.username)}:${toText(d.password)}`).toString("base64")}` };
    case "header":
      return d.headerName ? { [toText(d.headerName).toLowerCase()]: toText(d.headerValue) } : {};
    default:
      return {};
  }
}

function authQueryFor(credential?: LoadedCredential): Record<string, string> {
  if (credential?.type === "http_auth" && credential.data.authType === "query" && credential.data.queryParam) {
    return { [toText(credential.data.queryParam)]: toText(credential.data.headerValue) };
  }
  return {};
}

function parseBody(buf: Buffer, contentType: string, format: string): unknown {
  const text = buf.toString("utf8");
  if (format === "text") return text;
  if (format === "json" || contentType.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      if (format === "json") throw new StepError("permanent", "Response was not valid JSON.");
      return text;
    }
  }
  return text;
}

export interface ApiCallOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  json?: unknown;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Provider name for error messages. */
  provider: string;
}

/**
 * JSON API call used by SaaS connectors: SSRF-guarded, normalized errors
 * (429 -> rate_limit with Retry-After, 5xx -> transient, 401/403 -> auth).
 */
export async function apiCall<T = unknown>(app: AppContext, opts: ApiCallOptions): Promise<{ status: number; data: T; headers: Record<string, string> }> {
  const url = new URL(opts.url);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, toText(v));
  const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
  let body = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["content-type"] = "application/json";
  }
  const res = await safeRequest(app.fetch, url.toString(), { method: opts.method ?? "GET", headers, body, timeoutMs: opts.timeoutMs ?? 30_000, signal: opts.signal, maxBytes: 10_000_000 });
  const data = parseBody(res.body, res.headers["content-type"] ?? "", "auto");
  if (res.status >= 400) {
    const message = extractErrorMessage(data) ?? `HTTP ${res.status}`;
    throw new StepError(errorKindForStatus(res.status), `${opts.provider}: ${message}`, { status: res.status, response: truncate(data) }, parseRetryAfter(res.headers["retry-after"]));
  }
  return { status: res.status, data: data as T, headers: res.headers };
}

function extractErrorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return typeof data === "string" && data.length < 500 ? data : undefined;
  const d = data as Record<string, unknown>;
  const err = d.error as Record<string, unknown> | string | undefined;
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  if (typeof d.message === "string") return d.message;
  return undefined;
}

function truncate(v: unknown): unknown {
  const s = JSON.stringify(v ?? null);
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : v;
}

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((m) => ({ value: m, label: m }));

const httpRequest: NodeImplementation = {
  type: "http.request",
  integration: "http",
  kind: "action",
  name: "HTTP request",
  description: "Call any public HTTP API. Private network addresses are blocked unless allowlisted by an administrator.",
  credentialType: "http_auth",
  credentialRequired: false,
  sideEffects: "external",
  fields: [
    { key: "method", label: "Method", type: "select", default: "GET", options: HTTP_METHODS },
    { key: "url", label: "URL", type: "string", required: true, placeholder: "https://api.example.com/v1/items" },
    { key: "query", label: "Query parameters", type: "keyvalue" },
    { key: "headers", label: "Headers", type: "keyvalue" },
    {
      key: "bodyType",
      label: "Body",
      type: "select",
      default: "none",
      options: [
        { value: "none", label: "No body" },
        { value: "json", label: "JSON" },
        { value: "form", label: "Form (URL-encoded)" },
        { value: "text", label: "Raw text" },
      ],
    },
    { key: "body", label: "Body content", type: "json", showWhen: { key: "bodyType", equals: ["json", "form", "text"] } },
    {
      key: "responseFormat",
      label: "Parse response as",
      type: "select",
      default: "auto",
      options: [
        { value: "auto", label: "Auto-detect" },
        { value: "json", label: "JSON" },
        { value: "text", label: "Text" },
      ],
    },
    { key: "failOnHttpError", label: "Fail on 4xx/5xx responses", type: "boolean", default: true },
    { key: "followRedirects", label: "Follow redirects", type: "boolean", default: true },
    { key: "sendIdempotencyKey", label: "Send Idempotency-Key header", type: "boolean", default: false, description: "Lets supporting APIs ignore duplicate deliveries when a step is retried." },
    { key: "timeoutMs", label: "Timeout (ms)", type: "number", default: 30000, min: 1000, max: 300000 },
  ],
  sampleOutput: { status: 200, headers: { "content-type": "application/json" }, body: { id: 1 } },
  mode: "live",
  testable: true,
  defaultTimeoutMs: 310_000,
  async execute(ctx) {
    const method = String(ctx.config.method ?? "GET").toUpperCase();
    const url = new URL(toText(ctx.config.url));
    for (const [k, v] of Object.entries({ ...((ctx.config.query as Record<string, unknown>) ?? {}), ...authQueryFor(ctx.credential) })) url.searchParams.set(k, toText(v));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((ctx.config.headers as Record<string, unknown>) ?? {})) {
      if (!/^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(k)) throw new StepError("config", `Invalid header name '${k}'.`);
      headers[k.toLowerCase()] = toText(v).replace(/[\r\n]/g, "");
    }
    Object.assign(headers, authHeadersFor(ctx.credential));
    if (ctx.config.sendIdempotencyKey) headers["idempotency-key"] = ctx.idempotencyKey;
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      if (ctx.config.bodyType === "json") {
        body = typeof ctx.config.body === "string" ? ctx.config.body : JSON.stringify(ctx.config.body ?? {});
        headers["content-type"] ??= "application/json";
      } else if (ctx.config.bodyType === "form") {
        body = new URLSearchParams(Object.entries((ctx.config.body as Record<string, unknown>) ?? {}).map(([k, v]) => [k, toText(v)])).toString();
        headers["content-type"] ??= "application/x-www-form-urlencoded";
      } else if (ctx.config.bodyType === "text") {
        body = toText(ctx.config.body);
        headers["content-type"] ??= "text/plain";
      }
    }
    ctx.log(`${method} ${url.origin}${url.pathname}`);
    const res = await safeRequest(ctx.app.fetch, url.toString(), {
      method,
      headers,
      body,
      timeoutMs: Number(ctx.config.timeoutMs) || 30_000,
      signal: ctx.signal,
      followRedirects: ctx.config.followRedirects !== false,
      maxBytes: 10_000_000,
    });
    const parsed = method === "HEAD" ? null : parseBody(res.body, res.headers["content-type"] ?? "", String(ctx.config.responseFormat ?? "auto"));
    const output = { status: res.status, headers: res.headers, body: parsed, url: res.url, truncated: res.truncated };
    if (res.status >= 400 && ctx.config.failOnHttpError !== false) {
      throw new StepError(errorKindForStatus(res.status), `HTTP ${res.status} from ${url.host}`, { status: res.status, body: truncate(parsed) }, parseRetryAfter(res.headers["retry-after"]));
    }
    return { output };
  },
  async mock(ctx) {
    return { output: { status: 200, headers: { "content-type": "application/json" }, body: { mocked: true, url: toText(ctx.config.url) }, _mock: true } };
  },
};

export const httpIntegration: IntegrationModule = {
  definition: {
    id: "http",
    name: "HTTP / REST API",
    description: "Generic HTTP requests to any public API with optional authentication.",
    category: "Developer",
    version: "1.0.0",
    icon: "globe",
    credentialTypes: ["http_auth"],
    prerequisites: ["Access to the target API (and its terms, quotas and pricing)."],
    availability: "live+mock",
  },
  nodes: [httpRequest],
  credentialTypes: [
    {
      id: "http_auth",
      name: "HTTP authentication",
      description: "Bearer token, basic auth, API key header or query parameter.",
      fields: [
        {
          key: "authType",
          label: "Type",
          type: "select",
          required: true,
          default: "bearer",
          options: [
            { value: "bearer", label: "Bearer token" },
            { value: "basic", label: "Basic auth" },
            { value: "header", label: "API key header" },
            { value: "query", label: "API key query parameter" },
          ],
        },
        { key: "token", label: "Token", type: "string", sensitive: true, showWhen: { key: "authType", equals: ["bearer"] } },
        { key: "username", label: "Username", type: "string", showWhen: { key: "authType", equals: ["basic"] } },
        { key: "password", label: "Password", type: "string", sensitive: true, showWhen: { key: "authType", equals: ["basic"] } },
        { key: "headerName", label: "Header name", type: "string", placeholder: "X-API-Key", showWhen: { key: "authType", equals: ["header"] } },
        { key: "queryParam", label: "Query parameter", type: "string", placeholder: "api_key", showWhen: { key: "authType", equals: ["query"] } },
        { key: "headerValue", label: "API key", type: "string", sensitive: true, showWhen: { key: "authType", equals: ["header", "query"] } },
      ],
    },
  ],
};
