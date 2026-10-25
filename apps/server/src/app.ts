import { loadConfig, type AppConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { createDb, type Db } from "./db/index.ts";
import { migrate } from "./db/migrate.ts";
import { Worker } from "./engine/worker.ts";
import { createRegistry } from "./integrations/index.ts";
import { createLogger } from "./logger.ts";
import { generateEncryptionKey, SecretBox } from "./security/crypto.ts";
import { createSafeFetch, type NetworkPolicy } from "./security/ssrf.ts";

export interface App {
  ctx: AppContext;
  worker: Worker;
  close(): Promise<void>;
}

/**
 * Builds the shared application context. Fails fast on an unsafe production
 * configuration (missing encryption key).
 */
export async function createApp(overrides: Partial<AppConfig> = {}, opts: { db?: Db; runMigrations?: boolean } = {}): Promise<App> {
  const config = loadConfig(overrides);
  const log = createLogger(config.logLevel, { service: "automation-studio" });
  let key = config.encryptionKey;
  if (!key) {
    if (config.env === "production") throw new Error("ENCRYPTION_KEY is required in production. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    key = generateEncryptionKey();
    log.warn("ENCRYPTION_KEY is not set: using a temporary key. Saved connections will be unreadable after a restart. Run `npm run setup` or set ENCRYPTION_KEY in .env.");
  }
  const db = opts.db ?? (await createDb(config));
  if (opts.runMigrations !== false) {
    const res = await migrate(db);
    if (res.applied.length) log.info("database migrated", { applied: res.applied });
  }
  const policy: NetworkPolicy = { allowlist: config.outboundAllowlist, allowPrivate: process.env.OUTBOUND_ALLOW_PRIVATE === "true" && config.env !== "production" };
  let worker: Worker | null = null;
  const ctx: AppContext = {
    config,
    db,
    secrets: new SecretBox(key),
    log,
    policy,
    fetch: createSafeFetch(policy),
    registry: createRegistry(),
    notifyWork: () => worker?.notify(),
  };
  worker = new Worker(ctx, { concurrency: config.workerConcurrency, pollMs: config.workerPollMs });
  const w = worker;
  return {
    ctx,
    worker: w,
    async close() {
      await w.stop();
      await db.close();
    },
  };
}
