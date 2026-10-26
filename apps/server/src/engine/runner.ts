import {
  buildGraph,
  isTriggerType,
  redact,
  renderValue,
  topologicalOrder,
  truncateForStorage,
  withDefaults,
  type ExpressionScope,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { normalizeError, StepError } from "../errors.ts";
import type { LoadedCredential, StepContext, StepResult, SubworkflowResult } from "../integrations/types.ts";
import { loadCredential, secretValues } from "../services/credentials.ts";
import { emitEvent } from "./events.ts";
import { startExecution } from "./executions.ts";

const TERMINAL = new Set(["succeeded", "failed", "skipped", "cancelled"]);
const LEASE_SECONDS = 300;
const MAX_SUBWORKFLOW_DEPTH = 3;

interface ExecutionRow {
  id: string;
  workspace_id: string;
  workflow_id: string;
  definition: WorkflowDefinition;
  status: string;
  mode: string;
  use_mocks: boolean;
  trigger_data: unknown;
  parent_execution_id: string | null;
  step_executions: number;
  cancel_requested: boolean;
  started_at: string | null;
  created_by: string | null;
}

interface StepRow {
  node_id: string;
  status: string;
  attempt: number;
  branch: string | null;
  halted: boolean;
  output: unknown;
  error: unknown;
  wait_state: unknown;
  next_attempt_at: string | null;
  logs: unknown[];
}

export interface RunOutcome {
  /** When the execution should be advanced again (delays, retry backoff). */
  rescheduleAt?: Date;
  status: string;
}

/**
 * Advances one execution as far as possible. Safe to call concurrently and
 * repeatedly: an execution lease guarantees a single active runner, and
 * completed steps are never re-executed. A step interrupted by a crash is
 * retried (at-least-once), counted as a new attempt.
 */
export async function runExecution(app: AppContext, executionId: string, workerId: string, depth = 0): Promise<RunOutcome> {
  const leased = await app.db.query<ExecutionRow>(
    `UPDATE executions SET lease_owner = $2, lease_until = now() + ($3 || ' seconds')::interval,
            status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
            started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE id = $1 AND status IN ('queued', 'running', 'waiting')
       AND (lease_until IS NULL OR lease_until < now() OR lease_owner = $2)
     RETURNING id, workspace_id, workflow_id, definition, status, mode, use_mocks, trigger_data, parent_execution_id, step_executions, cancel_requested, started_at, created_by`,
    [executionId, workerId, String(LEASE_SECONDS)],
  );
  const exec = leased[0];
  if (!exec) {
    const row = await app.db.one<{ status: string }>("SELECT status FROM executions WHERE id = $1", [executionId]);
    if (!row || TERMINAL.has(row.status)) return { status: row?.status ?? "missing" };
    // Another worker holds the lease; come back shortly so no wake-up is lost.
    return { status: row.status, rescheduleAt: new Date(Date.now() + 2000) };
  }
  try {
    return await advance(app, exec, workerId, depth);
  } finally {
    await app.db.query("UPDATE executions SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2", [executionId, workerId]);
  }
}

async function loadSteps(app: AppContext, executionId: string): Promise<Map<string, StepRow>> {
  const rows = await app.db.query<StepRow>(
    "SELECT node_id, status, attempt, branch, halted, output, error, wait_state, next_attempt_at, logs FROM execution_steps WHERE execution_id = $1",
    [executionId],
  );
  return new Map(rows.map((r) => [r.node_id, r]));
}

function buildScope(exec: ExecutionRow, def: WorkflowDefinition, steps: Map<string, StepRow>): ExpressionScope {
  const trigger = def.nodes.find((n) => isTriggerType(n.type))!;
  const stepScope: Record<string, unknown> = {};
  for (const [id, s] of steps) {
    if (s.status === "succeeded" || s.status === "failed") stepScope[id] = { output: s.output, status: s.status, branch: s.branch, error: s.error };
  }
  return {
    trigger: steps.get(trigger.id)?.output ?? {},
    steps: stepScope,
    vars: {},
    execution: { id: exec.id, mode: exec.mode, startedAt: exec.started_at, test: exec.use_mocks },
    workflow: { id: exec.workflow_id },
  };
}

async function advance(app: AppContext, exec: ExecutionRow, workerId: string, depth: number): Promise<RunOutcome> {
  const def = exec.definition;
  const nodes = new Map(def.nodes.map((n) => [n.id, n]));
  const graph = buildGraph(def);
  const { order } = topologicalOrder(def);
  const startedAt = exec.started_at ? Date.parse(exec.started_at) : Date.now();
  const log = app.log.child({ executionId: exec.id, workflowId: exec.workflow_id });
  let stepExecutions = exec.step_executions;

  for (let pass = 0; pass < 100_000; pass++) {
    const control = await app.db.one<{ cancel_requested: boolean; status: string }>("SELECT cancel_requested, status FROM executions WHERE id = $1", [exec.id]);
    if (!control || TERMINAL.has(control.status)) return { status: control?.status ?? "missing" };
    if (control.cancel_requested) return finish(app, exec, "cancelled", { message: "Execution was cancelled." });
    if (Date.now() - startedAt > def.settings.timeoutMs) {
      return finish(app, exec, "failed", { kind: "timeout", message: `Workflow exceeded its ${Math.round(def.settings.timeoutMs / 1000)}s timeout.` });
    }

    const steps = await loadSteps(app, exec.id);
    let earliestWake: number | undefined;
    let waitingForEvent = false;
    let progressed = false;

    for (const nodeId of order) {
      const node = nodes.get(nodeId)!;
      const step = steps.get(nodeId);
      if (!step || TERMINAL.has(step.status)) continue;

      if (step.status === "waiting") {
        const resumed = await tryResume(app, exec, node, step, steps, depth);
        if (resumed === "progressed") {
          progressed = true;
          break;
        }
        const until = (step.wait_state as { until?: string } | null)?.until;
        if (until) earliestWake = Math.min(earliestWake ?? Infinity, Date.parse(until));
        else waitingForEvent = true;
        continue;
      }

      // Parents must be resolved before a node can run.
      const incoming = graph.incoming.get(nodeId) ?? [];
      const parentsResolved = incoming.every((e) => TERMINAL.has(steps.get(e.source)?.status ?? "pending"));
      if (!parentsResolved) continue;

      if (step.status === "pending" && step.next_attempt_at && Date.parse(step.next_attempt_at) > Date.now()) {
        earliestWake = Math.min(earliestWake ?? Infinity, Date.parse(step.next_attempt_at));
        continue;
      }

      const active = incoming.some((e) => {
        const src = steps.get(e.source)!;
        if (src.halted) return false;
        if (src.status !== "succeeded" && !(src.status === "failed" && nodes.get(e.source)?.onError === "continue")) return false;
        return !e.branch || e.branch === src.branch;
      });
      if (!active || node.disabled) {
        await app.db.query("UPDATE execution_steps SET status = 'skipped', finished_at = now() WHERE execution_id = $1 AND node_id = $2", [exec.id, nodeId]);
        progressed = true;
        break;
      }

      stepExecutions++;
      if (stepExecutions > def.settings.maxStepExecutions) {
        return finish(app, exec, "failed", { kind: "limit", message: `Execution exceeded ${def.settings.maxStepExecutions} step executions.` });
      }
      await app.db.query("UPDATE executions SET step_executions = $2, status = 'running', updated_at = now() WHERE id = $1", [exec.id, stepExecutions]);
      const outcome = await executeStep(app, exec, node, step, steps, depth, workerId);
      if (outcome === "failed_execution") {
        const failed = (await loadSteps(app, exec.id)).get(nodeId);
        return finish(app, exec, "failed", { nodeId, ...(failed?.error as object) });
      }
      progressed = true;
      log.debug("step finished", { nodeId, outcome });
      break; // re-scan: new nodes may now be ready
    }

    if (progressed) continue;

    // Nothing runnable right now.
    const current = await loadSteps(app, exec.id);
    const open = [...current.values()].filter((s) => !TERMINAL.has(s.status));
    if (open.length === 0) {
      const failedStep = [...current.values()].find((s) => s.status === "failed" && nodes.get(s.node_id)?.onError !== "continue");
      return failedStep ? finish(app, exec, "failed", { nodeId: failedStep.node_id, ...(failedStep.error as object) }) : finish(app, exec, "succeeded", null);
    }
    const anyWaiting = open.some((s) => s.status === "waiting");
    await app.db.query("UPDATE executions SET status = $2, updated_at = now() WHERE id = $1", [exec.id, anyWaiting ? "waiting" : "running"]);
    if (earliestWake !== undefined) return { status: anyWaiting ? "waiting" : "running", rescheduleAt: new Date(Math.max(earliestWake, Date.now() + 50)) };
    if (waitingForEvent) return { status: "waiting" };
    // Defensive: unreachable pending nodes (should have been skipped).
    return finish(app, exec, "failed", { kind: "engine", message: "Execution stalled with unresolved steps." });
  }
  return finish(app, exec, "failed", { kind: "engine", message: "Execution exceeded the maximum number of scheduling passes." });
}

async function tryResume(app: AppContext, exec: ExecutionRow, node: WorkflowNode, step: StepRow, steps: Map<string, StepRow>, depth: number): Promise<"progressed" | "waiting"> {
  const impl = app.registry.getNode(node.type);
  if (!impl?.resume) return "waiting";
  const { ctx } = await buildStepContext(app, exec, node, step, steps, depth, new AbortController().signal);
  let result: StepResult | null;
  try {
    result = await impl.resume(ctx);
  } catch (err) {
    const e = normalizeError(err);
    await app.db.query("UPDATE execution_steps SET status = 'failed', error = $3, finished_at = now() WHERE execution_id = $1 AND node_id = $2", [exec.id, node.id, e.toJSON()]);
    return "progressed";
  }
  if (!result || "wait" in result) return "waiting";
  await app.db.query(
    "UPDATE execution_steps SET status = 'succeeded', output = $3, branch = $4, halted = $5, wait_state = NULL, finished_at = now() WHERE execution_id = $1 AND node_id = $2",
    [exec.id, node.id, truncateForStorage(result.output ?? null), result.branch ?? null, result.stop === true],
  );
  return "progressed";
}

async function buildStepContext(app: AppContext, exec: ExecutionRow, node: WorkflowNode, step: StepRow, steps: Map<string, StepRow>, depth: number, signal: AbortSignal) {
  const impl = app.registry.getNode(node.type);
  if (!impl) throw new StepError("config", `Unknown node type '${node.type}'.`);
  const scope = buildScope(exec, exec.definition, steps);
  const rawConfig = withDefaults(impl, node.config);
  const raw = new Set(impl.rawFields ?? []);
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawConfig)) config[k] = raw.has(k) ? v : renderValue(v, scope);

  let credential: LoadedCredential | undefined;
  if (node.credentialId) {
    credential = await loadCredential(app, exec.workspace_id, node.credentialId).catch(() => {
      throw new StepError("config", "The selected connection no longer exists or is not available in this workspace.");
    });
    if (impl.credentialType && credential.type !== impl.credentialType) throw new StepError("config", `Connection type '${credential.type}' does not match the required '${impl.credentialType}'.`);
  }
  const project = await app.db.one<{ project_id: string }>("SELECT project_id FROM workflows WHERE id = $1", [exec.workflow_id]);
  const logs: Array<{ time: string; message: string; data?: unknown }> = [];
  const ctx: StepContext = {
    app,
    workspaceId: exec.workspace_id,
    projectId: project?.project_id ?? "",
    workflowId: exec.workflow_id,
    executionId: exec.id,
    nodeId: node.id,
    node,
    config,
    rawConfig,
    scope,
    credential,
    useMocks: exec.use_mocks,
    attempt: step.attempt,
    signal,
    idempotencyKey: `${exec.id}:${node.id}`,
    waitState: step.wait_state ?? undefined,
    depth,
    render: (value, extra = {}) => renderValue(value, { ...scope, ...extra }),
    log: (message, data) => {
      if (logs.length < 200) logs.push({ time: new Date().toISOString(), message: message.slice(0, 2000), data });
    },
    runSubworkflow: (workflowId, input) => runSubworkflow(app, exec, workflowId, input, depth),
  };
  return { ctx, impl, logs };
}

