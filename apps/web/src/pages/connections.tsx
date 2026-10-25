import type { FieldSpec } from "@automation-studio/core";
import { KeyRound, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { del, get, patch, post } from "../api";
import { useRouter } from "../router";
import { useSession, type Catalog } from "../session";
import { Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, errorMessage, timeAgo, useAsync, useToast } from "../ui";

interface Credential {
  id: string;
  name: string;
  type: string;
  metadata: Record<string, unknown>;
  created_at: string;
  last_used_at: string | null;
}

type CredType = Catalog["credentialTypes"][number];

export function ConnectionsPage() {
  const { catalog, can } = useSession();
  const { search, navigate } = useRouter();
  const toast = useToast();
  const list = useAsync(() => get<Credential[]>("/api/credentials"));
  const [editing, setEditing] = useState<{ type: CredType; existing?: Credential } | null>(null);
  const [picking, setPicking] = useState(false);
  const [deleting, setDeleting] = useState<Credential | null>(null);

  useEffect(() => {
    const err = search.get("oauth_error");
    if (err) toast(`OAuth failed: ${err}`, "error");
    if (search.get("connected")) toast("Account connected");
    if (err || search.get("connected")) navigate("/connections", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!catalog) return <Loading />;
  const typeOf = (id: string) => catalog.credentialTypes.find((t) => t.id === id);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Connections</h1>
          <p>Credentials are encrypted at rest (AES-256-GCM) and never sent back to the browser or written to logs.</p>
        </div>
        {can("editor") && (
          <Button variant="primary" onClick={() => setPicking(true)}>
            <Plus size={15} /> Add connection
          </Button>
        )}
      </div>
      <div className="card">
        {list.error ? (
          <div className="card-pad">
            <ErrorBox error={list.error} onRetry={list.reload} />
          </div>
        ) : !list.data ? (
          <Loading />
        ) : list.data.length === 0 ? (
          <Empty title="No connections yet" icon={<KeyRound size={32} />}>
            Most built-in steps work without one. Add connections for SMTP, AI models, Google, WhatsApp, HubSpot and more.
          </Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Account</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td>{typeOf(c.type)?.name ?? c.type}</td>
                  <td className="muted">{String(c.metadata.account ?? c.metadata.provider ?? c.metadata.authMode ?? "")}</td>
                  <td className="faint">{timeAgo(c.last_used_at)}</td>
                  <td style={{ textAlign: "right" }}>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      {c.type === "whatsapp_cloud" && (
                        <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(`${window.location.origin}/hooks/whatsapp/${c.id}`).then(() => toast("Webhook URL copied"))}>
                          Copy webhook URL
                        </Button>
                      )}
                      {can("editor") && (
                        <>
                          <Button
                            size="sm"
                            onClick={async () => {
                              try {
                                const r = await post<{ ok: boolean; message: string }>(`/api/credentials/${c.id}/test`);
                                toast(r.message, r.ok ? "info" : "error");
                              } catch (err) {
                                toast(errorMessage(err), "error");
                              }
                            }}
                          >
                            Test
                          </Button>
                          {typeOf(c.type) && (
                            <Button size="sm" onClick={() => setEditing({ type: typeOf(c.type)!, existing: c })}>
                              Edit
                            </Button>
                          )}
                        </>
                      )}
                      {can("admin") && (
                        <Button size="sm" variant="danger" onClick={() => setDeleting(c)}>
                          Delete
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {picking && (
        <Modal title="Add connection" onClose={() => setPicking(false)} wide>
          <div className="grid grid-2">
            {catalog.credentialTypes.map((t) => (
              <button
                key={t.id}
                className="card card-pad"
                style={{ textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit" }}
                onClick={() => {
                  setPicking(false);
                  setEditing({ type: t });
                }}
              >
                <h3>{t.name}</h3>
                <div className="faint">{t.description}</div>
                {t.oauth2 && <span className={`badge ${t.oauthAvailable ? "blue" : ""}`} style={{ marginTop: 6 }}>{t.oauthAvailable ? "OAuth available" : "OAuth not configured on server"}</span>}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {editing && (
        <CredentialModal
          type={editing.type}
          existing={editing.existing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await list.reload();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="Delete connection?"
          danger
          confirmLabel="Delete"
          message={`Workflows using "${deleting.name}" will fail until another connection is selected.`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await del(`/api/credentials/${deleting.id}`);
            toast("Connection deleted");
            await list.reload();
          }}
        />
      )}
    </div>
  );
}

function visible(f: FieldSpec, data: Record<string, unknown>, fields: FieldSpec[]) {
  return !f.showWhen || f.showWhen.equals.includes(data[f.showWhen.key] ?? fields.find((x) => x.key === f.showWhen!.key)?.default);
}

function CredentialModal({ type, existing, onClose, onSaved }: { type: CredType; existing?: Credential; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? type.name);
  // New connections start from defaults; edits start empty and only send fields the user touched.
  const [data, setDataState] = useState<Record<string, unknown>>(() => (existing ? {} : Object.fromEntries(type.fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]))));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const setData = (next: Record<string, unknown>) => {
    setTouched(new Set([...touched, ...Object.keys(next).filter((k) => next[k] !== data[k])]));
    setDataState(next);
  };
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (existing) await patch(`/api/credentials/${existing.id}`, { name, data: Object.fromEntries(Object.entries(data).filter(([k]) => touched.has(k))) });
      else await post("/api/credentials", { name, type: type.id, data });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : `New ${type.name} connection`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {type.fields.length > 0 && (
            <Button variant="primary" loading={busy} onClick={save}>
              Save
            </Button>
          )}
        </>
      }
    >
      <div className="muted">{type.description}</div>
      {error ? <ErrorBox error={error} /> : null}
      <Field label="Connection name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {type.oauth2 && !existing && (
        <div className="card card-pad stack" style={{ gap: 8 }}>
          <div style={{ fontWeight: 600 }}>Connect with OAuth</div>
          {type.oauthAvailable ? (
            <a className="btn btn-primary" href={`/api/oauth/${type.id}/start?name=${encodeURIComponent(name)}`}>
              Sign in with {type.name.replace(/ account$/, "")}
            </a>
          ) : (
            <div className="faint">The server administrator must set the OAuth client ID and secret (see docs/INTEGRATIONS.md). You can still use an API key below for public data.</div>
          )}
          <div className="faint">Requested scopes: {type.oauth2.scopes.join(", ")}</div>
        </div>
      )}
      {type.fields.filter((f) => visible(f, data, type.fields)).map((f) => (
        <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`} help={f.description ?? (existing && f.sensitive ? "Leave empty to keep the current value." : undefined)}>
          {f.type === "boolean" ? (
            <label className="checkbox">
              <input type="checkbox" checked={data[f.key] === true} onChange={(e) => setData({ ...data, [f.key]: e.target.checked })} /> {f.label}
            </label>
          ) : f.type === "select" ? (
            <select className="input" value={String(data[f.key] ?? "")} onChange={(e) => setData({ ...data, [f.key]: e.target.value })}>
              {existing && <option value="">(unchanged)</option>}
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              type={f.sensitive ? "password" : f.type === "number" ? "number" : "text"}
              autoComplete="off"
              placeholder={existing && f.sensitive ? "••••••••" : f.placeholder}
              value={data[f.key] === undefined ? "" : String(data[f.key])}
              onChange={(e) => setData({ ...data, [f.key]: f.type === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value })}
            />
          )}
        </Field>
      ))}
    </Modal>
  );
}
