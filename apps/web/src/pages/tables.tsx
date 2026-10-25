import { ArrowLeft, Database, Download, Plus, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { del, get, patch, post, qs } from "../api";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, Pagination, errorMessage, timeAgo, useAsync, useToast } from "../ui";

interface Column {
  key: string;
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  options?: string[];
}
interface TableRow {
  id: string;
  name: string;
  description: string;
  columns: Column[];
  row_count?: number;
  retention_days: number | null;
  updated_at: string;
}

const TYPES = ["text", "long_text", "number", "boolean", "date", "email", "url", "select", "json"];

export function TablesPage() {
  const { can } = useSession();
  const { navigate } = useRouter();
  const list = useAsync(() => get<TableRow[]>("/api/tables"));
  const [creating, setCreating] = useState(false);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Tables</h1>
          <p>Structured data for leads, contacts, tickets and anything your workflows read or write.</p>
        </div>
        {can("editor") && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={15} /> New table
          </Button>
        )}
      </div>
      <div className="card">
        {list.error ? (
          <div className="card-pad"><ErrorBox error={list.error} onRetry={list.reload} /></div>
        ) : !list.data ? (
          <Loading />
        ) : list.data.length === 0 ? (
          <Empty title="No tables yet" icon={<Database size={32} />}>
            Create one, or use a template that sets one up for you.
          </Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Records</th>
                <th>Retention</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => navigate(`/tables/${t.id}`)}>
                  <td style={{ fontWeight: 600 }}>{t.name}</td>
                  <td className="muted">{t.columns.map((c) => c.name).join(", ")}</td>
                  <td>{t.row_count}</td>
                  <td className="faint">{t.retention_days ? `${t.retention_days} days` : "keep forever"}</td>
                  <td className="faint">{timeAgo(t.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <TableModal onClose={() => setCreating(false)} onSaved={(t) => navigate(`/tables/${t.id}`)} />}
    </div>
  );
}

function TableModal({ existing, onClose, onSaved }: { existing?: TableRow; onClose: () => void; onSaved: (t: TableRow) => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [retention, setRetention] = useState(existing?.retention_days ? String(existing.retention_days) : "");
  const [columns, setColumns] = useState<Column[]>(existing?.columns ?? [{ key: "", name: "Name", type: "text", required: true }]);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      title={existing ? "Edit table" : "New table"}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const body = { name, columns: columns.map((c) => ({ ...c, key: c.key || undefined, options: c.type === "select" ? c.options : undefined })), retentionDays: retention ? Number(retention) : null };
                onSaved(existing ? await patch(`/api/tables/${existing.id}`, body) : await post("/api/tables", body));
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
        <Field label="Table name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Delete records older than (days)" help="Leave empty to keep records.">
          <input className="input" type="number" min={1} value={retention} onChange={(e) => setRetention(e.target.value)} />
        </Field>
      </div>
      <div className="label">Columns</div>
      {columns.map((c, i) => (
        <div key={i} className="row" style={{ flexWrap: "nowrap" }}>
          <input className="input" placeholder="Column name" value={c.name} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Column name" />
          <select className="input" style={{ width: 140 }} value={c.type} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} aria-label="Column type">
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          {c.type === "select" && (
            <input className="input" placeholder="options, comma separated" value={(c.options ?? []).join(",")} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x)))} aria-label="Options" />
          )}
          <label className="checkbox small">
            <input type="checkbox" checked={!!c.required} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} /> required
          </label>
          <label className="checkbox small">
            <input type="checkbox" checked={!!c.unique} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, unique: e.target.checked } : x)))} /> unique
          </label>
          <button className="btn btn-ghost btn-icon" aria-label="Remove column" onClick={() => setColumns(columns.filter((_, j) => j !== i))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <Button size="sm" onClick={() => setColumns([...columns, { key: "", name: "", type: "text" }])}>
        <Plus size={14} /> Add column
      </Button>
      {existing && <div className="faint">Column keys of existing columns stay stable so workflows keep working.</div>}
    </Modal>
  );
}

