import { redact, type WorkflowDefinition } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { badRequest, notFound } from "../errors.ts";
import { startExecution } from "../engine/executions.ts";
import { enqueue } from "../engine/queue.ts";
import type { Principal } from "../auth/principal.ts";
import { authorize } from "../auth/principal.ts";
import { audit } from "./audit.ts";

export async function listExecutions(app: AppContext, workspaceId: string, q: { workflowId?: string; status?: string; mode?: string; limit?: number; offset?: number; since?: string } = {}) {
  const params: unknown[] = [workspaceId];
  const where = ["e.workspace_id = $1", "e.parent_execution_id IS NULL OR e.mode <> 'subworkflow'"];
  where[1] = `(${where[1]})`;
  if (q.workflowId) {
    params.push(q.workflowId);
    where.push(`e.workflow_id = $${params.length}`);
  }
  if (q.status) {
    params.push(q.status);
    where.push(`e.status = $${params.length}`);
  }
  if (q.mode) {
    params.push(q.mode);
    where.push(`e.mode = $${params.length}`);
  }
  if (q.since) {
    params.push(new Date(q.since));
    where.push(`e.created_at >= $${params.length}`);
  }
  const whereSql = where.join(" AND ");
  const [count] = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM executions e WHERE ${whereSql}`, params);
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  params.push(limit, offset);
  const items = await app.db.query(
    `SELECT e.id, e.workflow_id, w.name AS workflow_name, e.status, e.mode, e.use_mocks, e.error, e.step_executions, e.created_at, e.started_at, e.finished_at, e.retry_of, e.parent_execution_id,
       EXTRACT(EPOCH FROM (COALESCE(e.finished_at, now()) - COALESCE(e.started_at, e.created_at))) * 1000 AS duration_ms
     FROM executions e JOIN workflows w ON w.id = e.workflow_id
     WHERE ${whereSql} ORDER BY e.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: items.map((i) => redact(i)), total: count?.n ?? 0, limit, offset };
}

export async function getExecution(app: AppContext, workspaceId: string, id: string) {
  const e = await app.db.one<Record<string, unknown> & { definition: WorkflowDefinition }>(
    `SELECT e.*, w.name AS workflow_name FROM executions e JOIN workflows w ON w.id = e.workflow_id WHERE e.id = $1 AND e.workspace_id = $2`,
    [id, workspaceId],
  );
  if (!e) throw notFound("Execution");
  const steps = await app.db.query(
    "SELECT node_id, status, attempt, branch, halted, input, output, error, wait_state, next_attempt_at, logs, started_at, finished_at FROM execution_steps WHERE execution_id = $1",
    [id],
  );
  const attempts = await app.db.query("SELECT node_id, attempt, status, error, duration_ms, started_at, finished_at FROM step_attempts WHERE execution_id = $1 ORDER BY id", [id]);
  const children = await app.db.query("SELECT id, status, created_at FROM executions WHERE parent_execution_id = $1 ORDER BY created_at LIMIT 200", [id]);
  const approvals = await app.db.query("SELECT id, node_id, title, status, created_at, decided_at FROM approvals WHERE execution_id = $1", [id]);
  const { lease_owner: _lo, lease_until: _lu, ...rest } = e;
  return redact({ ...rest, steps, attempts, children, approvals }) as Record<string, unknown>;
}

export async function cancelExecution(app: AppContext, p: Principal, id: string) {
  authorize(p, "editor", "execute");
  const rows = await app.db.query<{ id: string }>(
    "UPDATE executions SET cancel_requested = TRUE, updated_at = now() WHERE id = $1 AND workspace_id = $2 AND status IN ('queued', 'running', 'waiting') RETURNING id",
    [id, p.workspaceId],
  );
  if (!rows.length) throw badRequest("Only queued, running or waiting executions can be cancelled.");
  await enqueue(app.db, "execution.run", { executionId: id });
  app.notifyWork();
  await audit(app, p, { workspaceId: p.workspaceId, action: "execution.cancel", resourceType: "execution", resourceId: id, ip: p.ip });
  return { id, cancelRequested: true };
}

