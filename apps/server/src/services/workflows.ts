import {
  ancestorsOf,
  isTriggerType,
  redact,
  validateWorkflow,
  workflowDefinitionSchema,
  workflowExportSchema,
  type ValidationResult,
  type WorkflowDefinition,
  type WorkflowStatus,
} from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { AppError, badRequest, notFound } from "../errors.ts";
import { startExecution, type ExecutionMode } from "../engine/executions.ts";
import { runExecution } from "../engine/runner.ts";
import { syncTriggerRegistration, validateCron, cronFromConfig } from "../engine/scheduler.ts";
import { randomId, randomToken } from "../security/crypto.ts";
import type { Principal } from "../auth/principal.ts";
import { authorize, requireScope } from "../auth/principal.ts";
import { audit } from "./audit.ts";
import { credentialTypeMap } from "./credentials.ts";

export interface WorkflowRow {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  draft_definition: WorkflowDefinition;
  draft_updated_at: string;
  active_version_id: string | null;
  trigger_type: string | null;
  webhook_key: string | null;
  template_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function defaultDefinition(): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    schemaVersion: 1,
    nodes: [{ id: "trigger", type: "trigger.manual", name: "Manual trigger", config: {}, position: { x: 300, y: 40 } }],
    edges: [],
  });
}

