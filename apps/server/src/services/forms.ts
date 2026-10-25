import { toText } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { emitEvent } from "../engine/events.ts";
import { badRequest, notFound } from "../errors.ts";
import { randomId, randomToken } from "../security/crypto.ts";
import type { Principal } from "../auth/principal.ts";
import { authorize } from "../auth/principal.ts";
import { audit } from "./audit.ts";
import { getTable, insertRow } from "./tables.ts";

export interface FormField {
  key: string;
  label: string;
  type: "text" | "long_text" | "email" | "number" | "select" | "checkbox" | "url" | "phone";
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

export interface FormRow {
  id: string;
  workspace_id: string;
  table_id: string | null;
  name: string;
  slug: string;
  description: string;
  fields: FormField[];
  is_public: boolean;
  success_message: string;
}

const FIELD_TYPES = ["text", "long_text", "email", "number", "select", "checkbox", "url", "phone"];

function normalizeFields(input: unknown): FormField[] {
  if (!Array.isArray(input) || !input.length) throw badRequest("A form needs at least one field.");
  if (input.length > 50) throw badRequest("Forms are limited to 50 fields.");
  const seen = new Set<string>();
  return input.map((raw) => {
    const f = raw as Partial<FormField>;
    const key = toText(f.key).trim();
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(key)) throw badRequest(`Invalid field key '${key}'.`);
    if (seen.has(key)) throw badRequest(`Duplicate field '${key}'.`);
    seen.add(key);
    return {
      key,
      label: toText(f.label).trim().slice(0, 200) || key,
      type: (FIELD_TYPES.includes(String(f.type)) ? f.type : "text") as FormField["type"],
      required: f.required === true,
      options: Array.isArray(f.options) ? f.options.map(toText).slice(0, 100) : undefined,
      placeholder: f.placeholder ? toText(f.placeholder).slice(0, 200) : undefined,
    };
  });
}

export async function listForms(app: AppContext, workspaceId: string) {
  return app.db.query<FormRow>("SELECT * FROM forms WHERE workspace_id = $1 ORDER BY name", [workspaceId]);
}

export async function getForm(app: AppContext, workspaceId: string, id: string): Promise<FormRow> {
  const f = await app.db.one<FormRow>("SELECT * FROM forms WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  if (!f) throw notFound("Form");
  return f;
}

export async function createForm(app: AppContext, p: Principal, input: { name: string; description?: string; fields: unknown; tableId?: string | null; isPublic?: boolean; successMessage?: string }) {
  authorize(p, "editor", "write");
  const name = toText(input.name).trim();
  if (!name) throw badRequest("Form name is required.");
  const fields = normalizeFields(input.fields);
  if (input.tableId) {
    const t = await getTable(app, p.workspaceId, input.tableId);
    const cols = new Set(t.columns.map((c) => c.key));
    const missing = fields.filter((f) => !cols.has(f.key)).map((f) => f.key);
    if (missing.length) throw badRequest(`These fields have no matching table column: ${missing.join(", ")}`);
  }
  const id = randomId("frm");
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "form"}-${randomToken(5).toLowerCase()}`;
  await app.db.query("INSERT INTO forms (id, workspace_id, table_id, name, slug, description, fields, is_public, success_message) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
    id,
    p.workspaceId,
    input.tableId ?? null,
    name.slice(0, 200),
    slug,
    toText(input.description).slice(0, 2000),
    fields,
    input.isPublic === true,
    toText(input.successMessage).slice(0, 500) || "Thanks! Your response has been recorded.",
  ]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "form.create", resourceType: "form", resourceId: id, details: { name }, ip: p.ip });
  return getForm(app, p.workspaceId, id);
}

export async function updateForm(app: AppContext, p: Principal, id: string, input: { name?: string; description?: string; fields?: unknown; isPublic?: boolean; successMessage?: string }) {
  authorize(p, "editor", "write");
  const f = await getForm(app, p.workspaceId, id);
  await app.db.query("UPDATE forms SET name = $3, description = $4, fields = $5, is_public = $6, success_message = $7, updated_at = now() WHERE id = $1 AND workspace_id = $2", [
    id,
    p.workspaceId,
    input.name?.trim() || f.name,
    input.description ?? f.description,
    input.fields !== undefined ? normalizeFields(input.fields) : f.fields,
    input.isPublic ?? f.is_public,
    input.successMessage ?? f.success_message,
  ]);
  await audit(app, p, { workspaceId: p.workspaceId, action: "form.update", resourceType: "form", resourceId: id, ip: p.ip });
  return getForm(app, p.workspaceId, id);
}

export async function deleteForm(app: AppContext, p: Principal, id: string) {
  authorize(p, "editor", "write");
  const rows = await app.db.query("DELETE FROM forms WHERE id = $1 AND workspace_id = $2 RETURNING id", [id, p.workspaceId]);
  if (!rows.length) throw notFound("Form");
  await audit(app, p, { workspaceId: p.workspaceId, action: "form.delete", resourceType: "form", resourceId: id, ip: p.ip });
}

export async function publicForm(app: AppContext, slug: string) {
  const f = await app.db.one<FormRow>("SELECT * FROM forms WHERE slug = $1 AND is_public = TRUE", [slug]);
  if (!f) throw notFound("Form");
  return { name: f.name, description: f.description, fields: f.fields, slug: f.slug };
}

/** Validates a submission, stores it in the linked table and emits form.submitted. */
export async function submitForm(app: AppContext, form: FormRow, body: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  for (const field of form.fields) {
    let v = body[field.key];
    if (field.type === "checkbox") v = v === true || v === "true" || v === "on";
    if (v === undefined || v === null || v === "") {
      if (field.required) throw badRequest(`${field.label} is required.`);
      continue;
    }
    const s = toText(v).trim();
    if (s.length > (field.type === "long_text" ? 20_000 : 1000)) throw badRequest(`${field.label} is too long.`);
    if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw badRequest(`${field.label} must be a valid email.`);
    if (field.type === "number" && Number.isNaN(Number(s))) throw badRequest(`${field.label} must be a number.`);
    if (field.type === "select" && field.options?.length && !field.options.includes(s)) throw badRequest(`${field.label} has an invalid choice.`);
    data[field.key] = field.type === "number" ? Number(s) : field.type === "checkbox" ? v : s;
  }
  let rowId: string | null = null;
  if (form.table_id) rowId = (await insertRow(app, null, form.workspace_id, form.table_id, data)).id;
  const id = randomId("sub");
  await emitEvent(app, form.workspace_id, "form.submitted", { formId: form.id, formName: form.name, submissionId: id, submission: data, rowId }, { dedupeKey: id, mode: "form" });
  return { ok: true, message: form.success_message, submissionId: id };
}
