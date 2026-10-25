import { buildServer } from "./api/server.ts";
import { createApp } from "./app.ts";

/** API server (control plane). Also runs the worker in-process when WORKER_MODE=embedded. */
async function main() {
  const app = await createApp();
  const { config, log } = app.ctx;
  if (config.workerMode === "embedded") {
    app.worker.start();
  } else if (!config.databaseUrl) {
    log.warn("WORKER_MODE=off with the embedded database: no worker can attach to PGlite from another process, so executions will not run.");
  }
  const server = await buildServer(app.ctx);
  await server.listen({ host: config.host, port: config.port });
  log.info(`${config.brandName} listening`, { url: `http://${config.host}:${config.port}`, publicUrl: config.publicUrl, database: app.ctx.db.driver, worker: config.workerMode });

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    await server.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
