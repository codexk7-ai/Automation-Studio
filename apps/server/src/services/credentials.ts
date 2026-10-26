import { isSensitiveKey, type FieldSpec } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { badRequest, notFound } from "../errors.ts";
import type { LoadedCredential } from "../integrations/types.ts";
import { randomId } from "../security/crypto.ts";
import type { Principal } from "../auth/principal.ts";
import { authorize } from "../auth/principal.ts";
import { audit } from "./audit.ts";

export interface CredentialSummary {
  id: string;
  name: string;
  type: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

/** Additional authenticated data binds each ciphertext to its row and tenant. */
const aad = (workspaceId: string, id: string) => `credential:${workspaceId}:${id}`;

function validateFields(fields: FieldSpec[], data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = data[f.key];
    if (v === undefined || v === null || v === "") {
      if (f.required) throw badRequest(`${f.label} is required.`);
      if (f.default !== undefined) out[f.key] = f.default;
      continue;
    }
    if (f.type === "number") {
      const n = Number(v);
      if (Number.isNaN(n)) throw badRequest(`${f.label} must be a number.`);
      out[f.key] = n;
    } else if (f.type === "boolean") out[f.key] = v === true || v === "true";
    else if (f.type === "select" && !f.options?.some((o) => o.value === v)) throw badRequest(`${f.label} must be one of ${f.options?.map((o) => o.value).join(", ")}.`);
    else out[f.key] = typeof v === "string" ? v.trim() : v;
    if (typeof out[f.key] === "string" && (out[f.key] as string).length > 20_000) throw badRequest(`${f.label} is too long.`);
  }
  return out;
}

export async function listCredentials(app: AppContext, workspaceId: string, type?: string): Promise<CredentialSummary[]> {
  return app.db.query<CredentialSummary>(
    `SELECT id, name, type, metadata, created_at, updated_at, last_used_at FROM credentials WHERE workspace_id = $1 ${type ? "AND type = $2" : ""} ORDER BY name`,
    type ? [workspaceId, type] : [workspaceId],
  );
}

export async function credentialTypeMap(app: AppContext, workspaceId: string): Promise<Map<string, string>> {
  const rows = await app.db.query<{ id: string; type: string }>("SELECT id, type FROM credentials WHERE workspace_id = $1", [workspaceId]);
  return new Map(rows.map((r) => [r.id, r.type]));
}