export async function getWorkflow(app: AppContext, workspaceId: string, id: string): Promise<WorkflowRow> {
  const wf = await app.db.one<WorkflowRow>("SELECT * FROM workflows WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  if (!wf) throw notFound("Workflow");
  return wf;
}

export async function listWorkflows(app: AppContext, workspaceId: string, q: { status?: string; search?: string; projectId?: string; limit?: number; offset?: number } = {}) {
  const params: unknown[] = [workspaceId];
  const where = ["w.workspace_id = $1"];
  if (q.status && q.status !== "all") {
    params.push(q.status);
    where.push(`w.status = $${params.length}`);
  } else where.push("w.status <> 'archived'");
  if (q.search) {
    params.push(`%${q.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    where.push(`(w.name ILIKE $${params.length} OR w.description ILIKE $${params.length})`);
  }
  if (q.projectId) {
    params.push(q.projectId);
    where.push(`w.project_id = $${params.length}`);
  }
  const whereSql = where.join(" AND ");
  const [count] = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM workflows w WHERE ${whereSql}`, params);
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  params.push(limit, offset);
  const items = await app.db.query(
    `SELECT w.id, w.project_id, w.name, w.description, w.status, w.trigger_type, w.active_version_id, w.created_at, w.updated_at, w.draft_updated_at,
       (SELECT version FROM workflow_versions v WHERE v.id = w.active_version_id) AS active_version,
       (SELECT jsonb_array_length(w.draft_definition->'nodes')) AS node_count,
       (SELECT max(e.created_at) FROM executions e WHERE e.workflow_id = w.id) AS last_run_at,
       (SELECT count(*)::int FROM executions e WHERE e.workflow_id = w.id AND e.created_at > now() - interval '7 days') AS runs_7d,
       (SELECT count(*)::int FROM executions e WHERE e.workflow_id = w.id AND e.status = 'failed' AND e.created_at > now() - interval '7 days') AS failures_7d
     FROM workflows w WHERE ${whereSql} ORDER BY w.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items, total: count?.n ?? 0, limit, offset };
}

/** Builds the validation context from the workspace's real resources. */
export async function validationContext(app: AppContext, p: Principal, forActivation: boolean) {
  const [credentials, tables, workflows, servers] = await Promise.all([
    credentialTypeMap(app, p.workspaceId),
    app.db.query<{ id: string }>("SELECT id FROM data_tables WHERE workspace_id = $1", [p.workspaceId]),
    app.db.query<{ id: string }>("SELECT id FROM workflows WHERE workspace_id = $1 AND status <> 'archived'", [p.workspaceId]),
    app.db.query<{ id: string }>("SELECT id FROM mcp_servers WHERE workspace_id = $1", [p.workspaceId]),
  ]);
  return {
    getNodeType: (t: string) => app.registry.nodeDefinition(t),
    credentials,
    tableIds: new Set(tables.map((t) => t.id)),
    workflowIds: new Set(workflows.map((w) => w.id)),
    mcpServerIds: new Set(servers.map((s) => s.id)),
    role: p.role,
    forActivation,
  };
}

/** Structural + registry validation plus checks that need server knowledge (cron). */
export async function validateDefinition(app: AppContext, p: Principal, definition: unknown, forActivation = false): Promise<ValidationResult> {
  const result = validateWorkflow(definition, await validationContext(app, p, forActivation));
  const def = result.definition;
  if (def) {
    const trigger = def.nodes.find((n) => isTriggerType(n.type));
    if (trigger?.type === "trigger.schedule") {
      const { cron, timezone } = cronFromConfig(trigger.config);
      const err = validateCron(cron, timezone);
      if (err) result.errors.push({ code: "invalid_field", message: `${trigger.name}: invalid schedule (${err}).`, nodeId: trigger.id, field: "cron" });
    }
    if (trigger?.type === "trigger.webhook" && trigger.config.verification && trigger.config.verification !== "none" && !trigger.credentialId) {
      result.errors.push({ code: "missing_credential", message: `${trigger.name}: request verification needs a webhook secret connection.`, nodeId: trigger.id });
    }
    for (const node of def.nodes) {
      const nd = app.registry.nodeDefinition(node.type);
      if (nd?.integration === "ai" && !node.credentialId && forActivation) {
        result.warnings.push({ code: "mock_ai", message: `${node.name}: no AI connection selected, so it will use the mock test adapter (heuristic output).`, nodeId: node.id });
      }
    }
    result.valid = result.errors.length === 0;
  }
  return result;
}

export async function createWorkflow(app: AppContext, p: Principal, input: { name: string; description?: string; projectId?: string; definition?: unknown; templateId?: string }) {
  authorize(p, "editor", "write");
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 200) throw badRequest("Name is required (max 200 characters).");
  const definition = input.definition ? parseDefinition(input.definition) : defaultDefinition();
  const project = input.projectId
    ? await app.db.one<{ id: string }>("SELECT id FROM projects WHERE id = $1 AND workspace_id = $2", [input.projectId, p.workspaceId])
    : await app.db.one<{ id: string }>("SELECT id FROM projects WHERE workspace_id = $1 ORDER BY created_at LIMIT 1", [p.workspaceId]);
  if (!project) throw badRequest("Project not found.");
  const id = randomId("wf");
  await app.db.query(
    "INSERT INTO workflows (id, workspace_id, project_id, name, description, draft_definition, trigger_type, template_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [id, p.workspaceId, project.id, name, String(input.description ?? "").slice(0, 4000), definition, triggerType(definition), input.templateId ?? null, p.userId],
  );
  await audit(app, p, { workspaceId: p.workspaceId, action: "workflow.create", resourceType: "workflow", resourceId: id, details: { name }, ip: p.ip });
  return getWorkflow(app, p.workspaceId, id);
}

function parseDefinition(input: unknown): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new AppError(400, "invalid_definition", "The workflow definition is invalid.", parsed.error.issues.slice(0, 50).map((i) => ({ path: i.path.join("."), message: i.message })));
  return parsed.data;
}

function triggerType(def: WorkflowDefinition): string | null {
  return def.nodes.find((n) => isTriggerType(n.type))?.type ?? null;
}

/** Saves the draft. Drafts may be incomplete; the validation result is returned alongside. */
export async function saveDraft(app: AppContext, p: Principal, id: string, input: { name?: string; description?: string; definition?: unknown; expectedUpdatedAt?: string }) {
  authorize(p, "editor", "write");
  const wf = await getWorkflow(app, p.workspaceId, id);
  if (wf.status === "archived") throw badRequest("Archived workflows cannot be edited.");
  if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== new Date(wf.draft_updated_at).getTime()) {
    throw new AppError(409, "conflict", "This workflow was changed by someone else. Reload to see the latest version.");
  }
  const definition = input.definition !== undefined ? parseDefinition(input.definition) : wf.draft_definition;
  const name = input.name !== undefined ? String(input.name).trim().slice(0, 200) || wf.name : wf.name;
  const description = input.description !== undefined ? String(input.description).slice(0, 4000) : wf.description;
  await app.db.query(
    "UPDATE workflows SET name = $3, description = $4, draft_definition = $5, draft_updated_at = now(), updated_at = now() WHERE id = $1 AND workspace_id = $2",
    [id, p.workspaceId, name, description, definition],
  );
  const validation = await validateDefinition(app, p, definition, false);
  return { workflow: await getWorkflow(app, p.workspaceId, id), validation };
}

export async function publishWorkflow(app: AppContext, p: Principal, id: string, note = "") {
  authorize(p, "editor", "write");
  const wf = await getWorkflow(app, p.workspaceId, id);
  if (wf.status === "archived") throw badRequest("Archived workflows cannot be published.");
  const validation = await validateDefinition(app, p, wf.draft_definition, true);
  if (!validation.valid) throw new AppError(422, "validation_failed", "Fix the validation errors before publishing.", validation);
  const def = validation.definition!;
  const [last] = await app.db.query<{ v: number }>("SELECT COALESCE(max(version), 0)::int AS v FROM workflow_versions WHERE workflow_id = $1", [id]);
  const versionId = randomId("ver");
  const version = (last?.v ?? 0) + 1;
  const tType = triggerType(def);
  await app.db.query("INSERT INTO workflow_versions (id, workflow_id, workspace_id, version, definition, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    versionId,
    id,
    p.workspaceId,
    version,
    def,
    String(note).slice(0, 500),
    p.userId,
  ]);
  const webhookKey = wf.webhook_key ?? (tType === "trigger.webhook" ? randomToken(18) : null);
  await app.db.query("UPDATE workflows SET active_version_id = $3, status = 'active', trigger_type = $4, webhook_key = $5, updated_at = now() WHERE id = $1 AND workspace_id = $2", [
    id,
    p.workspaceId,
    versionId,
    tType,
    webhookKey,
  ]);
  await syncTriggerRegistration(app, id, p.workspaceId, def);
  await audit(app, p, { workspaceId: p.workspaceId, action: "workflow.publish", resourceType: "workflow", resourceId: id, details: { version }, ip: p.ip });
  return { workflow: await getWorkflow(app, p.workspaceId, id), version, versionId, warnings: validation.warnings };
}

export async function setWorkflowStatus(app: AppContext, p: Principal, id: string, status: "paused" | "active" | "archived") {
  authorize(p, status === "archived" ? "admin" : "editor", "write");
  const wf = await getWorkflow(app, p.workspaceId, id);
  if (status === "active") {
    if (!wf.active_version_id) throw badRequest("Publish the workflow before activating it.");
    const v = await app.db.one<{ definition: WorkflowDefinition }>("SELECT definition FROM workflow_versions WHERE id = $1", [wf.active_version_id]);
    await app.db.query("UPDATE workflows SET status = 'active', updated_at = now() WHERE id = $1", [id]);
    await syncTriggerRegistration(app, id, p.workspaceId, v?.definition ?? null);
  } else {
    await app.db.query("UPDATE workflows SET status = $2, updated_at = now() WHERE id = $1", [id, status]);
    await syncTriggerRegistration(app, id, p.workspaceId, null);
  }
  await audit(app, p, { workspaceId: p.workspaceId, action: `workflow.${status === "active" ? "resume" : status === "paused" ? "pause" : "archive"}`, resourceType: "workflow", resourceId: id, ip: p.ip });
  return getWorkflow(app, p.workspaceId, id);
}

export async function deleteWorkflow(app: AppContext, p: Principal, id: string): Promise<void> {
  authorize(p, "admin", "write");
  const wf = await getWorkflow(app, p.workspaceId, id);
  if (wf.status !== "archived") throw badRequest("Archive the workflow before deleting it permanently.");
  await app.db.query("DELETE FROM workflows WHERE id = $1 AND workspace_id = $2", [id, p.workspaceId]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "workflow.delete", resourceType: "workflow", resourceId: id, details: { name: wf.name }, ip: p.ip });
}

export async function listVersions(app: AppContext, workspaceId: string, id: string) {
  await getWorkflow(app, workspaceId, id);
  return app.db.query("SELECT v.id, v.version, v.note, v.created_at, u.name AS created_by_name FROM workflow_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.workflow_id = $1 ORDER BY v.version DESC", [id]);
}

export async function getVersion(app: AppContext, workspaceId: string, id: string, versionId: string) {
  const v = await app.db.one("SELECT id, version, note, definition, created_at FROM workflow_versions WHERE id = $1 AND workflow_id = $2 AND workspace_id = $3", [versionId, id, workspaceId]);
  if (!v) throw notFound("Version");
  return v;
}

export async function restoreVersion(app: AppContext, p: Principal, id: string, versionId: string) {
  const v = (await getVersion(app, p.workspaceId, id, versionId)) as { definition: WorkflowDefinition };
  return saveDraft(app, p, id, { definition: v.definition });
}

export async function exportWorkflow(app: AppContext, workspaceId: string, id: string) {
  const wf = await getWorkflow(app, workspaceId, id);
  // Credentials and workspace-specific IDs are not portable; connections must be re-selected after import.
  const definition: WorkflowDefinition = { ...wf.draft_definition, nodes: wf.draft_definition.nodes.map((n) => ({ ...n, credentialId: null })) };
  return workflowExportSchema.parse({ format: "automation-studio.workflow", formatVersion: 1, name: wf.name, description: wf.description, definition });
}

export async function importWorkflow(app: AppContext, p: Principal, payload: unknown, projectId?: string) {
  const parsed = workflowExportSchema.safeParse(payload);
  if (!parsed.success) throw new AppError(400, "invalid_import", "This file is not a valid workflow export.", parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })));
  const unknownTypes = parsed.data.definition.nodes.filter((n) => !app.registry.getNode(n.type)).map((n) => n.type);
  if (unknownTypes.length) throw badRequest(`The import uses node types that are not installed: ${[...new Set(unknownTypes)].join(", ")}`);
  const definition = { ...parsed.data.definition, nodes: parsed.data.definition.nodes.map((n) => ({ ...n, credentialId: null })) };
  return createWorkflow(app, p, { name: parsed.data.name, description: parsed.data.description, definition, projectId });
}

export async function duplicateWorkflow(app: AppContext, p: Principal, id: string) {
  const wf = await getWorkflow(app, p.workspaceId, id);
  return createWorkflow(app, p, { name: `${wf.name} (copy)`.slice(0, 200), description: wf.description, definition: wf.draft_definition, projectId: wf.project_id });
}

/**
 * Starts an execution from the API/editor/MCP. `test` runs the current draft
 * (optionally simulating external side effects); `manual` runs the published version.
 */
export async function runWorkflow(app: AppContext, p: Principal, id: string, input: { payload?: unknown; mode?: "test" | "manual"; useMocks?: boolean; source?: ExecutionMode }) {
  authorize(p, "editor", "execute");
  const wf = await getWorkflow(app, p.workspaceId, id);
  const mode = input.mode ?? "test";
  let definition: WorkflowDefinition;
  let versionId: string | null = null;
  if (mode === "test") {
    const validation = await validateDefinition(app, p, wf.draft_definition, false);
    const blocking = validation.errors.filter((e) => e.code !== "missing_credential");
    if (blocking.length) throw new AppError(422, "validation_failed", "Fix the validation errors before testing.", validation);
    definition = validation.definition!;
  } else {
    if (!wf.active_version_id || wf.status !== "active") throw badRequest("Only active (published) workflows can be run. Use a test run for drafts.");
    const v = await app.db.one<{ id: string; definition: WorkflowDefinition }>("SELECT id, definition FROM workflow_versions WHERE id = $1", [wf.active_version_id]);
    definition = v!.definition;
    versionId = v!.id;
  }
  const trigger = definition.nodes.find((n) => isTriggerType(n.type))!;
  const payload = input.payload ?? (trigger.config.samplePayload as unknown) ?? app.registry.getNode(trigger.type)?.sampleOutput ?? {};
  const res = await startExecution(app, {
    workspaceId: p.workspaceId,
    workflowId: id,
    workflowVersionId: versionId,
    definition,
    mode: input.source ?? mode,
    triggerData: payload,
    useMocks: mode === "test" ? input.useMocks !== false : false,
    createdBy: p.userId,
  });
  await audit(app, p, { workspaceId: p.workspaceId, action: "workflow.run", resourceType: "workflow", resourceId: id, details: { executionId: res.executionId, mode }, ip: p.ip });
  return res;
}

/** Latest real outputs per node (redacted) or each node type's sample output, for data mapping in the editor. */
export async function sampleData(app: AppContext, workspaceId: string, id: string) {
  const wf = await getWorkflow(app, workspaceId, id);
  const latest = await app.db.query<{ node_id: string; output: unknown }>(
    `SELECT DISTINCT ON (s.node_id) s.node_id, s.output FROM execution_steps s JOIN executions e ON e.id = s.execution_id
     WHERE e.workflow_id = $1 AND e.workspace_id = $2 AND s.status = 'succeeded' ORDER BY s.node_id, e.created_at DESC`,
    [id, workspaceId],
  );
  const real = new Map(latest.map((r) => [r.node_id, r.output]));
  const out: Record<string, { source: "execution" | "sample"; output: unknown }> = {};
  for (const n of wf.draft_definition.nodes) {
    if (real.has(n.id)) out[n.id] = { source: "execution", output: redact(real.get(n.id)) };
    else {
      const sample = isTriggerType(n.type) && n.config.samplePayload ? n.config.samplePayload : app.registry.getNode(n.type)?.sampleOutput;
      out[n.id] = { source: "sample", output: sample ?? null };
    }
  }
  return out;
}

/**
 * Tests one node: upstream steps are pre-filled with sample data and the node
 * runs inline (test mode, external side effects simulated unless disabled).
 */
export async function testNode(app: AppContext, p: Principal, id: string, nodeId: string, input: { useMocks?: boolean; samples?: Record<string, unknown> }) {
  authorize(p, "editor", "execute");
  requireScope(p, "execute");
  const wf = await getWorkflow(app, p.workspaceId, id);
  const def = wf.draft_definition;
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) throw notFound("Node");
  if (isTriggerType(node.type)) throw badRequest("Triggers are tested by running the workflow.");
  const validation = await validateDefinition(app, p, def, false);
  const nodeErrors = validation.errors.filter((e) => e.nodeId === nodeId && e.code !== "missing_credential");
  if (nodeErrors.length) throw new AppError(422, "validation_failed", nodeErrors.map((e) => e.message).join(" "), validation);

  const ancestors = ancestorsOf(def, nodeId);
  const samples = { ...(await sampleData(app, p.workspaceId, id)) };
  const trigger = def.nodes.find((n) => isTriggerType(n.type))!;
  // Mini workflow: trigger -> (sample-filled ancestors) -> node, preserving edges among them.
  const keep = new Set([...ancestors, nodeId, trigger.id]);
  const mini: WorkflowDefinition = {
    ...def,
    nodes: def.nodes.filter((n) => keep.has(n.id)).map((n) => ({ ...n, disabled: false })),
    edges: def.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
  const triggerData = input.samples?.[trigger.id] ?? samples[trigger.id]?.output ?? {};
  const { executionId } = await startExecution(app, {
    workspaceId: p.workspaceId,
    workflowId: id,
    workflowVersionId: null,
    definition: mini,
    mode: "test",
    triggerData,
    useMocks: input.useMocks !== false,
    createdBy: p.userId,
    inline: true,
  });
  for (const a of ancestors) {
    if (a === trigger.id) continue;
    // Pick the branch that leads towards the tested node so the path stays active.
    const incoming = mini.edges.find((e) => e.source === a && (e.target === nodeId || ancestors.has(e.target)));
    await app.db.query("UPDATE execution_steps SET status = 'succeeded', output = $3, branch = $4, finished_at = now() WHERE execution_id = $1 AND node_id = $2", [
      executionId,
      a,
      input.samples?.[a] ?? samples[a]?.output ?? null,
      incoming?.branch ?? null,
    ]);
  }
  await runExecution(app, executionId, `test:${executionId}`);
  const step = await app.db.one<{ status: string; output: unknown; error: unknown; input: unknown; logs: unknown }>(
    "SELECT status, output, error, input, logs FROM execution_steps WHERE execution_id = $1 AND node_id = $2",
    [executionId, nodeId],
  );
  return { executionId, status: step?.status, input: redact(step?.input), output: redact(step?.output), error: step?.error, logs: step?.logs };
}
