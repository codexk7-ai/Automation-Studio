import { Plus, Search, Upload, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { get, post, qs } from "../api";
import { useRouter } from "../router";
import { useSession } from "../session";
import { Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, Pagination, StatusBadge, errorMessage, timeAgo, useAsync, useToast } from "../ui";

interface WorkflowItem {
  id: string;
  name: string;
  description: string;
  status: string;
  trigger_type: string | null;
  active_version: number | null;
  node_count: number;
  last_run_at: string | null;
  runs_7d: number;
  failures_7d: number;
  updated_at: string;
}

export function WorkflowsPage() {
  const { can, catalog } = useSession();
  const { navigate, search } = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(search.get("new") === "1");
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState<WorkflowItem | null>(null);
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useAsync(() => get<{ items: WorkflowItem[]; total: number; limit: number; offset: number }>(`/api/workflows${qs({ search: debounced, status, limit: 25, offset })}`), [debounced, status, offset]);
  const triggerName = (t: string | null) => catalog?.nodes.find((n) => n.type === t)?.name ?? "—";

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Workflows</h1>
          <p>Build automations from triggers, logic, AI and actions.</p>
        </div>
        {can("editor") && (
          <div className="row">
            <Button onClick={() => setImporting(true)}>
              <Upload size={15} /> Import
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> New workflow
            </Button>
          </div>
        )}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="search" style={{ width: 320 }}>
          <Search size={15} />
          <input className="input" placeholder="Search workflows" value={q} onChange={(e) => (setQ(e.target.value), setOffset(0))} aria-label="Search workflows" />
        </div>
        <select className="input" style={{ width: 170 }} value={status} onChange={(e) => (setStatus(e.target.value), setOffset(0))} aria-label="Status filter">
          <option value="">All (not archived)</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </select>
      </div>
      <div className="card">
        {list.error ? (
          <div className="card-pad">
            <ErrorBox error={list.error} onRetry={list.reload} />
          </div>
        ) : !list.data ? (
          <Loading />
        ) : list.data.items.length === 0 ? (
          <Empty title={debounced || status ? "No matching workflows" : "No workflows yet"} icon={<Workflow size={32} />}>
            {can("editor") && !debounced && <>Create one from scratch or start from a template.</>}
          </Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Trigger</th>
                    <th>Steps</th>
                    <th>Runs (7d)</th>
                    <th>Last run</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((w) => (
                    <tr key={w.id} className="clickable" onClick={() => navigate(`/workflows/${w.id}`)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{w.name}</div>
                        {w.description && <div className="faint truncate" style={{ maxWidth: 420 }}>{w.description}</div>}
                      </td>
                      <td>
                        <StatusBadge status={w.status} /> {w.active_version ? <span className="faint">v{w.active_version}</span> : null}
                      </td>
                      <td className="muted">{triggerName(w.trigger_type)}</td>
                      <td>{w.node_count}</td>
                      <td>
                        {w.runs_7d}
                        {w.failures_7d ? <span className="badge red" style={{ marginLeft: 6 }}>{w.failures_7d} failed</span> : null}
                      </td>
                      <td className="faint">{timeAgo(w.last_run_at)}</td>
                      <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                        {can("editor") && (
                          <div className="row" style={{ justifyContent: "flex-end" }}>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={async () => {
                                try {
                                  const copy = await post<{ id: string }>(`/api/workflows/${w.id}/duplicate`);
                                  navigate(`/workflows/${copy.id}`);
                                } catch (err) {
                                  toast(errorMessage(err), "error");
                                }
                              }}
                            >
                              Duplicate
                            </Button>
                            {w.status !== "archived" && can("admin") && (
                              <Button size="sm" variant="ghost" onClick={() => setConfirm(w)}>
                                Archive
                              </Button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination total={list.data.total} limit={list.data.limit} offset={list.data.offset} onChange={setOffset} />
          </>
        )}
      </div>
      {creating && <CreateWorkflowModal onClose={() => setCreating(false)} />}
      {importing && <ImportWorkflowModal onClose={() => setImporting(false)} />}
      {confirm && (
        <Confirm
          title="Archive workflow?"
          message={`"${confirm.name}" will stop running. Its history is kept. You can permanently delete archived workflows later.`}
          confirmLabel="Archive"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await post(`/api/workflows/${confirm.id}/archive`);
              toast("Workflow archived");
              await list.reload();
            } catch (err) {
              toast(errorMessage(err), "error");
            }
          }}
        />
      )}
    </div>
  );
}

function CreateWorkflowModal({ onClose }: { onClose: () => void }) {
  const { navigate } = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="New workflow"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const wf = await post<{ id: string }>("/api/workflows", { name, description });
                navigate(`/workflows/${wf.id}`);
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            Create and open editor
          </Button>
        </>
      }
    >
      {error ? <ErrorBox error={error} /> : null}
      <Field label="Name">
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Qualify inbound leads" />
      </Field>
      <Field label="Description">
        <textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ImportWorkflowModal({ onClose }: { onClose: () => void }) {
  const { navigate } = useRouter();
  const [text, setText] = useState("");
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      title="Import workflow"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const wf = await post<{ id: string }>("/api/workflows/import", JSON.parse(text));
                navigate(`/workflows/${wf.id}`);
              } catch (err) {
                setError(err);
              }
            }}
          >
            Import
          </Button>
        </>
      }
    >
      <div className="muted">Paste a workflow exported from this platform (.workflow.json). It is validated and created as a new draft; connections must be re-selected.</div>
      <input
        type="file"
        accept=".json,application/json"
        aria-label="Workflow file"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) setText(await f.text());
        }}
      />
      <textarea className="input mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} aria-label="Workflow JSON" />
      {error ? <ErrorBox error={error} /> : null}
    </Modal>
  );
}
