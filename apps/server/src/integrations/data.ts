import { toText } from "@automation-studio/core";
import Papa from "papaparse";
import { AppError } from "../errors.ts";
import { StepError } from "../errors.ts";
import { deleteRow, getTable, insertRow, queryRows, toCsv, updateRow, type RowFilter } from "../services/tables.ts";
import { asArray } from "./core.ts";
import type { IntegrationModule, NodeImplementation, StepContext } from "./types.ts";

/** Converts service-level validation errors into permanent step errors. */
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw new StepError(err.status === 404 ? "config" : "permanent", err.message);
    throw err;
  }
}

const actor = (ctx: StepContext) => ({ executionId: ctx.executionId, workflowId: ctx.workflowId });
const TABLE_FIELD = { key: "tableId", label: "Table", type: "table" as const, required: true, allowExpressions: false };

const insert: NodeImplementation = {
  type: "tables.insert_row",
  integration: "tables",
  kind: "data",
  name: "Create record",
  description: "Add a record to a data table.",
  fields: [TABLE_FIELD, { key: "data", label: "Values", type: "keyvalue", required: true, description: "Column key → value." }],
  sideEffects: "internal",
  sampleOutput: { id: "row_123", data: { name: "Ada" } },
  mode: "local",
  async execute(ctx) {
    return { output: await wrap(() => insertRow(ctx.app, null, ctx.workspaceId, String(ctx.config.tableId), (ctx.config.data as Record<string, unknown>) ?? {}, actor(ctx))) };
  },
};

const update: NodeImplementation = {
  type: "tables.update_row",
  integration: "tables",
  kind: "data",
  name: "Update record",
  description: "Update fields of an existing record by ID.",
  fields: [TABLE_FIELD, { key: "rowId", label: "Record ID", type: "string", required: true }, { key: "data", label: "Values to change", type: "keyvalue", required: true }],
  sideEffects: "internal",
  sampleOutput: { id: "row_123", data: { status: "contacted" } },
  mode: "local",
  async execute(ctx) {
    return { output: await wrap(() => updateRow(ctx.app, null, ctx.workspaceId, String(ctx.config.tableId), toText(ctx.config.rowId), (ctx.config.data as Record<string, unknown>) ?? {}, actor(ctx))) };
  },
};

const upsert: NodeImplementation = {
  type: "tables.upsert_row",
  integration: "tables",
  kind: "data",
  name: "Create or update record",
  description: "Find a record by a matching column (e.g. email); update it if found, otherwise create it. Useful for de-duplication.",
  fields: [TABLE_FIELD, { key: "matchColumn", label: "Match on column", type: "string", required: true, allowExpressions: false, placeholder: "email" }, { key: "data", label: "Values", type: "keyvalue", required: true }],
  sideEffects: "internal",
  sampleOutput: { id: "row_123", created: false, data: {} },
  mode: "local",
  async execute(ctx) {
    const data = (ctx.config.data as Record<string, unknown>) ?? {};
    const column = String(ctx.config.matchColumn);
    const value = data[column];
    if (value === undefined || value === null || value === "") throw new StepError("config", `The value for match column '${column}' is empty.`);
    const tableId = String(ctx.config.tableId);
    const found = await wrap(() => queryRows(ctx.app, null, ctx.workspaceId, tableId, { filters: [{ column, op: "eq", value }], limit: 1 }));
    if (found.rows[0]) {
      const row = await wrap(() => updateRow(ctx.app, null, ctx.workspaceId, tableId, found.rows[0]!.id, data, actor(ctx)));
      return { output: { ...row, created: false } };
    }
    const row = await wrap(() => insertRow(ctx.app, null, ctx.workspaceId, tableId, data, actor(ctx)));
    return { output: { ...row, created: true } };
  },
};

const find: NodeImplementation = {
  type: "tables.find_rows",
  integration: "tables",
  kind: "data",
  name: "Find records",
  description: "Search a table with filters. Returns matching records and the first match.",
  fields: [
    TABLE_FIELD,
    { key: "filters", label: "Filters", type: "json", default: [], description: 'List of { "column": "email", "op": "eq", "value": "{{ trigger.body.email }}" }. Ops: eq, neq, contains, gt, lt, empty, not_empty.' },
    { key: "search", label: "Full-text search", type: "string" },
    { key: "limit", label: "Limit", type: "number", default: 50, min: 1, max: 1000 },
  ],
  sampleOutput: { count: 1, total: 1, found: true, first: { id: "row_1", data: {} }, rows: [] },
  mode: "local",
  testable: true,
  async execute(ctx) {
    const filters = asArray(ctx.config.filters, "Filters") as RowFilter[];
    const res = await wrap(() => queryRows(ctx.app, null, ctx.workspaceId, String(ctx.config.tableId), { filters, search: toText(ctx.config.search) || undefined, limit: Number(ctx.config.limit) || 50 }));
    const rows = res.rows.map((r) => ({ id: r.id, data: r.data, createdAt: r.created_at }));
    return { output: { count: rows.length, total: res.total, found: rows.length > 0, first: rows[0] ?? null, rows } };
  },
};