function cellText(v: unknown, type: string) {
  if (v === null || v === undefined || v === "") return <span className="faint">—</span>;
  if (type === "boolean") return v ? "✓" : "✗";
  if (type === "date") return new Date(String(v)).toLocaleDateString();
  if (typeof v === "object") return <code>{JSON.stringify(v).slice(0, 80)}</code>;
  return String(v).length > 120 ? `${String(v).slice(0, 120)}…` : String(v);
}

export function TableDetailPage({ id }: { id: string }) {
  const { can } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "created_at", dir: "desc" });
  const [editingRow, setEditingRow] = useState<{ id?: string; data: Record<string, unknown> } | null>(null);
  const [editingTable, setEditingTable] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<"table" | string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => (setDebounced(search), setOffset(0)), 250);
    return () => clearTimeout(t);
  }, [search]);
  const data = useAsync(
    () => get<{ table: TableRow; rows: Array<{ id: string; data: Record<string, unknown>; created_at: string }>; total: number; limit: number; offset: number }>(`/api/tables/${id}/rows${qs({ search: debounced, limit: 50, offset, sort: sort.key, direction: sort.dir })}`),
    [id, debounced, offset, sort.key, sort.dir],
  );
  if (data.error) return <div className="page"><ErrorBox error={data.error} onRetry={data.reload} /></div>;
  if (!data.data) return <Loading />;
  const t = data.data.table;
  const toggleSort = (key: string) => setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="row">
            <Link to="/tables">
              <ArrowLeft size={16} />
            </Link>
            <h1>{t.name}</h1>
            <span className="badge">{data.data.total} records</span>
          </div>
          <p>
            Table ID <code>{t.id}</code> — use it in workflow steps.
          </p>
        </div>
        <div className="row">
          <a className="btn" href={`/api/tables/${id}/export`}>
            <Download size={15} /> Export CSV
          </a>
          {can("editor") && (
            <>
              <Button onClick={() => setImporting(true)}>
                <Upload size={15} /> Import CSV
              </Button>
              <Button onClick={() => setEditingTable(true)}>Edit columns</Button>
              <Button variant="primary" onClick={() => setEditingRow({ data: {} })}>
                <Plus size={15} /> Add record
              </Button>
            </>
          )}
          {can("admin") && (
            <Button variant="danger" onClick={() => setDeleting("table")}>
              Delete table
            </Button>
          )}
        </div>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="search" style={{ width: 320 }}>
          <Search size={15} />
          <input className="input" placeholder="Search records" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search records" />
        </div>
      </div>
      <div className="card">
        {data.data.rows.length === 0 ? (
          <Empty title={debounced ? "No matching records" : "No records yet"} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {t.columns.map((c) => (
                      <th key={c.key} style={{ cursor: "pointer" }} onClick={() => toggleSort(c.key)} aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                        {c.name} {sort.key === c.key ? (sort.dir === "asc" ? "↑" : "↓") : ""}
                      </th>
                    ))}
                    <th style={{ cursor: "pointer" }} onClick={() => toggleSort("created_at")}>
                      Created {sort.key === "created_at" ? (sort.dir === "asc" ? "↑" : "↓") : ""}
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.data.rows.map((r) => (
                    <tr key={r.id} className={can("editor") ? "clickable" : ""} onClick={() => can("editor") && setEditingRow({ id: r.id, data: r.data })}>
                      {t.columns.map((c) => (
                        <td key={c.key}>{cellText(r.data[c.key], c.type)}</td>
                      ))}
                      <td className="faint">{timeAgo(r.created_at)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {can("editor") && (
                          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Delete record" onClick={() => setDeleting(r.id)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination total={data.data.total} limit={data.data.limit} offset={data.data.offset} onChange={setOffset} />
          </>
        )}
      </div>
      {editingRow && <RowModal table={t} row={editingRow} onClose={() => setEditingRow(null)} onSaved={async () => (setEditingRow(null), await data.reload())} />}
      {editingTable && <TableModal existing={t} onClose={() => setEditingTable(false)} onSaved={async () => (setEditingTable(false), await data.reload())} />}
      {importing && <ImportCsvModal tableId={id} onClose={() => setImporting(false)} onDone={async () => (setImporting(false), await data.reload())} />}
      {deleting && (
        <Confirm
          title={deleting === "table" ? "Delete table?" : "Delete record?"}
          danger
          confirmLabel="Delete"
          message={deleting === "table" ? `All ${data.data.total} records in "${t.name}" will be permanently deleted. Workflows using this table will fail.` : "This record will be permanently deleted."}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              if (deleting === "table") {
                await del(`/api/tables/${id}`);
                navigate("/tables");
              } else {
                await del(`/api/tables/${id}/rows/${deleting}`);
                await data.reload();
              }
            } catch (err) {
              toast(errorMessage(err), "error");
            }
          }}
        />
      )}
    </div>
  );
}

