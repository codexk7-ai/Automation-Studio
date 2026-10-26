import { FUNCTION_NAMES, CONDITION_OPERATORS, redact, ROLES, type Role } from "@automation-studio/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { badRequest, unauthorized } from "../errors.ts";
import { queueStats } from "../engine/queue.ts";
import { authorize, requireRole, requireScope, type Principal } from "../auth/principal.ts";
import { PLATFORM_TOOLS } from "../mcp/server.ts";
import { callExternalTool, deleteServer, getServer, listServers, refreshTools, registerServer, updateServer } from "../mcp/client.ts";
import {
  addMember,
  authenticate,
  changePassword,
  createApiToken,
  createSession,
  destroySession,
  listApiTokens,
  listMembers,
  registerUser,
  removeMember,
  revokeApiToken,
  switchSessionWorkspace,
  updateMemberRole,
} from "../services/accounts.ts";
import { audit, listAudit } from "../services/audit.ts";
import { beginTotpSetup, completeMfaChallenge, confirmTotpSetup, disableTotp, issueMfaChallenge, mfaStatus } from "../services/mfa.ts";
import { finishSso, startSso } from "../services/sso.ts";
import { createCredential, deleteCredential, listCredentials, testCredential, updateCredential } from "../services/credentials.ts";
import { cancelExecution, decideApproval, getExecution, listApprovals, listExecutions, retryExecution } from "../services/executions.ts";
import { createForm, deleteForm, getForm, listForms, updateForm } from "../services/forms.ts";
import { assignRowOwner, createTable, deleteRow, deleteTable, exportCsv, getTable, importCsv, insertRow, listTables, queryRows, updateRow, updateTable, type RowFilter } from "../services/tables.ts";
import { instantiateTemplate, listTemplates } from "../services/templates.ts";
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  exportWorkflow,
  getVersion,
  getWorkflow,
  importWorkflow,
  listVersions,
  listWorkflows,
  publishWorkflow,
  restoreVersion,
  runWorkflow,
  sampleData,
  saveDraft,
  setWorkflowStatus,
  testNode,
  validateDefinition,
} from "../services/workflows.ts";
import { need, sessionCookieName } from "./server.ts";
import { startOAuth, finishOAuth } from "./oauth.ts";

type Body = Record<string, unknown>;
const body = (req: FastifyRequest): Body => (req.body && typeof req.body === "object" ? (req.body as Body) : {});
const query = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
const params = (req: FastifyRequest) => req.params as Record<string, string>;
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? undefined : String(v));
const num = (v: unknown) => (v === undefined || v === "" ? undefined : Number(v));

/** Read access: any member; API tokens need the read scope. */
function reader(req: FastifyRequest): Principal {
  const p = need(req);
  requireScope(p, "read");
  return p;
}

function webhookUrl(app: AppContext, key: string | null) {
  return key ? `${app.config.publicUrl}/hooks/w/${key}` : null;
}

