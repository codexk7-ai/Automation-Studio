import type { AppConfig } from "./config.ts";
import type { Db } from "./db/index.ts";
import type { IntegrationRegistry } from "./integrations/registry.ts";
import type { Logger } from "./logger.ts";
import type { SecretBox } from "./security/crypto.ts";
import type { createSafeFetch, NetworkPolicy } from "./security/ssrf.ts";

export type SafeFetch = ReturnType<typeof createSafeFetch>;

/** Process-wide dependencies shared by the API, workers and MCP server. */
export interface AppContext {
  config: AppConfig;
  db: Db;
  secrets: SecretBox;
  log: Logger;
  policy: NetworkPolicy;
  /** SSRF-guarded fetch for all user-configurable outbound requests. */
  fetch: SafeFetch;
  registry: IntegrationRegistry;
  /** Wakes the embedded worker early (best-effort; jobs are durable regardless). */
  notifyWork(): void;
}
