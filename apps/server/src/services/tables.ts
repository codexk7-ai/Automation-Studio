import { roleAtLeast, toText, type Role } from "@automation-studio/core";
import Papa from "papaparse";
import type { AppContext } from "../context.ts";
import { emitEvent } from "../engine/events.ts";
import { badRequest, forbidden, notFound } from "../errors.ts";
import { randomId } from "../security/crypto.ts";
import type { Principal } from "../auth/principal.ts";
import { authorize } from "../auth/principal.ts";
import { audit } from "./audit.ts";

export const COLUMN_TYPES = ["text", "long_text", "number", "boolean", "date", "email", "url", "select", "json"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface ColumnDef {
  key: string;
  name: string;
  type: ColumnType;
  required?: boolean;
  unique?: boolean;
  options?: string[];
}

export interface DataTable {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  description: string;
  columns: ColumnDef[];
  retention_days: number | null;
  min_read_role: Role;
  min_write_role: Role;
  created_at: string;
  updated_at: string;
}

export interface RowFilter {
  column: string;
  op: "eq" | "neq" | "contains" | "gt" | "lt" | "empty" | "not_empty";
  value?: unknown;
}

/** Who is writing a row: a user or a workflow execution (for loop protection). */
export interface RowActor {
  userId?: string | null;
  executionId?: string;
  workflowId?: string;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function normalizeColumns(input: unknown): ColumnDef[] {
  if (!Array.isArray(input) || input.length === 0) throw badRequest("A table needs at least one column.");
  if (input.length > 100) throw badRequest("Tables are limited to 100 columns.");
  const seen = new Set<string>();
  return input.map((raw) => {
    const c = raw as Partial<ColumnDef>;
    const name = toText(c.name).trim();
    const key = (c.key ? toText(c.key) : name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")) || "column";
    if (!KEY_RE.test(key)) throw badRequest(`Invalid column key '${key}'. Use lowercase letters, digits and underscores.`);
    if (seen.has(key)) throw badRequest(`Duplicate column '${key}'.`);
    seen.add(key);
    const type = (COLUMN_TYPES as readonly string[]).includes(String(c.type)) ? (c.type as ColumnType) : "text";
    return {
      key,
      name: name || key,
      type,
      required: c.required === true,
      unique: c.unique === true,
      options: type === "select" ? (Array.isArray(c.options) ? c.options.map(toText).filter(Boolean).slice(0, 200) : []) : undefined,
    };
  });
}

/** Validates and coerces row data against the column definitions. */
export function validateRow(columns: ColumnDef[], data: Record<string, unknown>, partial = false): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw badRequest("Row data must be an object.");
  const byKey = new Map(columns.map((c) => [c.key, c]));
  for (const k of Object.keys(data)) if (!byKey.has(k)) throw badRequest(`Unknown column '${k}'.`);
  const out: Record<string, unknown> = {};
  for (const col of columns) {
    if (!(col.key in data)) {
      if (!partial && col.required) throw badRequest(`'${col.name}' is required.`);
      continue;
    }
    const v = data[col.key];
    if (v === null || v === undefined || v === "") {
      if (col.required) throw badRequest(`'${col.name}' is required.`);
      out[col.key] = null;
      continue;
    }
    switch (col.type) {
      case "number": {
        const n = typeof v === "number" ? v : Number(toText(v).replace(/,/g, ""));
        if (!Number.isFinite(n)) throw badRequest(`'${col.name}' must be a number.`);
        out[col.key] = n;
        break;
      }
      case "boolean":
        out[col.key] = typeof v === "boolean" ? v : ["true", "1", "yes", "y", "on"].includes(toText(v).toLowerCase());
        break;
      case "date": {
        const d = new Date(toText(v));
        if (Number.isNaN(d.getTime())) throw badRequest(`'${col.name}' must be a date.`);
        out[col.key] = d.toISOString();
        break;
      }
      case "email": {
        const s = toText(v).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw badRequest(`'${col.name}' must be a valid email address.`);
        out[col.key] = s;
        break;
      }
      case "url": {
        const s = toText(v).trim();
        try {
          const u = new URL(s);
          if (!["http:", "https:"].includes(u.protocol)) throw new Error();
        } catch {
          throw badRequest(`'${col.name}' must be an http(s) URL.`);
        }
        out[col.key] = s;
        break;
      }
      case "select": {
        const s = toText(v);
        if (col.options?.length && !col.options.includes(s)) throw badRequest(`'${col.name}' must be one of: ${col.options.join(", ")}.`);
        out[col.key] = s;
        break;
      }
      case "json":
        out[col.key] = typeof v === "string" ? safeJson(v, col.name) : v;
        break;
      default: {
        const s = toText(v);
        if (s.length > (col.type === "long_text" ? 100_000 : 5000)) throw badRequest(`'${col.name}' is too long.`);
        out[col.key] = s;
      }
    }
  }
  return out;
}

function safeJson(v: string, name: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    throw badRequest(`'${name}' must be valid JSON.`);
  }
}

export async function getTable(app: AppContext, workspaceId: string, id: string): Promise<DataTable> {
  const t = await app.db.one<DataTable>("SELECT * FROM data_tables WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  if (!t) throw notFound("Table");
  return t;
}

function checkTableRole(p: Principal | null, t: DataTable, write: boolean): void {
  if (!p) return; // workflow executions run with workspace-level system access
  const needed = write ? t.min_write_role : t.min_read_role;
  if (!roleAtLeast(p.role, needed)) throw forbidden(`This table requires the ${needed} role to ${write ? "modify" : "read"} records.`);
}

export async function listTables(app: AppContext, workspaceId: string): Promise<Array<DataTable & { row_count: number }>> {
  return app.db.query(
    `SELECT t.*, (SELECT count(*)::int FROM data_rows r WHERE r.table_id = t.id) AS row_count FROM data_tables t WHERE t.workspace_id = $1 ORDER BY t.name`,
    [workspaceId],
  );
}

export async function createTable(
  app: AppContext,
  p: Principal,
  input: { name: string; description?: string; columns: unknown; projectId?: string; retentionDays?: number | null; minReadRole?: Role; minWriteRole?: Role },
): Promise<DataTable> {
  authorize(p, "editor", "write");
  const name = toText(input.name).trim();
  if (!name || name.length > 200) throw badRequest("Table name is required (max 200 characters).");
  const columns = normalizeColumns(input.columns);
  const project = input.projectId
    ? await app.db.one<{ id: string }>("SELECT id FROM projects WHERE id = $1 AND workspace_id = $2", [input.projectId, p.workspaceId])
    : await app.db.one<{ id: string }>("SELECT id FROM projects WHERE workspace_id = $1 ORDER BY created_at LIMIT 1", [p.workspaceId]);
  if (!project) throw badRequest("Project not found.");
  const id = randomId("tbl");
  await app.db.query(
    `INSERT INTO data_tables (id, workspace_id, project_id, name, description, columns, retention_days, min_read_role, min_write_role) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, p.workspaceId, project.id, name, toText(input.description).slice(0, 2000), columns, input.retentionDays ?? null, input.minReadRole ?? "viewer", input.minWriteRole ?? "editor"],
  );
  await audit(app, p, { workspaceId: p.workspaceId, action: "table.create", resourceType: "table", resourceId: id, details: { name }, ip: p.ip });
  return getTable(app, p.workspaceId, id);
}

export async function updateTable(
  app: AppContext,
  p: Principal,
  id: string,
  input: { name?: string; description?: string; columns?: unknown; retentionDays?: number | null; minReadRole?: Role; minWriteRole?: Role },
): Promise<DataTable> {
  authorize(p, "editor", "write");
  const t = await getTable(app, p.workspaceId, id);
  const columns = input.columns !== undefined ? normalizeColumns(input.columns) : t.columns;
  await app.db.query(
    `UPDATE data_tables SET name = $3, description = $4, columns = $5, retention_days = $6, min_read_role = $7, min_write_role = $8, updated_at = now() WHERE id = $1 AND workspace_id = $2`,
    [
      id,
      p.workspaceId,
      input.name?.trim() || t.name,
      input.description ?? t.description,
      columns,
      input.retentionDays === undefined ? t.retention_days : input.retentionDays,
      input.minReadRole ?? t.min_read_role,
      input.minWriteRole ?? t.min_write_role,
    ],
  );
  await audit(app, p, { workspaceId: p.workspaceId, action: "table.update", resourceType: "table", resourceId: id, ip: p.ip });
  return getTable(app, p.workspaceId, id);
}

export async function deleteTable(app: AppContext, p: Principal, id: string): Promise<void> {
  authorize(p, "admin", "write");
  const rows = await app.db.query("DELETE FROM data_tables WHERE id = $1 AND workspace_id = $2 RETURNING id", [id, p.workspaceId]);
  if (!rows.length) throw notFound("Table");
  await audit(app, p, { workspaceId: p.workspaceId, action: "table.delete", resourceType: "table", resourceId: id, ip: p.ip });
}

export interface RowQuery {
  search?: string;
  filters?: RowFilter[];
  sort?: string;
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function queryRows(app: AppContext, p: Principal | null, workspaceId: string, tableId: string, q: RowQuery = {}) {
  const t = await getTable(app, workspaceId, tableId);
  checkTableRole(p, t, false);
  const colKeys = new Set(t.columns.map((c) => c.key));
  const params: unknown[] = [tableId];
  const where: string[] = ["table_id = $1"];
  if (q.search) {
    params.push(`%${q.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    where.push(`data::text ILIKE $${params.length}`);
  }
  for (const f of q.filters ?? []) {
    if (!colKeys.has(f.column)) throw badRequest(`Unknown column '${f.column}'.`);
    params.push(f.column);
    const col = `data->>$${params.length}`;
    switch (f.op) {
      case "eq":
        params.push(toText(f.value));
        where.push(`lower(${col}) = lower($${params.length})`);
        break;
      case "neq":
        params.push(toText(f.value));
        where.push(`(${col} IS NULL OR lower(${col}) <> lower($${params.length}))`);
        break;
      case "contains":
        params.push(`%${toText(f.value).replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
        where.push(`${col} ILIKE $${params.length}`);
        break;
      case "gt":
      case "lt": {
        params.push(Number(f.value));
        const keyIdx = params.length - 1;
        where.push(`jsonb_typeof(data->$${keyIdx}) = 'number' AND (data->>$${keyIdx})::numeric ${f.op === "gt" ? ">" : "<"} $${params.length}`);
        break;
      }
      case "empty":
        where.push(`(${col} IS NULL OR ${col} = '')`);
        break;
      case "not_empty":
        where.push(`(${col} IS NOT NULL AND ${col} <> '')`);
        break;
      default:
        throw badRequest(`Unknown filter operator '${String(f.op)}'.`);
    }
  }
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 1000);
  const offset = Math.max(Number(q.offset) || 0, 0);
  let order = "created_at DESC, id DESC";
  if (q.sort && (colKeys.has(q.sort) || q.sort === "created_at" || q.sort === "updated_at")) {
    const dir = q.direction === "asc" ? "ASC" : "DESC";
    if (q.sort === "created_at" || q.sort === "updated_at") order = `${q.sort} ${dir}, id`;
    else {
      params.push(q.sort);
      const isNum = t.columns.find((c) => c.key === q.sort)?.type === "number";
      order = isNum ? `CASE WHEN jsonb_typeof(data->$${params.length}) = 'number' THEN (data->>$${params.length})::numeric END ${dir} NULLS LAST, id` : `data->>$${params.length} ${dir} NULLS LAST, id`;
    }
  }
  const whereSql = where.join(" AND ");
  const countParams = params.filter((_, i) => i < params.length - (q.sort && colKeys.has(q.sort) ? 1 : 0));
  const [count] = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM data_rows WHERE ${whereSql}`, countParams);
  params.push(limit, offset);
  const rows = await app.db.query<{ id: string; data: Record<string, unknown>; created_at: string; updated_at: string }>(
    `SELECT id, data, created_at, updated_at FROM data_rows WHERE ${whereSql} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { table: t, rows, total: count?.n ?? 0, limit, offset };
}

async function assertUnique(app: AppContext, t: DataTable, data: Record<string, unknown>, excludeId?: string): Promise<void> {
  for (const col of t.columns.filter((c) => c.unique)) {
    const v = data[col.key];
    if (v === null || v === undefined || v === "") continue;
    const clash = await app.db.one<{ id: string }>(
      `SELECT id FROM data_rows WHERE table_id = $1 AND lower(data->>$2) = lower($3) ${excludeId ? "AND id <> $4" : ""} LIMIT 1`,
      excludeId ? [t.id, col.key, toText(v), excludeId] : [t.id, col.key, toText(v)],
    );
    if (clash) throw badRequest(`A record with ${col.name} '${toText(v)}' already exists.`);
  }
}

function eventPayload(t: DataTable, row: { id: string; data: unknown }, actor: RowActor, previous?: unknown) {
  return { tableId: t.id, tableName: t.name, row: { id: row.id, data: row.data }, previous, sourceWorkflowId: actor.workflowId, sourceExecutionId: actor.executionId };
}

export async function insertRow(app: AppContext, p: Principal | null, workspaceId: string, tableId: string, data: Record<string, unknown>, actor: RowActor = {}) {
  const t = await getTable(app, workspaceId, tableId);
  checkTableRole(p, t, true);
  const clean = validateRow(t.columns, data);
  await assertUnique(app, t, clean);
  const id = randomId("row");
  await app.db.query("INSERT INTO data_rows (id, table_id, workspace_id, data, created_by) VALUES ($1, $2, $3, $4, $5)", [id, tableId, workspaceId, clean, actor.executionId ? `execution:${actor.executionId}` : (actor.userId ?? p?.userId ?? null)]);
  const row = { id, data: clean };
  await emitEvent(app, workspaceId, "table.row.created", eventPayload(t, row, actor), { dedupeKey: `${id}:created` });
  return row;
}

export async function updateRow(app: AppContext, p: Principal | null, workspaceId: string, tableId: string, rowId: string, data: Record<string, unknown>, actor: RowActor = {}) {
  const t = await getTable(app, workspaceId, tableId);
  checkTableRole(p, t, true);
  const existing = await app.db.one<{ data: Record<string, unknown> }>("SELECT data FROM data_rows WHERE id = $1 AND table_id = $2", [rowId, tableId]);
  if (!existing) throw notFound("Record");
  const clean = validateRow(t.columns, data, true);
  const merged = { ...existing.data, ...clean };
  await assertUnique(app, t, merged, rowId);
  await app.db.query("UPDATE data_rows SET data = $3, updated_at = now() WHERE id = $1 AND table_id = $2", [rowId, tableId, merged]);
  const row = { id: rowId, data: merged };
  await emitEvent(app, workspaceId, "table.row.updated", eventPayload(t, row, actor, existing.data), { dedupeKey: `${rowId}:updated:${Date.now()}` });
  return row;
}

export async function deleteRow(app: AppContext, p: Principal | null, workspaceId: string, tableId: string, rowId: string, actor: RowActor = {}) {
  const t = await getTable(app, workspaceId, tableId);
  checkTableRole(p, t, true);
  const rows = await app.db.query<{ id: string; data: unknown }>("DELETE FROM data_rows WHERE id = $1 AND table_id = $2 RETURNING id, data", [rowId, tableId]);
  if (!rows.length) throw notFound("Record");
  await emitEvent(app, workspaceId, "table.row.deleted", eventPayload(t, rows[0]!, actor), { dedupeKey: `${rowId}:deleted` });
  return { id: rowId, deleted: true };
}

export async function getRow(app: AppContext, p: Principal | null, workspaceId: string, tableId: string, rowId: string) {
  const t = await getTable(app, workspaceId, tableId);
  checkTableRole(p, t, false);
  const row = await app.db.one("SELECT id, data, created_at, updated_at FROM data_rows WHERE id = $1 AND table_id = $2", [rowId, tableId]);
  if (!row) throw notFound("Record");
  return row;
}

/** Imports CSV text; header names are matched to column keys or names (case-insensitive). */
export async function importCsv(app: AppContext, p: Principal, tableId: string, csv: string): Promise<{ imported: number; errors: Array<{ line: number; message: string }> }> {
  authorize(p, "editor", "write");
  if (csv.length > 10_000_000) throw badRequest("CSV is larger than 10 MB.");
  const t = await getTable(app, p.workspaceId, tableId);
  checkTableRole(p, t, true);
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  if (parsed.data.length > 10_000) throw badRequest("CSV imports are limited to 10,000 rows.");
  const headerMap = new Map<string, string>();
  for (const h of parsed.meta.fields ?? []) {
    const col = t.columns.find((c) => c.key === h.toLowerCase() || c.name.toLowerCase() === h.trim().toLowerCase());
    if (col) headerMap.set(h, col.key);
  }
  let imported = 0;
  const errors: Array<{ line: number; message: string }> = [];
  for (const [i, raw] of parsed.data.entries()) {
    const data: Record<string, unknown> = {};
    for (const [h, v] of Object.entries(raw)) {
      const key = headerMap.get(h);
      if (key) data[key] = v;
    }
    try {
      await insertRow(app, p, p.workspaceId, tableId, data, { userId: p.userId });
      imported++;
    } catch (err) {
      if (errors.length < 100) errors.push({ line: i + 2, message: (err as Error).message });
    }
  }
  await audit(app, p, { workspaceId: p.workspaceId, action: "table.import", resourceType: "table", resourceId: tableId, details: { imported, failed: parsed.data.length - imported }, ip: p.ip });
  return { imported, errors };
}

/** CSV-escapes values and neutralizes spreadsheet formula injection. */
export function toCsv(columns: { key: string; name: string }[], rows: Array<Record<string, unknown>>): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => cell(c.name)).join(","), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(","))].join("\r\n");
}

export async function exportCsv(app: AppContext, p: Principal, tableId: string): Promise<{ filename: string; csv: string }> {
  const { table, rows } = await queryRows(app, p, p.workspaceId, tableId, { limit: 1000, sort: "created_at", direction: "asc" });
  let all = rows;
  for (let offset = 1000; all.length === offset && offset < 100_000; offset += 1000) {
    const more = await queryRows(app, p, p.workspaceId, tableId, { limit: 1000, offset, sort: "created_at", direction: "asc" });
    all = all.concat(more.rows);
  }
  return { filename: `${table.name.replace(/[^a-z0-9]+/gi, "_")}.csv`, csv: toCsv(table.columns, all.map((r) => r.data)) };
}
