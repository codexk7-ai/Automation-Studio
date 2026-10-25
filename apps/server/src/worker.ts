import { createApp } from "./app.ts";

/**
 * Standalone execution worker (execution plane). Requires PostgreSQL
 * (DATABASE_URL); run several for horizontal scale. Jobs are claimed with
 * SKIP LOCKED so workers never process the same job concurrently.
 */
async function main() {
  const app = await createApp();
  if (!app.ctx.config.databaseUrl) {
    console.error("The standalone worker needs DATABASE_URL (PostgreSQL). With the embedded database, run the API with WORKER_MODE=embedded instead.");
    process.exit(1);
  }
  app.worker.start();
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
