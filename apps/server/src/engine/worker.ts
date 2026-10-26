import { hostname } from "node:os";
import type { AppContext } from "../context.ts";
import { randomToken } from "../security/crypto.ts";
import { claimJobs, completeJob, failJob, rescheduleJob, type Job } from "./queue.ts";
import { runExecution } from "./runner.ts";
import { tickPolls, tickSchedules } from "./scheduler.ts";

/**
 * Background worker: claims jobs from the durable queue, advances executions,
 * fires schedules and polling triggers, and performs maintenance. Runs either
 * embedded in the API process or standalone (`npm run worker`).
 */
export class Worker {
  readonly id = `${hostname()}:${process.pid}:${randomToken(4)}`;
  private running = false;
  private inflight = new Set<Promise<void>>();
  private wake: (() => void) | null = null;
  private lastTick = 0;
  private lastMaintenance = 0;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly app: AppContext,
    private readonly opts: { concurrency: number; pollMs: number; tickMs?: number },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
    this.app.log.info("worker started", { workerId: this.id, concurrency: this.opts.concurrency });
  }

  notify(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loopPromise;
    await Promise.allSettled([...this.inflight]);
  }

  /** Processes everything currently due (used by tests and the CLI). */
  async drain(maxRounds = 200): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      await this.periodic(true);
      const jobs = await claimJobs(this.app.db, this.id, this.opts.concurrency);
      if (!jobs.length) return;
      await Promise.all(jobs.map((j) => this.handle(j)));
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.periodic(false);
        const free = this.opts.concurrency - this.inflight.size;
        if (free > 0) {
          const jobs = await claimJobs(this.app.db, this.id, free);
          for (const job of jobs) {
            const p = this.handle(job).finally(() => this.inflight.delete(p));
            this.inflight.add(p);
          }
          if (jobs.length === free) continue;
        }
      } catch (err) {
        this.app.log.error("worker loop error", { error: (err as Error).message });
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.opts.pollMs);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  private async periodic(force: boolean): Promise<void> {
    const now = Date.now();
    if (force || now - this.lastTick >= (this.opts.tickMs ?? 5000)) {
      this.lastTick = now;
      await tickSchedules(this.app).catch((err: unknown) => this.app.log.error("schedule tick failed", { error: String(err) }));
      await tickPolls(this.app).catch((err: unknown) => this.app.log.error("poll tick failed", { error: String(err) }));
    }
    if (now - this.lastMaintenance >= 600_000) {
      this.lastMaintenance = now;
      await maintenance(this.app).catch((err: unknown) => this.app.log.error("maintenance failed", { error: String(err) }));
    }
  }

  private async handle(job: Job): Promise<void> {
    try {
      if (job.type === "execution.run") {
        const executionId = String(job.payload.executionId);
        const outcome = await runExecution(this.app, executionId, this.id);
        if (outcome.rescheduleAt) await rescheduleJob(this.app.db, job.id, outcome.rescheduleAt);
        else await completeJob(this.app.db, job.id);
        if (outcome.rescheduleAt && outcome.rescheduleAt.getTime() - Date.now() < this.opts.pollMs) setTimeout(() => this.notify(), Math.max(0, outcome.rescheduleAt.getTime() - Date.now()));
      } else if (job.type === "maintenance.cleanup") {
        await maintenance(this.app);
        await completeJob(this.app.db, job.id);
      } else {
        await failJob(this.app.db, { ...job, attempts: job.max_attempts }, `Unknown job type ${job.type}`);
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.app.log.error("job failed", { jobId: job.id, type: job.type, error: message });
      await failJob(this.app.db, job, message);
      if (job.type === "execution.run" && job.attempts >= job.max_attempts) {
        await this.app.db.query(
          "UPDATE executions SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled')",
          [String(job.payload.executionId), { kind: "engine", message: `Engine error: ${message.slice(0, 500)}` }],
        );
      }
    }
  }
}

/** Retention and housekeeping. */
export async function maintenance(app: AppContext): Promise<void> {
  await app.db.query("DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '1 day'");
  await app.db.query("DELETE FROM sessions WHERE expires_at < now()");
  await app.db.query("DELETE FROM oauth_states WHERE expires_at < now()");
  await app.db.query("DELETE FROM oidc_states WHERE expires_at < now()");
  await app.db.query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
  await app.db.query("DELETE FROM trigger_events WHERE created_at < now() - interval '30 days'");
  // Approval timeouts: expire and let the runner resolve the waiting step.
  const expired = await app.db.query<{ execution_id: string }>("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < now() RETURNING execution_id");
  for (const e of expired) {
    await app.db.query("INSERT INTO jobs (type, payload) VALUES ('execution.run', $1)", [{ executionId: e.execution_id }]);
  }
  // Table retention policies.
  await app.db.query(
    `DELETE FROM data_rows r USING data_tables t WHERE r.table_id = t.id AND t.retention_days IS NOT NULL AND r.created_at < now() - (t.retention_days || ' days')::interval`,
  );
  // Execution history retention (workspace setting, default 90 days).
  await app.db.query(
    `DELETE FROM executions e USING workspaces w WHERE e.workspace_id = w.id AND e.status IN ('succeeded', 'failed', 'cancelled')
       AND e.finished_at < now() - (COALESCE((w.settings->>'executionRetentionDays')::int, 90) || ' days')::interval`,
  );
}
