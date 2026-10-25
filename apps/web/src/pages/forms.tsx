import { FileText, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { del, get, patch, post } from "../api";
import { useSession } from "../session";
import { Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, useAsync, useToast } from "../ui";

interface FormField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
}
interface FormRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  fields: FormField[];
  is_public: boolean;
  table_id: string | null;
  success_message: string;
}

const FIELD_TYPES = ["text", "long_text", "email", "number", "select", "checkbox", "url", "phone"];

export function FormsPage() {
  const { can } = useSession();
  const toast = useToast();
  const list = useAsync(() => get<FormRow[]>("/api/forms"));
  const tables = useAsync(() => get<Array<{ id: string; name: string; columns: Array<{ key: string; name: string; type: string; required?: boolean; options?: string[] }> }>>("/api/tables"));
  const [editing, setEditing] = useState<FormRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<FormRow | null>(null);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Forms</h1>
          <p>Public forms store submissions in a table and can trigger workflows ("Form submitted").</p>
        </div>
        {can("editor") && (
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus size={15} /> New form
          </Button>
        )}
      </div>
      <div className="card">
        {list.error ? (
          <div className="card-pad"><ErrorBox error={list.error} onRetry={list.reload} /></div>
        ) : !list.data ? (
          <Loading />
        ) : list.data.length === 0 ? (
          <Empty title="No forms yet" icon={<FileText size={32} />} />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Fields</th>
                <th>Table</th>
                <th>Public link</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((f) => (
                <tr key={f.id}>
                  <td style={{ fontWeight: 600 }}>{f.name}</td>
                  <td className="muted">{f.fields.map((x) => x.label).join(", ")}</td>
                  <td className="muted">{tables.data?.find((t) => t.id === f.table_id)?.name ?? "—"}</td>
                  <td>
                    {f.is_public ? (
                      <a href={`/f/${f.slug}`} target="_blank" rel="noreferrer">
                        /f/{f.slug}
                      </a>
                    ) : (
                      <span className="badge">private</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {can("editor") && (
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <Button size="sm" onClick={() => setEditing(f)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setDeleting(f)}>
                          Delete
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <FormModal
          existing={editing === "new" ? undefined : editing}
          tables={tables.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            toast("Form saved");
            await list.reload();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="Delete form?"
          danger
          confirmLabel="Delete"
          message="The public link stops working. Stored submissions in the table are kept."
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await del(`/api/forms/${deleting.id}`);
            await list.reload();
          }}
        />
      )}
    </div>
  );
}

function FormModal({ existing, tables, onClose, onSaved }: { existing?: FormRow; tables: Array<{ id: string; name: string; columns: Array<{ key: string; name: string; type: string; required?: boolean; options?: string[] }> }>; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [tableId, setTableId] = useState(existing?.table_id ?? "");
  const [isPublic, setIsPublic] = useState(existing?.is_public ?? true);
  const [fields, setFields] = useState<FormField[]>(existing?.fields ?? []);
  const [successMessage, setSuccessMessage] = useState(existing?.success_message ?? "Thanks! Your response has been recorded.");
  const [error, setError] = useState<unknown>(null);
  const fromTable = (id: string) => {
    setTableId(id);
    const t = tables.find((x) => x.id === id);
    if (t && !existing)
      setFields(
        t.columns
          .filter((c) => ["text", "long_text", "email", "number", "select", "boolean", "url"].includes(c.type))
          .map((c) => ({ key: c.key, label: c.name, type: c.type === "boolean" ? "checkbox" : c.type, required: c.required, options: c.options })),
      );
  };
  return (
    <Modal
      title={existing ? "Edit form" : "New form"}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const body = { name, fields, tableId: tableId || null, isPublic, successMessage };
                if (existing) await patch(`/api/forms/${existing.id}`, body);
                else await post("/api/forms", body);
                onSaved();
              } catch (err) {
                setError(err);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      {error ? <ErrorBox error={error} /> : null}
      <div className="grid grid-2">
        <Field label="Form name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Store submissions in table">
          <select className="input" value={tableId} disabled={!!existing} onChange={(e) => fromTable(e.target.value)}>
            <option value="">Don't store (trigger workflows only)</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} /> Public (anyone with the link can submit; rate limited)
      </label>
      <Field label="Success message">
        <input className="input" value={successMessage} onChange={(e) => setSuccessMessage(e.target.value)} />
      </Field>
      <div className="label">Fields {tableId && <span className="faint">(keys must match table columns)</span>}</div>
      {fields.map((f, i) => (
        <div key={i} className="row" style={{ flexWrap: "nowrap" }}>
          <input className="input mono" style={{ width: 150 }} placeholder="key" value={f.key} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} aria-label="Field key" />
          <input className="input" placeholder="Label" value={f.label} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label="Field label" />
          <select className="input" style={{ width: 130 }} value={f.type} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} aria-label="Field type">
            {FIELD_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <label className="checkbox small">
            <input type="checkbox" checked={!!f.required} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} /> required
          </label>
          <button className="btn btn-ghost btn-icon" aria-label="Remove field" onClick={() => setFields(fields.filter((_, j) => j !== i))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <Button size="sm" onClick={() => setFields([...fields, { key: "", label: "", type: "text" }])}>
        <Plus size={14} /> Add field
      </Button>
    </Modal>
  );
}

/** Public, unauthenticated form page at /f/:slug */
export function PublicFormPage({ slug }: { slug: string }) {
  const form = useAsync(() => get<{ name: string; description: string; fields: FormField[] }>(`/api/public/forms/${slug}`), [slug]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ message: string }>(`/api/public/forms/${slug}`, values);
      setDone(r.message);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (form.error) return <div className="public-form"><ErrorBox error={form.error} /></div>;
  if (!form.data) return <Loading />;
  return (
    <div className="public-form">
      <div className="card card-pad stack" style={{ gap: 16 }}>
        <h1>{form.data.name}</h1>
        {form.data.description && <p className="muted">{form.data.description}</p>}
        {done ? (
          <div className="alert success">{done}</div>
        ) : (
          <form className="stack" onSubmit={submit}>
            {error ? <ErrorBox error={error} /> : null}
            {form.data.fields.map((f) => (
              <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`}>
                {f.type === "long_text" ? (
                  <textarea className="input" required={f.required} value={String(values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                ) : f.type === "select" ? (
                  <select className="input" required={f.required} value={String(values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                    <option value="">Choose…</option>
                    {f.options?.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : f.type === "checkbox" ? (
                  <label className="checkbox">
                    <input type="checkbox" checked={values[f.key] === true} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} /> {f.label}
                  </label>
                ) : (
                  <input
                    className="input"
                    required={f.required}
                    type={f.type === "email" ? "email" : f.type === "number" ? "number" : f.type === "url" ? "url" : f.type === "phone" ? "tel" : "text"}
                    value={String(values[f.key] ?? "")}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  />
                )}
              </Field>
            ))}
            <input type="text" name="_hp" tabIndex={-1} autoComplete="off" style={{ position: "absolute", left: -9999 }} aria-hidden="true" onChange={(e) => setValues({ ...values, _hp: e.target.value })} />
            <Button variant="primary" type="submit" loading={busy}>
              Submit
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