export async function registerApiRoutes(server: FastifyInstance, app: AppContext): Promise<void> {
  const authLimit = { config: { rateLimit: { max: app.config.authRateLimitPerMinute, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.ip } } };

  // ---------------------------------------------------------------- health
  // Readiness: database reachable and all migrations applied (use for load balancers).
  server.get("/api/ready", { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      const applied = await app.db.one<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations");
      return { status: "ready", migrations: applied?.n ?? 0 };
    } catch {
      return reply.status(503).send({ status: "not_ready" });
    }
  });

  server.get("/api/health", { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await app.db.query("SELECT 1");
      return { status: "ok", database: app.db.driver, worker: app.config.workerMode, time: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: "error", database: "unreachable" });
    }
  });

  // ---------------------------------------------------------------- auth
  server.post("/api/auth/register", authLimit, async (req, reply) => {
    if (!app.config.allowRegistration) {
      const users = await app.db.one<{ n: number }>("SELECT count(*)::int AS n FROM users");
      if ((users?.n ?? 0) > 0) throw badRequest("Registration is disabled. Ask an admin to add you to a workspace.");
    }
    const b = body(req);
    const { user, workspaceId } = await registerUser(app, { email: str(b.email) ?? "", name: str(b.name) ?? "", password: str(b.password) ?? "", workspaceName: str(b.workspaceName) });
    const s = await createSession(app, user.id, workspaceId, { ip: req.ip, userAgent: req.headers["user-agent"] });
    reply.setCookie(sessionCookieName(app.config), s.token, { httpOnly: true, sameSite: "lax", secure: app.config.secureCookies, path: "/", expires: s.expires });
    return { user, workspaceId, csrfToken: s.csrf };
  });

  server.post("/api/auth/login", authLimit, async (req, reply) => {
    const b = body(req);
    const user = await authenticate(app, str(b.email) ?? "", str(b.password) ?? "", req.ip);
    if ((await mfaStatus(app, user.id)).enabled) return { mfaRequired: true, mfaToken: issueMfaChallenge(app, user.id) };
    const ws = await app.db.one<{ workspace_id: string }>("SELECT workspace_id FROM workspace_members WHERE user_id = $1 ORDER BY created_at LIMIT 1", [user.id]);
    const s = await createSession(app, user.id, ws?.workspace_id ?? null, { ip: req.ip, userAgent: req.headers["user-agent"] });
    reply.setCookie(sessionCookieName(app.config), s.token, { httpOnly: true, sameSite: "lax", secure: app.config.secureCookies, path: "/", expires: s.expires });
    await audit(app, { actorType: "user", userId: user.id, workspaceId: ws?.workspace_id ?? "", role: "viewer" }, { workspaceId: ws?.workspace_id ?? null, action: "auth.login", resourceType: "user", resourceId: user.id, ip: req.ip });
    return { user, csrfToken: s.csrf };
  });

  const startSession = async (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    const ws = await app.db.one<{ workspace_id: string }>("SELECT workspace_id FROM workspace_members WHERE user_id = $1 ORDER BY created_at LIMIT 1", [userId]);
    const s = await createSession(app, userId, ws?.workspace_id ?? null, { ip: req.ip, userAgent: req.headers["user-agent"] });
    reply.setCookie(sessionCookieName(app.config), s.token, { httpOnly: true, sameSite: "lax", secure: app.config.secureCookies, path: "/", expires: s.expires });
    await audit(app, { actorType: "user", userId, workspaceId: ws?.workspace_id ?? "", role: "viewer" }, { workspaceId: ws?.workspace_id ?? null, action: "auth.login", resourceType: "user", resourceId: userId, ip: req.ip });
    return s;
  };

  server.post("/api/auth/login/mfa", authLimit, async (req, reply) => {
    const b = body(req);
    const userId = await completeMfaChallenge(app, str(b.mfaToken) ?? "", str(b.code) ?? "");
    const user = await app.db.one("SELECT id, email, name FROM users WHERE id = $1", [userId]);
    const s = await startSession(req, reply, userId);
    return { user, csrfToken: s.csrf };
  });

  server.get("/api/auth/2fa", async (req) => mfaStatus(app, need(req).userId!));
  server.post("/api/auth/2fa/setup", async (req) => {
    const p = need(req);
    if (p.actorType !== "user") throw unauthorized("Session required.");
    return beginTotpSetup(app, p.userId!);
  });
  server.post("/api/auth/2fa/confirm", authLimit, async (req) => {
    const p = need(req);
    if (p.actorType !== "user") throw unauthorized("Session required.");
    return confirmTotpSetup(app, p.userId!, str(body(req).code) ?? "");
  });
  server.post("/api/auth/2fa/disable", authLimit, async (req) => {
    const p = need(req);
    if (p.actorType !== "user") throw unauthorized("Session required.");
    const ws = await app.db.one<{ settings: { require2fa?: boolean } }>("SELECT settings FROM workspaces WHERE id = $1", [p.workspaceId]);
    if (ws?.settings?.require2fa) throw badRequest("This workspace requires two-factor authentication.");
    await disableTotp(app, p.userId!, str(body(req).password) ?? "", str(body(req).code) ?? "");
    return { ok: true };
  });

  server.get("/api/auth/sso/start", authLimit, async (_req, reply) => reply.redirect(await startSso(app)));
  server.get("/api/auth/sso/callback", authLimit, async (req, reply) => {
    const q = query(req);
    try {
      if (q.error) throw new Error(String(q.error_description ?? q.error));
      const userId = await finishSso(app, q.code ?? "", q.state ?? "", req.ip);
      await startSession(req, reply, userId);
      return reply.redirect("/");
    } catch (err) {
      return reply.redirect(`/login?sso_error=${encodeURIComponent((err as Error).message.slice(0, 200))}`);
    }
  });

  server.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[sessionCookieName(app.config)];
    if (token) await destroySession(app, token);
    reply.clearCookie(sessionCookieName(app.config), { path: "/" });
    return { ok: true };
  });

  server.get("/api/auth/me", async (req) => {
    const p = need(req);
    const user = await app.db.one("SELECT id, email, name, created_at FROM users WHERE id = $1", [p.userId]);
    const workspaces = await app.db.query("SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY w.name", [p.userId]);
    const ws = await app.db.one("SELECT id, name, settings FROM workspaces WHERE id = $1", [p.workspaceId]);
    const projects = await app.db.query("SELECT id, name, description FROM projects WHERE workspace_id = $1 ORDER BY created_at", [p.workspaceId]);
    const mfa = await mfaStatus(app, p.userId!);
    return { user, workspace: ws, role: p.role, workspaces, projects, csrfToken: req.sessionInfo?.csrf ?? null, brandName: app.config.brandName, actorType: p.actorType, totpEnabled: mfa.enabled, recoveryCodesLeft: mfa.recoveryCodesLeft, require2fa: (ws as { settings?: { require2fa?: boolean } } | undefined)?.settings?.require2fa === true };
  });

  server.post("/api/auth/switch-workspace", async (req) => {
    const p = need(req);
    if (!req.sessionInfo) throw unauthorized("Session required.");
    await switchSessionWorkspace(app, req.sessionInfo.sessionId, p.userId!, str(body(req).workspaceId) ?? "");
    return { ok: true };
  });

  server.post("/api/auth/change-password", authLimit, async (req, reply) => {
    const p = need(req);
    if (p.actorType !== "user") throw unauthorized("Session required.");
    const b = body(req);
    await changePassword(app, p.userId!, str(b.currentPassword) ?? "", str(b.newPassword) ?? "");
    reply.clearCookie(sessionCookieName(app.config), { path: "/" });
    return { ok: true, message: "Password changed. Please sign in again." };
  });

  // ---------------------------------------------------------------- workspace & team
  server.get("/api/workspace", async (req) => {
    const p = reader(req);
    return app.db.one("SELECT id, name, settings, created_at FROM workspaces WHERE id = $1", [p.workspaceId]);
  });

  server.patch("/api/workspace", async (req) => {
    const p = need(req);
    authorize(p, "admin", "admin");
    const b = body(req);
    const current = await app.db.one<{ name: string; settings: Record<string, unknown> }>("SELECT name, settings FROM workspaces WHERE id = $1", [p.workspaceId]);
    const settings = { ...(current?.settings ?? {}) };
    const s = (b.settings ?? {}) as Record<string, unknown>;
    if (s.aiMonthlyTokenBudget !== undefined) settings.aiMonthlyTokenBudget = Math.max(0, Math.floor(Number(s.aiMonthlyTokenBudget) || 0));
    if (s.require2fa !== undefined) {
      if (s.require2fa === true && !(await mfaStatus(app, p.userId!)).enabled) throw badRequest("Enable two-factor authentication on your own account before requiring it for the workspace.");
      settings.require2fa = s.require2fa === true;
    }
    if (s.executionRetentionDays !== undefined) settings.executionRetentionDays = Math.min(3650, Math.max(1, Math.floor(Number(s.executionRetentionDays) || 90)));
    await app.db.query("UPDATE workspaces SET name = $2, settings = $3 WHERE id = $1", [p.workspaceId, str(b.name)?.trim().slice(0, 200) || current?.name, settings]);
    await audit(app, p, { workspaceId: p.workspaceId, action: "workspace.update", details: { settings }, ip: p.ip });
    return app.db.one("SELECT id, name, settings FROM workspaces WHERE id = $1", [p.workspaceId]);
  });

  server.get("/api/projects", async (req) => app.db.query("SELECT id, name, description, created_at FROM projects WHERE workspace_id = $1 ORDER BY created_at", [reader(req).workspaceId]));
  server.post("/api/projects", async (req) => {
    const p = need(req);
    authorize(p, "admin", "write");
    const name = str(body(req).name)?.trim();
    if (!name) throw badRequest("Name is required.");
    const id = `prj_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await app.db.query("INSERT INTO projects (id, workspace_id, name, description) VALUES ($1, $2, $3, $4)", [id, p.workspaceId, name.slice(0, 200), str(body(req).description)?.slice(0, 2000) ?? ""]);
    return app.db.one("SELECT * FROM projects WHERE id = $1", [id]);
  });

  server.get("/api/members", async (req) => listMembers(app, reader(req).workspaceId));
  server.post("/api/members", async (req) => {
    const b = body(req);
    return addMember(app, need(req), { email: str(b.email) ?? "", role: (str(b.role) ?? "viewer") as Role, name: str(b.name) });
  });
  server.patch("/api/members/:userId", async (req) => {
    const role = str(body(req).role) as Role;
    if (!ROLES.includes(role)) throw badRequest("Invalid role.");
    await updateMemberRole(app, need(req), params(req).userId!, role);
    return { ok: true };
  });
  server.delete("/api/members/:userId", async (req) => {
    await removeMember(app, need(req), params(req).userId!);
    return { ok: true };
  });

  server.get("/api/api-tokens", async (req) => listApiTokens(app, reader(req)));
  server.post("/api/api-tokens", async (req) => {
    const b = body(req);
    return createApiToken(app, need(req), { name: str(b.name) ?? "", scopes: Array.isArray(b.scopes) ? b.scopes.map(String) : [], expiresInDays: num(b.expiresInDays) ?? null });
  });
  server.delete("/api/api-tokens/:id", async (req) => {
    await revokeApiToken(app, need(req), params(req).id!);
    return { ok: true };
  });

  server.get("/api/audit", async (req) => {
    const p = reader(req);
    requireRole(p, "admin");
    const q = query(req);
    return listAudit(app, p.workspaceId, { limit: Math.min(Number(q.limit) || 50, 200), offset: Number(q.offset) || 0, action: q.action });
  });

  // ---------------------------------------------------------------- catalog
  server.get("/api/catalog", async (req) => {
    reader(req);
    const nodes = app.registry.nodeDefinitions();
    return {
      integrations: app.registry.integrationDefinitions().map((i) => ({ ...i, nodeCount: nodes.filter((n) => n.integration === i.id).length })),
      nodes,
      credentialTypes: app.registry.credentialTypeDefinitions().map((c) => ({ ...c, oauthAvailable: !!c.oauth2 && (c.id !== "google" || !!app.config.google) })),
      expressionFunctions: FUNCTION_NAMES,
      conditionOperators: CONDITION_OPERATORS,
    };
  });

  // ---------------------------------------------------------------- dashboard & metrics
  server.get("/api/dashboard", async (req) => {
    const p = reader(req);
    const ws = p.workspaceId;
    const [workflows] = await app.db.query<{ total: number; active: number; paused: number }>(
      "SELECT count(*) FILTER (WHERE status <> 'archived')::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'paused')::int AS paused FROM workflows WHERE workspace_id = $1",
      [ws],
    );
    const byStatus = await app.db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM executions WHERE workspace_id = $1 AND created_at > now() - interval '7 days' AND mode <> 'subworkflow' GROUP BY status", [ws]);
    const daily = await app.db.query<{ day: string; succeeded: number; failed: number; other: number }>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
        count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded, count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status NOT IN ('succeeded', 'failed'))::int AS other
       FROM executions WHERE workspace_id = $1 AND created_at > now() - interval '14 days' AND mode <> 'subworkflow' GROUP BY 1 ORDER BY 1`,
      [ws],
    );
    const recentFailures = await app.db.query(
      "SELECT e.id, e.workflow_id, w.name AS workflow_name, e.error, e.created_at FROM executions e JOIN workflows w ON w.id = e.workflow_id WHERE e.workspace_id = $1 AND e.status = 'failed' ORDER BY e.created_at DESC LIMIT 5",
      [ws],
    );
    const [approvals] = await app.db.query<{ n: number }>("SELECT count(*)::int AS n FROM approvals WHERE workspace_id = $1 AND status = 'pending'", [ws]);
    const [ai] = await app.db.query<{ tokens: number; cost: number | null; calls: number }>(
      "SELECT COALESCE(sum(input_tokens + output_tokens), 0)::int AS tokens, sum(estimated_cost_usd)::float AS cost, count(*)::int AS calls FROM ai_usage WHERE workspace_id = $1 AND created_at >= date_trunc('month', now())",
      [ws],
    );
    const [emails] = await app.db.query<{ sent: number; captured: number }>(
      "SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status IN ('captured', 'simulated'))::int AS captured FROM email_outbox WHERE workspace_id = $1 AND created_at > now() - interval '7 days'",
      [ws],
    );
    return {
      workflows,
      executions7d: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      daily,
      recentFailures: redact(recentFailures),
      pendingApprovals: approvals?.n ?? 0,
      aiThisMonth: ai,
      emails7d: emails,
    };
  });

  server.get("/api/usage", async (req) => {
    const p = reader(req);
    const ai = await app.db.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, provider, model, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens, sum(estimated_cost_usd)::float AS cost, count(*)::int AS calls
       FROM ai_usage WHERE workspace_id = $1 AND created_at > now() - interval '30 days' GROUP BY 1, 2, 3 ORDER BY 1 DESC`,
      [p.workspaceId],
    );
    const perWorkflow = await app.db.query(
      `SELECT w.id, w.name, count(e.id)::int AS runs, count(e.id) FILTER (WHERE e.status = 'failed')::int AS failed, COALESCE(sum(e.step_executions), 0)::int AS steps
       FROM workflows w LEFT JOIN executions e ON e.workflow_id = w.id AND e.created_at > now() - interval '30 days'
       WHERE w.workspace_id = $1 AND w.status <> 'archived' GROUP BY w.id, w.name ORDER BY runs DESC LIMIT 50`,
      [p.workspaceId],
    );
    const mcp = await app.db.query(
      "SELECT direction, tool, status, count(*)::int AS calls, avg(duration_ms)::int AS avg_ms FROM mcp_tool_calls WHERE workspace_id = $1 AND created_at > now() - interval '30 days' GROUP BY 1, 2, 3 ORDER BY calls DESC LIMIT 100",
      [p.workspaceId],
    );
    const settings = await app.db.one<{ settings: { aiMonthlyTokenBudget?: number } }>("SELECT settings FROM workspaces WHERE id = $1", [p.workspaceId]);
    return { ai, perWorkflow, mcp, aiMonthlyTokenBudget: settings?.settings?.aiMonthlyTokenBudget ?? 0, queue: await queueStats(app.db) };
  });

  // ---------------------------------------------------------------- workflows
  server.get("/api/workflows", async (req) => {
    const p = reader(req);
    const q = query(req);
    return listWorkflows(app, p.workspaceId, { status: q.status, search: q.search, projectId: q.projectId, limit: num(q.limit), offset: num(q.offset) });
  });
  server.post("/api/workflows", async (req) => {
    const b = body(req);
    return createWorkflow(app, need(req), { name: str(b.name) ?? "", description: str(b.description), projectId: str(b.projectId), definition: b.definition });
  });
  server.get("/api/workflows/:id", async (req) => {
    const p = reader(req);
    const wf = await getWorkflow(app, p.workspaceId, params(req).id!);
    const activeVersion = wf.active_version_id ? await app.db.one<{ version: number; definition: unknown }>("SELECT version, definition FROM workflow_versions WHERE id = $1", [wf.active_version_id]) : null;
    const pollState = await app.db.one("SELECT next_poll_at, last_error, updated_at FROM trigger_state WHERE workflow_id = $1", [wf.id]);
    const schedule = await app.db.one("SELECT cron, timezone, next_run_at, last_run_at FROM workflow_schedules WHERE workflow_id = $1", [wf.id]);
    const { webhook_key, ...rest } = wf;
    return { ...rest, webhookUrl: webhookUrl(app, webhook_key), activeVersion: activeVersion?.version ?? null, publishedDefinition: activeVersion?.definition ?? null, pollState, schedule };
  });
  server.put("/api/workflows/:id", async (req) => {
    const b = body(req);
    return saveDraft(app, need(req), params(req).id!, { name: str(b.name), description: str(b.description), definition: b.definition, expectedUpdatedAt: str(b.expectedUpdatedAt) });
  });
  server.post("/api/workflows/:id/validate", async (req) => {
    const p = reader(req);
    const b = body(req);
    const def = b.definition ?? (await getWorkflow(app, p.workspaceId, params(req).id!)).draft_definition;
    const { definition: _d, ...result } = await validateDefinition(app, p, def, b.forActivation === true);
    return result;
  });
  server.post("/api/validate", async (req) => {
    const p = reader(req);
    const { definition: _d, ...result } = await validateDefinition(app, p, body(req).definition, body(req).forActivation === true);
    return result;
  });
  server.post("/api/workflows/:id/publish", async (req) => publishWorkflow(app, need(req), params(req).id!, str(body(req).note) ?? ""));
  server.post("/api/workflows/:id/pause", async (req) => setWorkflowStatus(app, need(req), params(req).id!, "paused"));
  server.post("/api/workflows/:id/resume", async (req) => setWorkflowStatus(app, need(req), params(req).id!, "active"));
  server.post("/api/workflows/:id/archive", async (req) => setWorkflowStatus(app, need(req), params(req).id!, "archived"));
  server.delete("/api/workflows/:id", async (req) => {
    await deleteWorkflow(app, need(req), params(req).id!);
    return { ok: true };
  });
  server.post("/api/workflows/:id/duplicate", async (req) => duplicateWorkflow(app, need(req), params(req).id!));
  server.get("/api/workflows/:id/versions", async (req) => listVersions(app, reader(req).workspaceId, params(req).id!));
  server.get("/api/workflows/:id/versions/:versionId", async (req) => getVersion(app, reader(req).workspaceId, params(req).id!, params(req).versionId!));
  server.post("/api/workflows/:id/versions/:versionId/restore", async (req) => restoreVersion(app, need(req), params(req).id!, params(req).versionId!));
  server.get("/api/workflows/:id/export", async (req, reply) => {
    const data = await exportWorkflow(app, reader(req).workspaceId, params(req).id!);
    reply.header("content-disposition", `attachment; filename="${data.name.replace(/[^a-z0-9]+/gi, "_")}.workflow.json"`);
    return data;
  });
  server.post("/api/workflows/import", async (req) => importWorkflow(app, need(req), body(req).workflow ?? body(req), str(body(req).projectId)));
  server.post("/api/workflows/:id/run", async (req) => {
    const b = body(req);
    return runWorkflow(app, need(req), params(req).id!, { payload: b.payload, mode: b.mode === "manual" ? "manual" : "test", useMocks: b.useMocks !== false });
  });
  server.post("/api/workflows/:id/nodes/:nodeId/test", async (req) => {
    const b = body(req);
    return testNode(app, need(req), params(req).id!, params(req).nodeId!, { useMocks: b.useMocks !== false, samples: (b.samples as Record<string, unknown>) ?? undefined });
  });
  server.get("/api/workflows/:id/sample-data", async (req) => sampleData(app, reader(req).workspaceId, params(req).id!));

  // ---------------------------------------------------------------- templates
  server.get("/api/templates", async (req) => {
    reader(req);
    return listTemplates();
  });
  server.post("/api/templates/:id/instantiate", async (req) => instantiateTemplate(app, need(req), params(req).id!, { name: str(body(req).name), projectId: str(body(req).projectId) }));

  // ---------------------------------------------------------------- executions & approvals
  server.get("/api/executions", async (req) => {
    const p = reader(req);
    const q = query(req);
    return listExecutions(app, p.workspaceId, { workflowId: q.workflowId, status: q.status, mode: q.mode, since: q.since, limit: num(q.limit), offset: num(q.offset) });
  });
  server.get("/api/executions/:id", async (req) => getExecution(app, reader(req).workspaceId, params(req).id!));
  server.post("/api/executions/:id/cancel", async (req) => cancelExecution(app, need(req), params(req).id!));
  server.post("/api/executions/:id/retry", async (req) => retryExecution(app, need(req), params(req).id!, body(req).strategy === "from_start" ? "from_start" : "failed_steps"));
  server.get("/api/approvals", async (req) => listApprovals(app, reader(req).workspaceId, query(req).status ?? "pending"));
  server.post("/api/approvals/:id/decision", async (req) => {
    const b = body(req);
    if (b.decision !== "approved" && b.decision !== "rejected") throw badRequest("Decision must be 'approved' or 'rejected'.");
    return decideApproval(app, need(req), params(req).id!, b.decision, str(b.comment));
  });
  server.get("/api/outbox", async (req) => {
    const p = reader(req);
    return app.db.query(
      "SELECT id, execution_id, provider, status, to_addresses, subject, body_text, body_html, provider_message_id, error, created_at FROM email_outbox WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100",
      [p.workspaceId],
    );
  });

  // ---------------------------------------------------------------- credentials
  server.get("/api/credentials", async (req) => listCredentials(app, reader(req).workspaceId, query(req).type));
  server.post("/api/credentials", async (req) => {
    const b = body(req);
    return createCredential(app, need(req), { name: str(b.name) ?? "", type: str(b.type) ?? "", data: (b.data as Record<string, unknown>) ?? {} });
  });
  server.patch("/api/credentials/:id", async (req) => {
    const b = body(req);
    return updateCredential(app, need(req), params(req).id!, { name: str(b.name), data: (b.data as Record<string, unknown>) ?? undefined });
  });
  server.delete("/api/credentials/:id", async (req) => {
    await deleteCredential(app, need(req), params(req).id!);
    return { ok: true };
  });
  server.post("/api/credentials/:id/test", async (req) => testCredential(app, need(req), params(req).id!));
  server.get("/api/oauth/:type/start", async (req, reply) => startOAuth(app, req, reply, params(req).type!));
  server.get("/api/oauth/:type/callback", async (req, reply) => finishOAuth(app, req, reply, params(req).type!));

  // ---------------------------------------------------------------- tables
  server.get("/api/tables", async (req) => listTables(app, reader(req).workspaceId));
  server.post("/api/tables", async (req) => {
    const b = body(req);
    return createTable(app, need(req), { name: str(b.name) ?? "", description: str(b.description), columns: b.columns, projectId: str(b.projectId), retentionDays: num(b.retentionDays) ?? null, minReadRole: str(b.minReadRole) as Role, minWriteRole: str(b.minWriteRole) as Role, rowAccess: b.rowAccess === "own" ? "own" : "all" });
  });
  server.get("/api/tables/:id", async (req) => getTable(app, reader(req).workspaceId, params(req).id!));
  server.patch("/api/tables/:id", async (req) => {
    const b = body(req);
    return updateTable(app, need(req), params(req).id!, {
      name: str(b.name),
      description: str(b.description),
      columns: b.columns,
      retentionDays: b.retentionDays === null ? null : num(b.retentionDays),
      minReadRole: str(b.minReadRole) as Role | undefined,
      minWriteRole: str(b.minWriteRole) as Role | undefined,
      rowAccess: b.rowAccess === "own" || b.rowAccess === "all" ? b.rowAccess : undefined,
    });
  });
  server.delete("/api/tables/:id", async (req) => {
    await deleteTable(app, need(req), params(req).id!);
    return { ok: true };
  });
  server.get("/api/tables/:id/rows", async (req) => {
    const p = reader(req);
    const q = query(req);
    let filters: RowFilter[] = [];
    if (q.filters) {
      try {
        filters = JSON.parse(q.filters);
      } catch {
        throw badRequest("filters must be JSON.");
      }
    }
    return queryRows(app, p, p.workspaceId, params(req).id!, { search: q.search, filters, sort: q.sort, direction: q.direction === "asc" ? "asc" : "desc", limit: num(q.limit), offset: num(q.offset) });
  });
  server.post("/api/tables/:id/rows", async (req) => {
    const p = need(req);
    authorize(p, "editor", "write");
    return insertRow(app, p, p.workspaceId, params(req).id!, (body(req).data as Record<string, unknown>) ?? {}, { userId: p.userId });
  });
  server.patch("/api/tables/:id/rows/:rowId", async (req) => {
    const p = need(req);
    authorize(p, "editor", "write");
    return updateRow(app, p, p.workspaceId, params(req).id!, params(req).rowId!, (body(req).data as Record<string, unknown>) ?? {}, { userId: p.userId });
  });
  server.put("/api/tables/:id/rows/:rowId/owner", async (req) => {
    await assignRowOwner(app, need(req), params(req).id!, params(req).rowId!, str(body(req).ownerId) ?? null);
    return { ok: true };
  });
  server.delete("/api/tables/:id/rows/:rowId", async (req) => {
    const p = need(req);
    authorize(p, "editor", "write");
    return deleteRow(app, p, p.workspaceId, params(req).id!, params(req).rowId!, { userId: p.userId });
  });
  server.post("/api/tables/:id/import", async (req) => {
    const b = req.body;
    const csv = typeof b === "string" ? b : str((b as Body)?.csv);
    if (!csv) throw badRequest("Send CSV text as text/csv or { csv }.");
    return importCsv(app, need(req), params(req).id!, csv);
  });
  server.get("/api/tables/:id/export", async (req, reply) => {
    const p = reader(req);
    const { filename, csv } = await exportCsv(app, p, params(req).id!);
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${filename}"`);
    return csv;
  });

  // ---------------------------------------------------------------- forms
  server.get("/api/forms", async (req) => listForms(app, reader(req).workspaceId));
  server.post("/api/forms", async (req) => {
    const b = body(req);
    return createForm(app, need(req), { name: str(b.name) ?? "", description: str(b.description), fields: b.fields, tableId: str(b.tableId) ?? null, isPublic: b.isPublic === true, successMessage: str(b.successMessage) });
  });
  server.get("/api/forms/:id", async (req) => getForm(app, reader(req).workspaceId, params(req).id!));
  server.patch("/api/forms/:id", async (req) => {
    const b = body(req);
    return updateForm(app, need(req), params(req).id!, { name: str(b.name), description: str(b.description), fields: b.fields, isPublic: typeof b.isPublic === "boolean" ? b.isPublic : undefined, successMessage: str(b.successMessage) });
  });
  server.delete("/api/forms/:id", async (req) => {
    await deleteForm(app, need(req), params(req).id!);
    return { ok: true };
  });

  // ---------------------------------------------------------------- MCP servers (external)
  server.get("/api/mcp-servers", async (req) => {
    const p = reader(req);
    const servers = await listServers(app, p.workspaceId);
    return { servers, platformEndpoint: `${app.config.publicUrl}/mcp`, platformTools: PLATFORM_TOOLS };
  });
  server.post("/api/mcp-servers", async (req) => {
    const b = body(req);
    return registerServer(app, need(req), { name: str(b.name) ?? "", url: str(b.url) ?? "", credentialId: str(b.credentialId) ?? null, timeoutMs: num(b.timeoutMs) });
  });
  server.get("/api/mcp-servers/:id", async (req) => getServer(app, reader(req).workspaceId, params(req).id!));
  server.patch("/api/mcp-servers/:id", async (req) => {
    const b = body(req);
    return updateServer(app, need(req), params(req).id!, { name: str(b.name), enabled: typeof b.enabled === "boolean" ? b.enabled : undefined, timeoutMs: num(b.timeoutMs), toolPolicies: b.toolPolicies as never });
  });
  server.delete("/api/mcp-servers/:id", async (req) => {
    await deleteServer(app, need(req), params(req).id!);
    return { ok: true };
  });
  server.post("/api/mcp-servers/:id/refresh", async (req) => refreshTools(app, need(req), params(req).id!));
  server.post("/api/mcp-servers/:id/tools/:tool/test", async (req) => {
    const p = need(req);
    authorize(p, "admin", "admin");
    const args = (body(req).arguments as Record<string, unknown>) ?? {};
    return callExternalTool(app, p.workspaceId, params(req).id!, params(req).tool!, args, { actor: p.userId ?? "admin", purpose: "test" });
  });
  server.get("/api/mcp-calls", async (req) => {
    const p = reader(req);
    return app.db.query("SELECT id, direction, server_id, tool, actor, execution_id, status, duration_ms, error, created_at FROM mcp_tool_calls WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200", [p.workspaceId]);
  });

  server.get("/api/meta", async () => ({ brandName: app.config.brandName, registrationOpen: app.config.allowRegistration, version: "0.1.0", sso: app.config.oidc ? { label: app.config.oidc.label } : null }));
}
