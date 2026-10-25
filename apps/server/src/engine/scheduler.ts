import { isTriggerType, type WorkflowDefinition } from "@automation-studio/core";
import { Cron } from "croner";
import type { AppContext } from "../context.ts";
import { loadCredential } from "../services/credentials.ts";
import { startExecution } from "./executions.ts";

export function cronFromConfig(config: Record<string, unknown>): { cron: string; timezone: string } {
  const timezone = String(config.timezone || "UTC");
  if (config.mode === "interval") {
    const minutes = Math.max(1, Math.min(1440, Number(config.intervalMinutes) || 60));
    if (minutes < 60) return { cron: `*/${minutes} * * * *`, timezone };
    const hours = Math.max(1, Math.round(minutes / 60));
    return { cron: `0 */${hours} * * *`, timezone };
  }
  return { cron: String(config.cron || "0 9 * * *"), timezone };
}

export function nextCronRun(cron: string, timezone: string, from = new Date()): Date | null {
  return new Cron(cron, { timezone, paused: true }).nextRun(from);
}

/** Validates a cron expression; returns an error message or null. */
export function validateCron(cron: string, timezone: string): string | null {
  try {
    const next = nextCronRun(cron, timezone);
    return next ? null : "Cron expression never fires.";
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Registers or removes the schedule/poll registration for a workflow after it
 * is published, paused, resumed or archived.
 */
export async function syncTriggerRegistration(app: AppContext, workflowId: string, workspaceId: string, definition: WorkflowDefinition | null): Promise<void> {
  const trigger = definition?.nodes.find((n) => isTriggerType(n.type));
  if (trigger?.type === "trigger.schedule") {
    const { cron, timezone } = cronFromConfig(trigger.config);
    const next = nextCronRun(cron, timezone);
    await app.db.query(
      `INSERT INTO workflow_schedules (workflow_id, workspace_id, cron, timezone, next_run_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workflow_id) DO UPDATE SET cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, next_run_at = EXCLUDED.next_run_at`,
      [workflowId, workspaceId, cron, timezone, next],
    );
  } else {
    await app.db.query("DELETE FROM workflow_schedules WHERE workflow_id = $1", [workflowId]);
  }
  const impl = trigger ? app.registry.getNode(trigger.type) : undefined;
  if (impl?.poll) {
    await app.db.query(
      `INSERT INTO trigger_state (workflow_id, next_poll_at) VALUES ($1, now())
       ON CONFLICT (workflow_id) DO UPDATE SET next_poll_at = now(), last_error = NULL`,
      [workflowId],
    );
  } else {
    await app.db.query("UPDATE trigger_state SET next_poll_at = NULL WHERE workflow_id = $1", [workflowId]);
  }
}

async function activeDefinition(app: AppContext, workflowId: string) {
  return app.db.one<{ workspace_id: string; active_version_id: string; definition: WorkflowDefinition }>(
    `SELECT w.workspace_id, w.active_version_id, v.definition FROM workflows w JOIN workflow_versions v ON v.id = w.active_version_id
     WHERE w.id = $1 AND w.status = 'active'`,
    [workflowId],
  );
}

/** Starts executions for due schedules. Safe with multiple schedulers (optimistic claim + dedupe key). */
export async function tickSchedules(app: AppContext): Promise<number> {
  const due = await app.db.query<{ workflow_id: string; cron: string; timezone: string; next_run_at: Date | string }>(
    `SELECT s.workflow_id, s.cron, s.timezone, s.next_run_at FROM workflow_schedules s JOIN workflows w ON w.id = s.workflow_id
     WHERE w.status = 'active' AND s.next_run_at IS NOT NULL AND s.next_run_at <= now() ORDER BY s.next_run_at LIMIT 50`,
  );
  let started = 0;
  for (const s of due) {
    const scheduledFor = new Date(s.next_run_at);
    // Skip missed runs older than the next occurrence instead of replaying a backlog.
    const next = nextCronRun(s.cron, s.timezone, new Date(Math.max(Date.now(), scheduledFor.getTime())));
    const claimed = await app.db.query("UPDATE workflow_schedules SET next_run_at = $3, last_run_at = now() WHERE workflow_id = $1 AND next_run_at = $2 RETURNING workflow_id", [
      s.workflow_id,
      scheduledFor,
      next,
    ]);
    if (!claimed.length) continue;
    const wf = await activeDefinition(app, s.workflow_id);
    if (!wf) continue;
    const res = await startExecution(app, {
      workspaceId: wf.workspace_id,
      workflowId: s.workflow_id,
      workflowVersionId: wf.active_version_id,
      definition: wf.definition,
      mode: "schedule",
      triggerData: { scheduledFor: scheduledFor.toISOString(), firedAt: new Date().toISOString(), cron: s.cron, timezone: s.timezone },
      dedupeKey: `schedule:${scheduledFor.toISOString()}`,
    });
    if (!res.duplicate) started++;
  }
  return started;
}

/** Runs due polling triggers (e.g. new YouTube uploads, new JSON feed items). */
export async function tickPolls(app: AppContext): Promise<number> {
  const due = await app.db.query<{ workflow_id: string; state: Record<string, unknown>; next_poll_at: string }>(
    `SELECT t.workflow_id, t.state, t.next_poll_at FROM trigger_state t JOIN workflows w ON w.id = t.workflow_id
     WHERE w.status = 'active' AND t.next_poll_at IS NOT NULL AND t.next_poll_at <= now() LIMIT 20`,
  );
  let started = 0;
  for (const row of due) {
    const wf = await activeDefinition(app, row.workflow_id);
    const trigger = wf?.definition.nodes.find((n) => isTriggerType(n.type));
    const impl = trigger ? app.registry.getNode(trigger.type) : undefined;
    if (!wf || !trigger || !impl?.poll) continue;
    const intervalMs = Math.max(60_000, (Number(trigger.config.pollMinutes) || 15) * 60_000);
    const claimed = await app.db.query("UPDATE trigger_state SET next_poll_at = $3 WHERE workflow_id = $1 AND next_poll_at = $2 RETURNING workflow_id", [
      row.workflow_id,
      new Date(row.next_poll_at),
      new Date(Date.now() + intervalMs),
    ]);
    if (!claimed.length) continue;
    try {
      const credential = trigger.credentialId ? await loadCredential(app, wf.workspace_id, trigger.credentialId) : undefined;
      const result = await impl.poll({ app, workspaceId: wf.workspace_id, workflowId: row.workflow_id, config: trigger.config, credential, state: row.state ?? {}, signal: AbortSignal.timeout(60_000) });
      for (const item of result.items.slice(0, 100)) {
        const res = await startExecution(app, {
          workspaceId: wf.workspace_id,
          workflowId: row.workflow_id,
          workflowVersionId: wf.active_version_id,
          definition: wf.definition,
          mode: "poll",
          triggerData: item.data,
          dedupeKey: `poll:${item.dedupeKey}`,
        });
        if (!res.duplicate) started++;
      }
      await app.db.query("UPDATE trigger_state SET state = $2, last_error = NULL, updated_at = now() WHERE workflow_id = $1", [row.workflow_id, result.state]);
    } catch (err) {
      app.log.warn("poll failed", { workflowId: row.workflow_id, error: (err as Error).message });
      await app.db.query("UPDATE trigger_state SET last_error = $2, updated_at = now() WHERE workflow_id = $1", [row.workflow_id, (err as Error).message.slice(0, 1000)]);
    }
  }
  return started;
}