const remove: NodeImplementation = {
  type: "tables.delete_row",
  integration: "tables",
  kind: "data",
  name: "Delete record",
  description: "Delete a record by ID.",
  fields: [TABLE_FIELD, { key: "rowId", label: "Record ID", type: "string", required: true }],
  sideEffects: "internal",
  minRole: "editor",
  sampleOutput: { id: "row_123", deleted: true },
  mode: "local",
  async execute(ctx) {
    return { output: await wrap(() => deleteRow(ctx.app, null, ctx.workspaceId, String(ctx.config.tableId), toText(ctx.config.rowId), actor(ctx))) };
  },
};

const csvParse: NodeImplementation = {
  type: "csv.parse",
  integration: "csv",
  kind: "data",
  name: "Parse CSV",
  description: "Convert CSV text into a list of objects (first row = headers).",
  fields: [
    { key: "csv", label: "CSV text", type: "text", required: true },
    { key: "delimiter", label: "Delimiter", type: "string", default: "", placeholder: "auto", allowExpressions: false },
    { key: "maxRows", label: "Maximum rows", type: "number", default: 10000, min: 1, max: 100000 },
  ],
  sampleOutput: { count: 1, headers: ["name", "email"], rows: [{ name: "Ada", email: "ada@example.com" }] },
  mode: "local",
  testable: true,
  async execute(ctx) {
    const text = toText(ctx.config.csv);
    if (text.length > 20_000_000) throw new StepError("config", "CSV input is larger than 20 MB.");
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, delimiter: toText(ctx.config.delimiter) || undefined });
    const max = Number(ctx.config.maxRows) || 10000;
    if (parsed.data.length > max) throw new StepError("config", `CSV has ${parsed.data.length} rows, more than the maximum of ${max}.`);
    return { output: { count: parsed.data.length, headers: parsed.meta.fields ?? [], rows: parsed.data, errors: parsed.errors.slice(0, 20).map((e) => ({ row: e.row, message: e.message })) } };
  },
};

const csvGenerate: NodeImplementation = {
  type: "csv.generate",
  integration: "csv",
  kind: "data",
  name: "Create CSV",
  description: "Convert a list of objects (or table records) into CSV text, e.g. for a scheduled export email.",
  fields: [
    { key: "items", label: "Items", type: "string", required: true, placeholder: "{{ steps.find.output.rows }}" },
    { key: "columns", label: "Columns (optional)", type: "string_list", description: "Field names to include, in order. Defaults to all keys of the first item." },
  ],
  sampleOutput: { csv: "name,email\r\nAda,ada@example.com", count: 1 },
  mode: "local",
  testable: true,
  async execute(ctx) {
    const items = asArray(ctx.config.items, "Items").map((i) => (i && typeof i === "object" && "data" in (i as object) && "id" in (i as object) ? ((i as { data: Record<string, unknown> }).data ?? {}) : (i as Record<string, unknown>)));
    let cols = Array.isArray(ctx.config.columns) ? (ctx.config.columns as unknown[]).map(toText) : toText(ctx.config.columns).split(",").map((s) => s.trim()).filter(Boolean);
    if (!cols.length) cols = Object.keys(items[0] ?? {});
    return { output: { csv: toCsv(cols.map((c) => ({ key: c, name: c })), items), count: items.length } };
  },
};

const tableExport: NodeImplementation = {
  type: "tables.export_csv",
  integration: "tables",
  kind: "data",
  name: "Export table to CSV",
  description: "Export all records of a table (up to 100,000) as CSV text.",
  fields: [TABLE_FIELD],
  sampleOutput: { csv: "Name,Email\r\n…", count: 10, filename: "Leads.csv" },
  mode: "local",
  async execute(ctx) {
    const t = await wrap(() => getTable(ctx.app, ctx.workspaceId, String(ctx.config.tableId)));
    const all = [];
    for (let offset = 0; offset < 100_000; offset += 1000) {
      const res = await queryRows(ctx.app, null, ctx.workspaceId, t.id, { limit: 1000, offset, sort: "created_at", direction: "asc" });
      all.push(...res.rows.map((r) => r.data));
      if (res.rows.length < 1000) break;
    }
    return { output: { csv: toCsv(t.columns, all), count: all.length, filename: `${t.name.replace(/[^a-z0-9]+/gi, "_")}.csv` } };
  },
};

export const tablesIntegration: IntegrationModule = {
  definition: {
    id: "tables",
    name: "Data tables",
    description: "Built-in tables for leads, contacts, tickets and any structured business data.",
    category: "Built-in",
    version: "1.0.0",
    icon: "table",
    credentialTypes: [],
    prerequisites: [],
    availability: "local",
  },
  nodes: [insert, update, upsert, find, remove, tableExport],
};

export const csvIntegration: IntegrationModule = {
  definition: {
    id: "csv",
    name: "CSV",
    description: "Parse and generate CSV files.",
    category: "Built-in",
    version: "1.0.0",
    icon: "file-spreadsheet",
    credentialTypes: [],
    prerequisites: [],
    availability: "local",
  },
  nodes: [csvParse, csvGenerate],
};
