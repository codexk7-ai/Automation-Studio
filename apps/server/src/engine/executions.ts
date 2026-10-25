import { isTriggerType, redact, truncateForStorage, type WorkflowDefinition } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { randomId } from "../security/crypto.ts";
import { enqueue } from "./queue.ts";

export type ExecutionMode = "manual" | "webhook" | "schedule" | "test" | "subworkflow" | "event" | "retry" | "mcp" | "poll" | "form";

export interface StartExecutionInput {
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string | null;
  definition: WorkflowDefinition;
  mode: ExecutionMode;
  triggerData: unknown;
  useMocks?: boolean;
  createdBy?: string | null;
  parentExecutionId?: string | null;
  retryOf?: string | null;
  /** Events with the same key within the workflow's dedupe window start only one execution. */
  dedupeKey?: string | null;
  /** Skip enqueueing (sub-workflows are run inline by the parent). */
  inline?: boolean;
}

export interface StartExecutionResult {
  executionId: string;
  duplicate: boolean;
}

/**
 * Creates the execution record, one step row per node and the run job in a
 * single transaction, then returns immediately. Workers advance it.
 */
export async function startExecution(app: AppContext, input: StartExecutionInput): Promise<StartExecutionResult> {
  const trigger = input.definition.nodes.find((n) => isTriggerType(n.type));
  if (!trigger) throw new Error("Workflow has no trigger");
  const executionId = randomId("exe");
  const triggerOutput = truncateForStorage(input.triggerData ?? {});
  const windowSeconds = input.definition.settings.dedupeWindowSeconds;

  const result = await app.db.transaction(async (tx) => {
    if (input.dedupeKey) {
      const key = input.dedupeKey.slice(0, 500);
      const inserted = await tx.query<{ execution_id: string }>(
        `INSERT INTO trigger_events (workflow_id, dedupe_key, execution_id) VALUES ($1, $2, $3)
         ON CONFLICT (workflow_id, dedupe_key) DO UPDATE SET execution_id = EXCLUDED.execution_id, created_at = now()
           WHERE trigger_events.created_at < now() - ($4 || ' seconds')::interval
         RETURNING execution_id`,
        [input.workflowId, key, executionId, String(windowSeconds)],
      );
      if (inserted.length === 0) {
        const existing = await tx.query<{ execution_id: string }>("SELECT execution_id FROM trigger_events WHERE workflow_id = $1 AND dedupe_key = $2", [input.workflowId, key]);
        return { executionId: existing[0]?.execution_id ?? "", duplicate: true };
      }
    }
    await tx.query(
      `INSERT INTO executions (id, workspace_id, workflow_id, workflow_version_id, definition, status, mode, use_mocks, trigger_data, parent_execution_id, retry_of, created_by)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10, $11)`,
      [
        executionId,
        input.workspaceId,
        input.workflowId,
        input.workflowVersionId,
        input.definition,
        input.mode,
        input.useMocks ?? false,
        redact(triggerOutput),
        input.parentExecutionId ?? null,
        input.retryOf ?? null,
        input.createdBy ?? null,
      ],
    );
    for (const node of input.definition.nodes) {
      const isTrigger = node.id === trigger.id;
      await tx.query(
        `INSERT INTO execution_steps (execution_id, node_id, status, attempt, output, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [executionId, node.id, isTrigger ? "succeeded" : "pending", isTrigger ? 1 : 0, isTrigger ? triggerOutput : null, isTrigger ? new Date() : null],
      );
    }
    if (!input.inline) await enqueue(tx, "execution.run", { executionId });
    return { executionId, duplicate: false };
  });
  if (!result.duplicate && !input.inline) app.notifyWork();
  return result;
}
