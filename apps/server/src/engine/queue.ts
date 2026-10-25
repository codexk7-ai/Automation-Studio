import type { Queryable } from "../db/index.ts";

/**
 * Durable PostgreSQL job queue. Jobs are claimed with
 * `FOR UPDATE SKIP LOCKED` and leased; a crashed worker's job becomes
 * claimable again when its lease expires (at-least-once delivery).
 */
export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type JobType = "execution.run" | "maintenance.cleanup";

export async function enqueue(
  db: Queryable,
  type: JobType,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; uniqueKey?: string; maxAttempts?: number } = {},
): Promise<number | null> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO jobs (type, payload, run_at, unique_key, max_attempts)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (unique_key) WHERE unique_key IS NOT NULL AND status IN ('pending', 'running') DO NOTHING
     RETURNING id`,
    [type, payload, opts.runAt ?? new Date(), opts.uniqueKey ?? null, opts.maxAttempts ?? 5],
  );
  return rows[0]?.id ?? null;
}

export async function claimJobs(db: Queryable, workerId: string, limit: number, leaseSeconds = 300): Promise<Job[]> {
  return db.query<Job>(
    `UPDATE jobs SET status = 'running', locked_by = $1, locked_until = now() + ($3 || ' seconds')::interval,
            attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE (status = 'pending' AND run_at <= now()) OR (status = 'running' AND locked_until < now())
       ORDER BY run_at, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, type, payload, attempts, max_attempts`,
    [workerId, limit, String(leaseSeconds)],
  );
}

export async function completeJob(db: Queryable, id: number): Promise<void> {
  await db.query("UPDATE jobs SET status = 'done', locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1", [id]);
}

/** Puts the job back in the queue for a later run without counting a failure. */
export async function rescheduleJob(db: Queryable, id: number, runAt: Date): Promise<void> {
  await db.query("UPDATE jobs SET status = 'pending', run_at = $2, attempts = GREATEST(attempts - 1, 0), locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1", [id, runAt]);
}

export async function failJob(db: Queryable, job: Job, error: string): Promise<void> {
  const exhausted = job.attempts >= job.max_attempts;
  const backoffMs = Math.min(60_000 * 2 ** (job.attempts - 1), 3_600_000);
  await db.query(
    `UPDATE jobs SET status = $2, last_error = $3, run_at = $4, locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1`,
    [job.id, exhausted ? "failed" : "pending", error.slice(0, 2000), new Date(Date.now() + backoffMs)],
  );
}

export async function extendLease(db: Queryable, id: number, workerId: string, leaseSeconds = 300): Promise<void> {
  await db.query("UPDATE jobs SET locked_until = now() + ($3 || ' seconds')::interval WHERE id = $1 AND locked_by = $2", [id, workerId, String(leaseSeconds)]);
}

export async function queueStats(db: Queryable): Promise<Record<string, number>> {
  const rows = await db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM jobs GROUP BY status");
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