function RowModal({ table, row, onClose, onSaved }: { table: TableRow; row: { id?: string; data: Record<string, unknown> }; onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<Record<string, unknown>>({ ...row.data });
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      title={row.id ? "Edit record" : "New record"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                if (row.id) await patch(`/api/tables/${table.id}/rows/${row.id}`, { data });
                else await post(`/api/tables/${table.id}/rows`, { data });
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
      {table.columns.map((c) => (
        <Field key={c.key} label={`${c.name}${c.required ? " *" : ""}`}>
          {c.type === "boolean" ? (
            <label className="checkbox">
              <input type="checkbox" checked={data[c.key] === true} onChange={(e) => setData({ ...data, [c.key]: e.target.checked })} /> {c.name}
            </label>
          ) : c.type === "select" ? (
            <select className="input" value={String(data[c.key] ?? "")} onChange={(e) => setData({ ...data, [c.key]: e.target.value })}>
              <option value="">—</option>
              {c.options?.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : c.type === "long_text" || c.type === "json" ? (
            <textarea className={`input ${c.type === "json" ? "mono" : ""}`} value={typeof data[c.key] === "object" && data[c.key] !== null ? JSON.stringify(data[c.key]) : String(data[c.key] ?? "")} onChange={(e) => setData({ ...data, [c.key]: e.target.value })} />
          ) : (
            <input
              className="input"
              type={c.type === "number" ? "number" : c.type === "date" ? "date" : c.type === "email" ? "email" : "text"}
              value={c.type === "date" && data[c.key] ? String(data[c.key]).slice(0, 10) : String(data[c.key] ?? "")}
              onChange={(e) => setData({ ...data, [c.key]: e.target.value })}
            />
          )}
        </Field>
      ))}
    </Modal>
  );
}

function ImportCsvModal({ tableId, onClose, onDone }: { tableId: string; onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<{ imported: number; errors: Array<{ line: number; message: string }> } | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      title="Import CSV"
      wide
      onClose={result ? onDone : onClose}
      footer={
        result ? (
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!csv}
            onClick={async () => {
              try {
                setResult(await post(`/api/tables/${tableId}/import`, { csv }));
              } catch (err) {
                setError(err);
              }
            }}
          >
            Import
          </Button>
        )
      }
    >
      <div className="muted">The first row must contain headers matching column names or keys. Each row is validated; invalid rows are reported and skipped.</div>
      <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={async (e) => e.target.files?.[0] && setCsv(await e.target.files[0].text())} />
      <textarea className="input mono" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} aria-label="CSV text" />
      {error ? <ErrorBox error={error} /> : null}
      {result && (
        <div className="stack">
          <div className="alert success">Imported {result.imported} records.</div>
          {result.errors.map((e) => (
            <div key={e.line} className="small" style={{ color: "var(--danger)" }}>
              Line {e.line}: {e.message}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
