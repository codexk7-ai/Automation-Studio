import { ROLES, roleAtLeast, type Role } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.ts";
import { hashPassword, randomId, randomToken, sha256, verifyPassword } from "../security/crypto.ts";
import { API_SCOPES, authorize, type ApiScope, type Principal } from "../auth/principal.ts";
import { audit } from "./audit.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

export function validatePassword(pw: string): void {
  if (typeof pw !== "string" || pw.length < 10) throw badRequest("Passwords must be at least 10 characters.");
  if (pw.length > 200) throw badRequest("Password is too long.");
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
}

/** Creates a user with their own workspace (owner) and a default project. */
export async function registerUser(app: AppContext, input: { email: string; name: string; password: string; workspaceName?: string }): Promise<{ user: UserRow; workspaceId: string }> {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw badRequest("A valid email is required.");
  const name = String(input.name ?? "").trim().slice(0, 200) || email.split("@")[0]!;
  validatePassword(input.password);
  const existing = await app.db.one("SELECT id FROM users WHERE lower(email) = $1", [email]);
  if (existing) throw conflict("An account with this email already exists.");
  const userId = randomId("usr");
  const workspaceId = randomId("ws");
  const passwordHash = await hashPassword(input.password);
  await app.db.transaction(async (tx) => {
    await tx.query("INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)", [userId, email, name, passwordHash]);
    await tx.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [workspaceId, input.workspaceName?.trim().slice(0, 200) || `${name}'s workspace`]);
    await tx.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspaceId, userId]);
    await tx.query("INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, 'Default project')", [randomId("prj"), workspaceId]);
  });
  await audit(app, { actorType: "user", userId, workspaceId, role: "owner" }, { workspaceId, action: "user.register", resourceType: "user", resourceId: userId });
  return { user: { id: userId, email, name }, workspaceId };
}

export async function authenticate(app: AppContext, emailInput: string, password: string, ip?: string): Promise<UserRow> {
  const email = String(emailInput ?? "").trim().toLowerCase();
  const user = await app.db.one<UserRow & { password_hash: string; is_active: boolean; failed_logins: number; locked_until: string | null; totp_enabled: boolean }>(
    "SELECT id, email, name, password_hash, is_active, failed_logins, locked_until, totp_enabled FROM users WHERE lower(email) = $1",
    [email],
  );
  // Constant-ish work for unknown users to reduce account enumeration via timing.
  if (!user) {
    await verifyPassword(password ?? "", "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
    throw unauthorized("Invalid email or password.");
  }
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) throw unauthorized("Too many failed attempts. Try again in a few minutes.");
  const ok = await verifyPassword(String(password ?? ""), user.password_hash);
  if (!ok || !user.is_active) {
    const failed = user.failed_logins + 1;
    await app.db.query("UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1", [user.id, failed >= MAX_FAILED_LOGINS ? 0 : failed, failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null]);
    await audit(app, { actorType: "system" }, { workspaceId: null, action: "auth.login_failed", resourceType: "user", resourceId: user.id, ip });
    throw unauthorized("Invalid email or password.");
  }
  // With 2FA on, the counter only resets after the second factor succeeds (see mfa.ts),
  // so a known password cannot be used to keep retrying codes.
  if (!user.totp_enabled) await app.db.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [user.id]);
  return { id: user.id, email: user.email, name: user.name };
}

export async function firstWorkspaceFor(app: AppContext, userId: string): Promise<string | null> {
  const row = await app.db.one<{ workspace_id: string }>("SELECT workspace_id FROM workspace_members WHERE user_id = $1 ORDER BY created_at LIMIT 1", [userId]);
  return row?.workspace_id ?? null;
}

// ---------------------------------------------------------------------------
// Sessions (HttpOnly cookie holding a random token; only its hash is stored)

export async function createSession(app: AppContext, userId: string, workspaceId: string | null, meta: { ip?: string; userAgent?: string }) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + app.config.sessionTtlHours * 3_600_000);
  await app.db.query("INSERT INTO sessions (id, user_id, workspace_id, csrf_token, ip, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    sha256(token),
    userId,
    workspaceId,
    csrf,
    meta.ip ?? null,
    (meta.userAgent ?? "").slice(0, 300),
    expires,
  ]);
  return { token, csrf, expires };
}

