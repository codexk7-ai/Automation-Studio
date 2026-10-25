import { redact } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import type { Queryable } from "../db/index.ts";
import type { Principal } from "../auth/principal.ts";

export interface AuditEntry {
  workspaceId: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

export async function audit(app: AppContext | { db: Queryable }, actor: Principal | { actorType: "system"; userId?: null }, entry: AuditEntry): Promise<void> {
  const actorId = "tokenId" in actor && actor.tokenId ? `token:${actor.tokenId}` : (actor.userId ?? null);
  await ("db" in app ? app.db : app).query(
    `INSERT INTO audit_logs (workspace_id, actor_type, actor_id, action, resource_type, resource_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [entry.workspaceId, actor.actorType, actorId, entry.action, entry.resourceType ?? null, entry.resourceId ?? null, redact(entry.details ?? {}), entry.ip ?? null],
  );
}

export async function listAudit(app: AppContext, workspaceId: string, opts: { limit: number; offset: number; action?: string }) {
  const params: unknown[] = [workspaceId];
  let where = "workspace_id = $1";
  if (opts.action) {
    params.push(`${opts.action}%`);
    where += ` AND action LIKE $${params.length}`;
  }
  params.push(opts.limit, opts.offset);
  const rows = await app.db.query(
    `SELECT id, actor_type, actor_id, action, resource_type, resource_id, details, ip, created_at FROM audit_logs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const [count] = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE ${where}`, params.slice(0, params.length - 2));
  return { items: rows, total: count?.n ?? 0 };
}
