import { isTriggerType, type WorkflowDefinition } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import type { EventMeta } from "../integrations/types.ts";
import { startExecution, type ExecutionMode } from "./executions.ts";

/**
 * Dispatches an internal platform event (table record changes, form
 * submissions, execution failures, inbound provider webhooks) to every active
 * workflow in the workspace whose published trigger listens to it.
 */
export async function emitEvent(
  app: AppContext,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string; meta?: EventMeta; mode?: ExecutionMode } = {},
): Promise<string[]> {
  const triggerTypes = app.registry
    .nodeDefinitions()
    .filter((d) => d.kind === "trigger")
    .map((d) => app.registry.getNode(d.type)!)
    .filter((n) => n.events?.includes(eventType))
    .map((n) => n.type);
  if (!triggerTypes.length) return [];

  const candidates = await app.db.query<{ id: string; active_version_id: string; definition: WorkflowDefinition }>(
    `SELECT w.id, w.active_version_id, v.definition
     FROM workflows w JOIN workflow_versions v ON v.id = w.active_version_id
     WHERE w.workspace_id = $1 AND w.status = 'active' AND w.trigger_type = ANY($2::text[])`,
    [workspaceId, `{${triggerTypes.map((t) => `"${t}"`).join(",")}}`],
  );
  const started: string[] = [];
  for (const wf of candidates) {
    // A workflow never re-triggers itself through its own side effects (e.g. inserting into the table it watches).
    if (payload.sourceWorkflowId && payload.sourceWorkflowId === wf.id) continue;
    const trigger = wf.definition.nodes.find((n) => isTriggerType(n.type));
    const impl = trigger && app.registry.getNode(trigger.type);
    if (!trigger || !impl?.matchEvent) continue;
    const meta = { ...opts.meta };
    if (trigger.credentialId && meta.credentialId && trigger.credentialId !== meta.credentialId) continue;
    if (!impl.matchEvent(trigger.config, eventType, payload, meta)) continue;
    const res = await startExecution(app, {
      workspaceId,
      workflowId: wf.id,
      workflowVersionId: wf.active_version_id,
      definition: wf.definition,
      mode: opts.mode ?? "event",
      triggerData: { event: eventType, ...payload },
      dedupeKey: opts.dedupeKey ? `${eventType}:${opts.dedupeKey}` : null,
    });
    if (!res.duplicate) started.push(res.executionId);
  }
  return started;
}