export async function resolveSession(app: AppContext, token: string): Promise<{ sessionId: string; userId: string; workspaceId: string | null; csrf: string } | null> {
  if (!token || token.length > 200) return null;
  const s = await app.db.one<{ id: string; user_id: string; workspace_id: string | null; csrf_token: string }>(
    "SELECT s.id, s.user_id, s.workspace_id, s.csrf_token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now() AND u.is_active",
    [sha256(token)],
  );
  return s ? { sessionId: s.id, userId: s.user_id, workspaceId: s.workspace_id, csrf: s.csrf_token } : null;
}

export async function destroySession(app: AppContext, token: string): Promise<void> {
  await app.db.query("DELETE FROM sessions WHERE id = $1", [sha256(token)]);
}

export async function switchSessionWorkspace(app: AppContext, sessionId: string, userId: string, workspaceId: string): Promise<void> {
  const m = await app.db.one("SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
  if (!m) throw forbidden("You are not a member of that workspace.");
  await app.db.query("UPDATE sessions SET workspace_id = $2 WHERE id = $1", [sessionId, workspaceId]);
}

export async function roleIn(app: AppContext, userId: string, workspaceId: string): Promise<Role | null> {
  const m = await app.db.one<{ role: Role }>("SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
  return m?.role ?? null;
}

// ---------------------------------------------------------------------------
// API tokens (for the REST API and MCP clients)

export async function createApiToken(app: AppContext, p: Principal, input: { name: string; scopes: string[]; expiresInDays?: number | null }) {
  authorize(p, "editor", "admin");
  if (p.actorType !== "user") throw forbidden("API tokens can only be created by signed-in users.");
  const name = String(input.name ?? "").trim().slice(0, 100);
  if (!name) throw badRequest("Token name is required.");
  const scopes = [...new Set((input.scopes ?? []).filter((s): s is ApiScope => (API_SCOPES as string[]).includes(s)))];
  if (!scopes.length) throw badRequest(`Choose at least one scope: ${API_SCOPES.join(", ")}.`);
  if (scopes.includes("admin") && !roleAtLeast(p.role, "admin")) throw forbidden("Only admins can create tokens with the admin scope.");
  const raw = `as_${randomToken(32)}`;
  const id = randomId("tok");
  const expiresAt = input.expiresInDays ? new Date(Date.now() + Math.min(3650, input.expiresInDays) * 86_400_000) : null;
  await app.db.query("INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, token_prefix, scopes, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
    id,
    p.workspaceId,
    p.userId,
    name,
    sha256(raw),
    raw.slice(0, 10),
    scopes,
    expiresAt,
  ]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "api_token.create", resourceType: "api_token", resourceId: id, details: { name, scopes }, ip: p.ip });
  return { id, name, scopes, token: raw, expiresAt };
}

export async function listApiTokens(app: AppContext, p: Principal) {
  return app.db.query(
    "SELECT id, name, token_prefix, scopes, last_used_at, expires_at, revoked_at, created_at, user_id FROM api_tokens WHERE workspace_id = $1 ORDER BY created_at DESC",
    [p.workspaceId],
  );
}

export async function revokeApiToken(app: AppContext, p: Principal, id: string): Promise<void> {
  authorize(p, "editor", "admin");
  const row = await app.db.one<{ user_id: string }>("SELECT user_id FROM api_tokens WHERE id = $1 AND workspace_id = $2", [id, p.workspaceId]);
  if (!row) throw notFound("API token");
  if (row.user_id !== p.userId && !roleAtLeast(p.role, "admin")) throw forbidden("Only admins can revoke other members' tokens.");
  await app.db.query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1", [id]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "api_token.revoke", resourceType: "api_token", resourceId: id, ip: p.ip });
}

