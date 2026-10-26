import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Loads KEY=VALUE pairs from .env files without overriding real env vars. */
function loadDotEnv(): void {
  for (const candidate of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      let value = m[2]!;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
    }
    break;
  }
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback;
}

export interface AppConfig {
  brandName: string;
  env: "development" | "production" | "test";
  host: string;
  port: number;
  publicUrl: string;
  /** postgres://... or empty for embedded PGlite. */
  databaseUrl: string;
  /** Directory for embedded PGlite data; "memory://" for in-memory. */
  pgliteDataDir: string;
  /** 32-byte key (base64 or hex) used for AES-256-GCM credential encryption. */
  encryptionKey: string;
  sessionTtlHours: number;
  secureCookies: boolean;
  /** "embedded" runs workers inside the API process; "off" requires `npm run worker`. */
  workerMode: "embedded" | "off";
  workerConcurrency: number;
  workerPollMs: number;
  allowRegistration: boolean;
  /** Login/registration attempts per IP per minute. */
  authRateLimitPerMinute: number;
  /** host:port entries exempt from private-network SSRF blocking (e.g. local Ollama). */
  outboundAllowlist: string[];
  smtp: { host: string; port: number; user: string; pass: string; from: string; secure: boolean } | null;
  defaultEmailFrom: string;
  google: { clientId: string; clientSecret: string } | null;
  /** OpenID Connect single sign-on (any compliant IdP: Google Workspace, Entra ID, Okta, Keycloak, Authentik…). */
  oidc: { issuer: string; clientId: string; clientSecret: string; allowedDomains: string[]; autoCreate: boolean; label: string } | null;
  webDistDir: string;
  logLevel: string;
  corsOrigins: string[];
}

/** On Vercel without PUBLIC_URL: the production domain, or the deployment URL for previews. */
function vercelUrl(): string {
  if (!process.env.VERCEL) return "";
  const host = process.env.VERCEL_ENV === "production" ? process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL : process.env.VERCEL_URL;
  return host ? `https://${host}` : "";
}

let cached: AppConfig | null = null;

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  if (cached && Object.keys(overrides).length === 0) return cached;
  loadDotEnv();
  const env = (process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development") as AppConfig["env"];
  const port = int(process.env.PORT, 8787);
  const encryptionKey = process.env.ENCRYPTION_KEY ?? "";
  const config: AppConfig = {
    brandName: process.env.BRAND_NAME || "Automation Studio",
    env,
    host: process.env.HOST || "127.0.0.1",
    port,
    publicUrl: (process.env.PUBLIC_URL || vercelUrl() || `http://localhost:${port}`).replace(/\/$/, ""),
    databaseUrl: process.env.DATABASE_URL || "",
    pgliteDataDir: process.env.PGLITE_DATA_DIR || resolve(process.cwd(), ".data/pglite"),
    encryptionKey,
    sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 24 * 7),
    secureCookies: bool(process.env.SECURE_COOKIES, env === "production"),
    workerMode: process.env.WORKER_MODE === "off" ? "off" : "embedded",
    workerConcurrency: Math.max(1, int(process.env.WORKER_CONCURRENCY, 4)),
    workerPollMs: Math.max(50, int(process.env.WORKER_POLL_MS, 500)),
    allowRegistration: bool(process.env.ALLOW_REGISTRATION, true),
    authRateLimitPerMinute: Math.max(1, int(process.env.AUTH_RATE_LIMIT_PER_MINUTE, 10)),
    outboundAllowlist: (process.env.OUTBOUND_ALLOWLIST ?? "localhost:11434,127.0.0.1:11434")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    smtp: process.env.SMTP_HOST
      ? {
          host: process.env.SMTP_HOST,
          port: int(process.env.SMTP_PORT, 587),
          user: process.env.SMTP_USER ?? "",
          pass: process.env.SMTP_PASS ?? "",
          from: process.env.SMTP_FROM ?? "",
          secure: bool(process.env.SMTP_SECURE, false),
        }
      : null,
    defaultEmailFrom: process.env.EMAIL_FROM || "Automation Studio <no-reply@localhost>",
    google: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } : null,
    oidc:
      process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID
        ? {
            issuer: process.env.OIDC_ISSUER.replace(/\/$/, ""),
            clientId: process.env.OIDC_CLIENT_ID,
            clientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
            allowedDomains: (process.env.OIDC_ALLOWED_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
            autoCreate: bool(process.env.OIDC_AUTO_CREATE_USERS, false),
            label: process.env.OIDC_BUTTON_LABEL || "Sign in with SSO",
          }
        : null,
    webDistDir: process.env.WEB_DIST_DIR || resolve(process.cwd(), "../web/dist"),
    logLevel: process.env.LOG_LEVEL || (env === "test" ? "silent" : "info"),
    corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ...overrides,
  };
  if (Object.keys(overrides).length === 0) cached = config;
  return config;
}