export async function createCredential(
  app: AppContext,
  p: Principal,
  input: { name: string; type: string; data: Record<string, unknown>; metadata?: Record<string, unknown> },
): Promise<CredentialSummary> {
  authorize(p, "editor", "write");
  const ct = app.registry.getCredentialType(input.type);
  if (!ct) throw badRequest(`Unknown connection type '${input.type}'.`);
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 200) throw badRequest("Name is required (max 200 characters).");
  const data = validateFields(ct.fields, input.data ?? {});
  const id = randomId("cred");
  const metadata = { ...(input.metadata ?? {}), ...(ct.describe?.(data) ?? {}) };
  await app.db.query(`INSERT INTO credentials (id, workspace_id, name, type, encrypted_data, metadata, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    id,
    p.workspaceId,
    name,
    input.type,
    app.secrets.encryptJson(data, aad(p.workspaceId, id)),
    metadata,
    p.userId,
  ]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "credential.create", resourceType: "credential", resourceId: id, details: { name, type: input.type }, ip: p.ip });
  return (await listCredentials(app, p.workspaceId)).find((c) => c.id === id)!;
}

export async function updateCredential(app: AppContext, p: Principal, id: string, input: { name?: string; data?: Record<string, unknown> }): Promise<CredentialSummary> {
  authorize(p, "editor", "write");
  const row = await app.db.one<{ type: string; encrypted_data: string; name: string }>("SELECT type, encrypted_data, name FROM credentials WHERE id = $1 AND workspace_id = $2", [id, p.workspaceId]);
  if (!row) throw notFound("Connection");
  const ct = app.registry.getCredentialType(row.type);
  if (!ct) throw badRequest(`Unknown connection type '${row.type}'.`);
  const current = app.secrets.decryptJson(row.encrypted_data, aad(p.workspaceId, id));
  // Empty secret fields mean "keep the existing value" so the UI never needs to read secrets back.
  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(input.data ?? {})) if (v !== "" && v !== null && v !== undefined) merged[k] = v;
  const data = validateFields(ct.fields, merged);
  const name = input.name?.trim() || row.name;
  await app.db.query("UPDATE credentials SET name = $1, encrypted_data = $2, metadata = metadata || $3::jsonb, updated_at = now() WHERE id = $4 AND workspace_id = $5", [
    name,
    app.secrets.encryptJson(data, aad(p.workspaceId, id)),
    ct.describe?.(data) ?? {},
    id,
    p.workspaceId,
  ]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "credential.update", resourceType: "credential", resourceId: id, details: { name }, ip: p.ip });
  return (await listCredentials(app, p.workspaceId)).find((c) => c.id === id)!;
}

export async function deleteCredential(app: AppContext, p: Principal, id: string): Promise<void> {
  authorize(p, "admin", "write");
  const rows = await app.db.query("DELETE FROM credentials WHERE id = $1 AND workspace_id = $2 RETURNING id", [id, p.workspaceId]);
  if (!rows.length) throw notFound("Connection");
  await audit(app, p, { workspaceId: p.workspaceId, action: "credential.delete", resourceType: "credential", resourceId: id, ip: p.ip });
}

/**
 * Decrypts a credential for execution. Always scoped by workspace: a workflow
 * can never load another tenant's secret even with a guessed ID. Refreshes
 * OAuth tokens that expire within two minutes.
 */
export async function loadCredential(app: AppContext, workspaceId: string, id: string): Promise<LoadedCredential> {
  const row = await app.db.one<{ id: string; name: string; type: string; encrypted_data: string }>("SELECT id, name, type, encrypted_data FROM credentials WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  if (!row) throw notFound("Connection");
  let data = app.secrets.decryptJson(row.encrypted_data, aad(workspaceId, id));
  const ct = app.registry.getCredentialType(row.type);
  const expiresAt = typeof data.expires_at === "number" ? data.expires_at : undefined;
  if (ct?.refresh && expiresAt && expiresAt - Date.now() < 120_000) {
    const refreshed = await ct.refresh(data, app);
    if (refreshed) {
      data = refreshed;
      await app.db.query("UPDATE credentials SET encrypted_data = $1, updated_at = now() WHERE id = $2 AND workspace_id = $3", [app.secrets.encryptJson(data, aad(workspaceId, id)), id, workspaceId]);
    }
  }
  await app.db.query("UPDATE credentials SET last_used_at = now() WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  return { id: row.id, name: row.name, type: row.type, data };
}

/** Stores new secret data for an existing credential (OAuth callback, token refresh). */
export async function storeCredentialData(app: AppContext, workspaceId: string, id: string, data: Record<string, unknown>, metadata: Record<string, unknown> = {}): Promise<void> {
  await app.db.query("UPDATE credentials SET encrypted_data = $1, metadata = metadata || $2::jsonb, updated_at = now() WHERE id = $3 AND workspace_id = $4", [
    app.secrets.encryptJson(data, aad(workspaceId, id)),
    metadata,
    id,
    workspaceId,
  ]);
}

export async function insertCredentialRaw(app: AppContext, workspaceId: string, userId: string | null, name: string, type: string, data: Record<string, unknown>, metadata: Record<string, unknown> = {}): Promise<string> {
  const id = randomId("cred");
  await app.db.query(`INSERT INTO credentials (id, workspace_id, name, type, encrypted_data, metadata, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    id,
    workspaceId,
    name,
    type,
    app.secrets.encryptJson(data, aad(workspaceId, id)),
    metadata,
    userId,
  ]);
  return id;
}

export async function testCredential(app: AppContext, p: Principal, id: string): Promise<{ ok: boolean; message: string }> {
  authorize(p, "editor", "execute");
  const cred = await loadCredential(app, p.workspaceId, id);
  const ct = app.registry.getCredentialType(cred.type);
  if (!ct?.test) return { ok: true, message: "This connection type has no automatic test; it will be verified on first use." };
  try {
    return await ct.test(cred.data, app);
  } catch (err) {
    return { ok: false, message: (err as Error).message.slice(0, 500) };
  }
}

/**
 * Secret values of a credential, used for log/output redaction: fields the
 * credential type marks sensitive, fields not declared by the type (OAuth
 * tokens) and keys that look secret. Non-secret settings such as a provider
 * name or host are not redacted.
 */
export function secretValues(data: Record<string, unknown>, fields: FieldSpec[] = []): string[] {
  const declared = new Map(fields.map((f) => [f.key, f]));
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string" && v.length >= 6) out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  for (const [key, value] of Object.entries(data)) {
    const field = declared.get(key);
    if (!field || field.sensitive || isSensitiveKey(key)) visit(value);
  }
  return out;
}