type StepOutcome = "succeeded" | "skipped" | "waiting" | "retry_scheduled" | "failed_continue" | "failed_execution";

async function executeStep(app: AppContext, exec: ExecutionRow, node: WorkflowNode, step: StepRow, steps: Map<string, StepRow>, depth: number, workerId: string): Promise<StepOutcome> {
  const attempt = step.attempt + 1;
  const maxAttempts = node.retry?.maxAttempts ?? 1;
  await app.db.query(
    "UPDATE execution_steps SET status = 'running', attempt = $3, started_at = now(), next_attempt_at = NULL WHERE execution_id = $1 AND node_id = $2",
    [exec.id, node.id, attempt],
  );
  const attemptRow = await app.db.one<{ id: number }>("INSERT INTO step_attempts (execution_id, node_id, attempt, status) VALUES ($1, $2, $3, 'running') RETURNING id", [exec.id, node.id, attempt]);
  const started = Date.now();
  const controller = new AbortController();
  let knownSecrets: string[] = [];
  let logs: Array<{ time: string; message: string; data?: unknown }> = [];
  let inputForRecord: unknown = null;

  // Keep the execution lease alive during long steps.
  const heartbeat = setInterval(() => {
    app.db.query("UPDATE executions SET lease_until = now() + ($3 || ' seconds')::interval WHERE id = $1 AND lease_owner = $2", [exec.id, workerId, String(LEASE_SECONDS)]).catch(() => undefined);
  }, 60_000);

  try {
    const built = await buildStepContext(app, exec, node, { ...step, attempt }, steps, depth, controller.signal);
    const { ctx, impl } = built;
    logs = built.logs;
    knownSecrets = ctx.credential ? secretValues(ctx.credential.data, ctx.app.registry.getCredentialType(ctx.credential.type)?.fields) : [];
    inputForRecord = redactInput(impl.fields, ctx.config, knownSecrets);

    const simulate = impl.mode === "mock" || (exec.use_mocks && impl.sideEffects === "external" && !!impl.mock) || (!ctx.credential && impl.credentialRequired && exec.use_mocks && !!impl.mock);
    if (!simulate && impl.credentialRequired && !ctx.credential) {
      throw new StepError("config", `${node.name}: connect a ${impl.credentialType} account in Connections, or run a test with "Simulate external actions" enabled.`);
    }
    const timeoutMs = node.timeoutMs ?? impl.defaultTimeoutMs ?? 60_000;
    const run = simulate ? impl.mock!(ctx) : impl.execute(ctx);
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new StepError("timeout", `${node.name} timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));

    if ("wait" in result) {
      await app.db.query(
        "UPDATE execution_steps SET status = 'waiting', input = $3, wait_state = $4, logs = $5 WHERE execution_id = $1 AND node_id = $2",
        [exec.id, node.id, inputForRecord, { ...((result.wait.state as object) ?? {}), until: result.wait.until, reason: result.wait.reason }, logs],
      );
      await app.db.query("UPDATE step_attempts SET status = 'waiting', finished_at = now(), duration_ms = $2 WHERE id = $1", [attemptRow!.id, Date.now() - started]);
      return "waiting";
    }
    const output = truncateForStorage(knownSecrets.length ? redact(result.output ?? null, knownSecrets) : (result.output ?? null));
    await app.db.query(
      "UPDATE execution_steps SET status = 'succeeded', input = $3, output = $4, branch = $5, halted = $6, error = NULL, logs = $7, finished_at = now() WHERE execution_id = $1 AND node_id = $2",
      [exec.id, node.id, inputForRecord, output, result.branch ?? null, result.stop === true, logs],
    );
    await app.db.query("UPDATE step_attempts SET status = 'succeeded', finished_at = now(), duration_ms = $2 WHERE id = $1", [attemptRow!.id, Date.now() - started]);
    return "succeeded";
  } catch (err) {
    const e = normalizeError(err);
    const errorJson = redact({ ...e.toJSON(), attempt, maxAttempts }, knownSecrets) as Record<string, unknown>;
    await app.db.query("UPDATE step_attempts SET status = 'failed', error = $2, finished_at = now(), duration_ms = $3 WHERE id = $1", [attemptRow!.id, errorJson, Date.now() - started]);
    if (e.retryable && attempt < maxAttempts) {
      const policy = node.retry!;
      const backoff = e.retryAfterMs ?? Math.min(policy.backoffMs * policy.backoffMultiplier ** (attempt - 1), 3_600_000);
      await app.db.query(
        "UPDATE execution_steps SET status = 'pending', error = $3, input = $4, logs = $5, next_attempt_at = $6 WHERE execution_id = $1 AND node_id = $2",
        [exec.id, node.id, errorJson, inputForRecord, logs, new Date(Date.now() + backoff)],
      );
      return "retry_scheduled";
    }
    await app.db.query(
      "UPDATE execution_steps SET status = 'failed', error = $3, input = $4, logs = $5, finished_at = now() WHERE execution_id = $1 AND node_id = $2",
      [exec.id, node.id, errorJson, inputForRecord, logs],
    );
    return node.onError === "continue" ? "failed_continue" : "failed_execution";
  } finally {
    clearInterval(heartbeat);
  }
}

function redactInput(fields: { key: string; sensitive?: boolean }[], config: Record<string, unknown>, knownSecrets: string[]): unknown {
  const copy: Record<string, unknown> = { ...config };
  for (const f of fields) if (f.sensitive && copy[f.key] !== undefined) copy[f.key] = "[REDACTED]";
  return truncateForStorage(redact(copy, knownSecrets), 64_000);
}

async function finish(app: AppContext, exec: ExecutionRow, status: "succeeded" | "failed" | "cancelled", error: Record<string, unknown> | null): Promise<RunOutcome> {
  const updated = await app.db.query(
    `UPDATE executions SET status = $2, error = $3, finished_at = now(), updated_at = now() WHERE id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled') RETURNING id`,
    [exec.id, status, error],
  );
  if (status !== "succeeded") {
    await app.db.query(
      `UPDATE execution_steps SET status = CASE WHEN status = 'failed' THEN 'failed' ELSE '${status === "cancelled" ? "cancelled" : "skipped"}' END, finished_at = COALESCE(finished_at, now())
       WHERE execution_id = $1 AND status NOT IN ('succeeded', 'failed', 'skipped', 'cancelled')`,
      [exec.id],
    );
    await app.db.query("UPDATE approvals SET status = 'expired' WHERE execution_id = $1 AND status = 'pending'", [exec.id]);
  }
  if (updated.length && status === "failed" && exec.mode !== "test" && exec.mode !== "subworkflow") {
    const wf = await app.db.one<{ name: string; trigger_type: string | null }>("SELECT name, trigger_type FROM workflows WHERE id = $1", [exec.workflow_id]);
    // Failure-alert workflows never trigger on their own failures (no feedback loops).
    if (wf && wf.trigger_type !== "trigger.execution_failed") {
      await emitEvent(app, exec.workspace_id, "execution.failed", {
        executionId: exec.id,
        workflowId: exec.workflow_id,
        workflowName: wf.name,
        mode: exec.mode,
        error: redact(error),
        url: `${app.config.publicUrl}/executions/${exec.id}`,
      }, { dedupeKey: `failed:${exec.id}` }).catch((err: unknown) => app.log.warn("failure event dispatch failed", { error: String(err) }));
    }
  }
  return { status };
}

async function runSubworkflow(app: AppContext, parent: ExecutionRow, workflowId: string, input: unknown, depth: number): Promise<SubworkflowResult> {
  if (depth + 1 > MAX_SUBWORKFLOW_DEPTH) throw new StepError("config", `Sub-workflows can be nested at most ${MAX_SUBWORKFLOW_DEPTH} levels deep.`);
  const wf = await app.db.one<{ id: string; workspace_id: string; status: string; active_version_id: string | null; draft_definition: WorkflowDefinition }>(
    "SELECT id, workspace_id, status, active_version_id, draft_definition FROM workflows WHERE id = $1 AND workspace_id = $2",
    [workflowId, parent.workspace_id],
  );
  if (!wf) throw new StepError("config", "The selected sub-workflow does not exist in this workspace.");
  let definition: WorkflowDefinition;
  let versionId: string | null = null;
  if (wf.active_version_id) {
    const v = await app.db.one<{ id: string; definition: WorkflowDefinition }>("SELECT id, definition FROM workflow_versions WHERE id = $1", [wf.active_version_id]);
    if (!v) throw new StepError("config", "Sub-workflow version missing.");
    definition = v.definition;
    versionId = v.id;
  } else if (parent.use_mocks) {
    definition = wf.draft_definition; // test runs may call unpublished drafts
  } else {
    throw new StepError("config", "The sub-workflow has not been published yet.");
  }
  const { executionId } = await startExecution(app, {
    workspaceId: parent.workspace_id,
    workflowId,
    workflowVersionId: versionId,
    definition,
    mode: "subworkflow",
    triggerData: input,
    useMocks: parent.use_mocks,
    parentExecutionId: parent.id,
    inline: true,
  });
  const outcome = await runExecution(app, executionId, `inline:${parent.id}`, depth + 1);
  if (outcome.status === "waiting" || outcome.status === "running") {
    await app.db.query("UPDATE executions SET cancel_requested = TRUE WHERE id = $1", [executionId]);
    await runExecution(app, executionId, `inline:${parent.id}`, depth + 1);
    throw new StepError("config", "Sub-workflows called from a loop or workflow step cannot contain delays, approvals or retries with backoff.");
  }
  const steps = await loadSteps(app, executionId);
  const row = await app.db.one<{ error: unknown }>("SELECT error FROM executions WHERE id = $1", [executionId]);
  const order = topologicalOrder(definition).order;
  // The sub-workflow's result is the output of its last succeeded step.
  const lastSucceeded = [...order].reverse().find((id) => steps.get(id)?.status === "succeeded");
  return { executionId, status: outcome.status, output: lastSucceeded ? steps.get(lastSucceeded)?.output : null, error: row?.error ?? undefined };
}