/**
 * Retries a failed execution.
 * - `failed_steps` (default): resumes the same execution; steps that already
 *   succeeded are NOT re-run, so their side effects are not repeated.
 * - `from_start`: starts a new execution with the same trigger data.
 */
export async function retryExecution(app: AppContext, p: Principal, id: string, strategy: "failed_steps" | "from_start" = "failed_steps") {
  authorize(p, "editor", "execute");
  const e = await app.db.one<{ id: string; status: string; workflow_id: string; workflow_version_id: string | null; definition: WorkflowDefinition; trigger_data: unknown; use_mocks: boolean; mode: string }>(
    "SELECT id, status, workflow_id, workflow_version_id, definition, trigger_data, use_mocks, mode FROM executions WHERE id = $1 AND workspace_id = $2",
    [id, p.workspaceId],
  );
  if (!e) throw notFound("Execution");
  if (e.status !== "failed" && e.status !== "cancelled") throw badRequest("Only failed or cancelled executions can be retried.");
  if (strategy === "from_start") {
    const res = await startExecution(app, {
      workspaceId: p.workspaceId,
      workflowId: e.workflow_id,
      workflowVersionId: e.workflow_version_id,
      definition: e.definition,
      mode: "retry",
      triggerData: e.trigger_data,
      useMocks: e.use_mocks,
      createdBy: p.userId,
      retryOf: e.id,
    });
    await audit(app, p, { workspaceId: p.workspaceId, action: "execution.retry", resourceType: "execution", resourceId: id, details: { strategy, newExecutionId: res.executionId }, ip: p.ip });
    return { executionId: res.executionId, strategy };
  }
  await app.db.transaction(async (tx) => {
    // Failed steps and everything skipped/cancelled because of them become pending again.
    await tx.query(
      "UPDATE execution_steps SET status = 'pending', error = NULL, next_attempt_at = NULL, finished_at = NULL, attempt = 0 WHERE execution_id = $1 AND status IN ('failed', 'skipped', 'cancelled', 'running')",
      [id],
    );
    await tx.query("UPDATE executions SET status = 'queued', error = NULL, finished_at = NULL, cancel_requested = FALSE, started_at = now(), step_executions = 0, updated_at = now() WHERE id = $1", [id]);
    await enqueue(tx, "execution.run", { executionId: id });
  });
  app.notifyWork();
  await audit(app, p, { workspaceId: p.workspaceId, action: "execution.retry", resourceType: "execution", resourceId: id, details: { strategy }, ip: p.ip });
  return { executionId: id, strategy };
}

export async function decideApproval(app: AppContext, p: Principal, approvalId: string, decision: "approved" | "rejected", comment?: string) {
  authorize(p, "editor", "execute");
  const rows = await app.db.query<{ execution_id: string }>(
    "UPDATE approvals SET status = $3, comment = $4, decided_by = $5, decided_at = now() WHERE id = $1 AND workspace_id = $2 AND status = 'pending' AND (expires_at IS NULL OR expires_at > now()) RETURNING execution_id",
    [approvalId, p.workspaceId, decision, comment?.slice(0, 2000) ?? null, p.userId],
  );
  if (!rows.length) throw badRequest("This approval is no longer pending.");
  await enqueue(app.db, "execution.run", { executionId: rows[0]!.execution_id });
  app.notifyWork();
  await audit(app, p, { workspaceId: p.workspaceId, action: `approval.${decision}`, resourceType: "approval", resourceId: approvalId, ip: p.ip });
  return { id: approvalId, status: decision };
}

export async function listApprovals(app: AppContext, workspaceId: string, status = "pending") {
  return app.db.query(
    `SELECT a.id, a.execution_id, a.node_id, a.title, a.message, a.data, a.status, a.comment, a.created_at, a.decided_at, a.expires_at, w.name AS workflow_name, w.id AS workflow_id
     FROM approvals a JOIN executions e ON e.id = a.execution_id JOIN workflows w ON w.id = e.workflow_id
     WHERE a.workspace_id = $1 AND ($2 = 'all' OR a.status = $2) ORDER BY a.created_at DESC LIMIT 200`,
    [workspaceId, status],
  );
}