/** Resolves a bearer API token to a principal, using the creator's *current* role. */
export async function principalFromApiToken(app: AppContext, raw: string, ip?: string): Promise<Principal | null> {
  if (!raw.startsWith("as_") || raw.length > 200) return null;
  const t = await app.db.one<{ id: string; workspace_id: string; user_id: string; scopes: ApiScope[] }>(
    "SELECT id, workspace_id, user_id, scopes FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
    [sha256(raw)],
  );
  if (!t) return null;
  const role = await roleIn(app, t.user_id, t.workspace_id);
  if (!role) return null;
  await app.db.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [t.id]);
  return { actorType: "api_token", userId: t.user_id, workspaceId: t.workspace_id, role, scopes: t.scopes, tokenId: t.id, ip };
}

// ---------------------------------------------------------------------------
// Members

export async function listMembers(app: AppContext, workspaceId: string) {
  return app.db.query(
    "SELECT u.id, u.email, u.name, m.role, m.created_at FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at",
    [workspaceId],
  );
}

/**
 * Adds an existing user, or creates an account with a temporary password the
 * admin hands over out-of-band (no email delivery is assumed locally).
 */
export async function addMember(app: AppContext, p: Principal, input: { email: string; role: Role; name?: string }) {
  authorize(p, "admin", "admin");
  if (!ROLES.includes(input.role)) throw badRequest("Invalid role.");
  if (input.role === "owner" && p.role !== "owner") throw forbidden("Only owners can add owners.");
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest("A valid email is required.");
  let user = await app.db.one<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [email]);
  let temporaryPassword: string | undefined;
  if (!user) {
    temporaryPassword = randomToken(12);
    const id = randomId("usr");
    await app.db.query("INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)", [id, email, input.name?.trim() || email.split("@")[0], await hashPassword(temporaryPassword)]);
    user = { id };
  }
  const exists = await app.db.one("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [p.workspaceId, user.id]);
  if (exists) throw conflict("That user is already a member.");
  await app.db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)", [p.workspaceId, user.id, input.role]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "member.add", resourceType: "user", resourceId: user.id, details: { email, role: input.role }, ip: p.ip });
  return { userId: user.id, email, role: input.role, temporaryPassword };
}

export async function updateMemberRole(app: AppContext, p: Principal, userId: string, role: Role) {
  authorize(p, "admin", "admin");
  if (!ROLES.includes(role)) throw badRequest("Invalid role.");
  const current = await roleIn(app, userId, p.workspaceId);
  if (!current) throw notFound("Member");
  if ((current === "owner" || role === "owner") && p.role !== "owner") throw forbidden("Only owners can change owner roles.");
  if (current === "owner" && role !== "owner") {
    const owners = await app.db.one<{ n: number }>("SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'", [p.workspaceId]);
    if ((owners?.n ?? 0) <= 1) throw badRequest("A workspace needs at least one owner.");
  }
  await app.db.query("UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2", [p.workspaceId, userId, role]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "member.role", resourceType: "user", resourceId: userId, details: { role }, ip: p.ip });
}

export async function removeMember(app: AppContext, p: Principal, userId: string) {
  authorize(p, "admin", "admin");
  const current = await roleIn(app, userId, p.workspaceId);
  if (!current) throw notFound("Member");
  if (current === "owner") throw badRequest("Transfer ownership before removing an owner.");
  await app.db.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [p.workspaceId, userId]);
  await app.db.query("DELETE FROM sessions WHERE user_id = $1 AND workspace_id = $2", [userId, p.workspaceId]);
  await app.db.query("UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1 AND workspace_id = $2 AND revoked_at IS NULL", [userId, p.workspaceId]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "member.remove", resourceType: "user", resourceId: userId, ip: p.ip });
}

export async function changePassword(app: AppContext, userId: string, current: string, next: string): Promise<void> {
  const u = await app.db.one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [userId]);
  if (!u || !(await verifyPassword(current ?? "", u.password_hash))) throw unauthorized("Current password is incorrect.");
  validatePassword(next);
  await app.db.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [userId, await hashPassword(next)]);
  await app.db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}
