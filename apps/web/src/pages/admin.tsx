import type { Role } from "@automation-studio/core";
import { Plus } from "lucide-react";
import { useState } from "react";
import { del, get, patch, post, qs } from "../api";
import { useSession } from "../session";
import { TwoFactorCard } from "./two-factor";
import { Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, Pagination, errorMessage, formatDate, timeAgo, useAsync, useToast } from "../ui";

export function UsagePage() {
  const usage = useAsync(() =>
    get<{
      perWorkflow: Array<{ id: string; name: string; runs: number; failed: number; steps: number }>;
      mcp: Array<{ direction: string; tool: string; status: string; calls: number; avg_ms: number }>;
      queue: Record<string, number>;
      ai: Array<{ input_tokens: number; output_tokens: number; cost: number | null; calls: number }>;
    }>("/api/usage"),
  );
  if (usage.error) return <div className="page"><ErrorBox error={usage.error} onRetry={usage.reload} /></div>;
  if (!usage.data) return <Loading />;
  const u = usage.data;
  const tokens = u.ai.reduce((a, r) => a + r.input_tokens + r.output_tokens, 0);
  const cost = u.ai.reduce((a, r) => a + (r.cost ?? 0), 0);
  const runs = u.perWorkflow.reduce((a, r) => a + r.runs, 0);
  const steps = u.perWorkflow.reduce((a, r) => a + r.steps, 0);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Usage</h1>
          <p>Last 30 days, measured from real execution records.</p>
        </div>
      </div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="label">Workflow runs</div>
          <div className="value">{runs}</div>
        </div>
        <div className="card stat">
          <div className="label">Step executions</div>
          <div className="value">{steps}</div>
        </div>
        <div className="card stat">
          <div className="label">AI tokens</div>
          <div className="value">{tokens.toLocaleString()}</div>
          <div className="sub">~${cost.toFixed(4)} estimated (known prices only)</div>
        </div>
        <div className="card stat">
          <div className="label">Job queue</div>
          <div className="value">{u.queue.pending ?? 0}</div>
          <div className="sub">
            pending · {u.queue.running ?? 0} running · {u.queue.failed ?? 0} failed
          </div>
        </div>
      </div>
      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Runs per workflow</h2>
          </div>
          {u.perWorkflow.length === 0 ? (
            <Empty title="No workflows" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Runs</th>
                  <th>Failed</th>
                  <th>Steps</th>
                </tr>
              </thead>
              <tbody>
                {u.perWorkflow.map((w) => (
                  <tr key={w.id}>
                    <td>{w.name}</td>
                    <td>{w.runs}</td>
                    <td>{w.failed ? <span className="badge red">{w.failed}</span> : 0}</td>
                    <td>{w.steps}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>MCP tool calls</h2>
          </div>
          {u.mcp.length === 0 ? (
            <Empty title="No MCP calls" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Tool</th>
                  <th>Status</th>
                  <th>Calls</th>
                  <th>Avg</th>
                </tr>
              </thead>
              <tbody>
                {u.mcp.map((m, i) => (
                  <tr key={i}>
                    <td>{m.direction}</td>
                    <td className="mono">{m.tool}</td>
                    <td>{m.status}</td>
                    <td>{m.calls}</td>
                    <td>{m.avg_ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export function TeamPage() {
  const { can, me } = useSession();
  const toast = useToast();
  const members = useAsync(() => get<Array<{ id: string; email: string; name: string; role: Role; created_at: string }>>("/api/members"));
  const tokens = useAsync(() => get<Array<{ id: string; name: string; token_prefix: string; scopes: string[]; last_used_at: string | null; expires_at: string | null; revoked_at: string | null; created_at: string }>>("/api/api-tokens"));
  const [adding, setAdding] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; email: string } | null>(null);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Team & API access</h1>
          <p>Roles: viewer (read), editor (build & run), admin (connections, members, MCP servers), owner.</p>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Members</h2>
          {can("admin") && (
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              <Plus size={14} /> Add member
            </Button>
          )}
        </div>
        {!members.data ? (
          <Loading />
        ) : (
          <table className="data">
            <tbody>
              {members.data.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{m.name}</div>
                    <div className="faint">{m.email}</div>
                  </td>
                  <td>
                    {can("admin") && m.id !== me?.user.id ? (
                      <select
                        className="input"
                        style={{ width: 130 }}
                        value={m.role}
                        aria-label={`Role for ${m.email}`}
                        onChange={async (e) => {
                          try {
                            await patch(`/api/members/${m.id}`, { role: e.target.value });
                            await members.reload();
                          } catch (err) {
                            toast(errorMessage(err), "error");
                          }
                        }}
                      >
                        {["viewer", "editor", "admin", "owner"].map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="badge">{m.role}</span>
                    )}
                  </td>
                  <td className="faint">joined {timeAgo(m.created_at)}</td>
                  <td style={{ textAlign: "right" }}>
                    {can("admin") && m.id !== me?.user.id && m.role !== "owner" && (
                      <Button size="sm" variant="danger" onClick={() => setRemoving(m)}>
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <div>
            <h2>API tokens</h2>
            <div className="faint">For the REST API and MCP clients. Tokens act with their creator's current role, limited by their scopes.</div>
          </div>
          {can("editor") && (
            <Button size="sm" variant="primary" onClick={() => setCreatingToken(true)}>
              <Plus size={14} /> New token
            </Button>
          )}
        </div>
        {!tokens.data ? (
          <Loading />
        ) : tokens.data.length === 0 ? (
          <Empty title="No API tokens" />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Token</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="mono">{t.token_prefix}…</td>
                  <td>{t.scopes.map((s) => <span key={s} className="badge" style={{ marginRight: 4 }}>{s}</span>)}</td>
                  <td className="faint">{timeAgo(t.last_used_at)}</td>
                  <td className="faint">{t.expires_at ? formatDate(t.expires_at) : "never"}</td>
                  <td style={{ textAlign: "right" }}>
                    {t.revoked_at ? (
                      <span className="badge red">revoked</span>
                    ) : (
                      can("editor") && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            try {
                              await del(`/api/api-tokens/${t.id}`);
                              await tokens.reload();
                            } catch (err) {
                              toast(errorMessage(err), "error");
                            }
                          }}
                        >
                          Revoke
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && <AddMemberModal onClose={() => setAdding(false)} onDone={() => members.reload()} />}
      {creatingToken && <TokenModal onClose={() => setCreatingToken(false)} onDone={() => tokens.reload()} />}
      {removing && (
        <Confirm
          title="Remove member?"
          danger
          confirmLabel="Remove"
          message={`${removing.email} loses access; their sessions end and their API tokens for this workspace are revoked.`}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await del(`/api/members/${removing.id}`);
            await members.reload();
          }}
        />
      )}
    </div>
  );
}

function AddMemberModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [result, setResult] = useState<{ temporaryPassword?: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      title="Add member"
      onClose={onClose}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={async () => {
              try {
                setResult(await post("/api/members", { email, role }));
                onDone();
              } catch (err) {
                setError(err);
              }
            }}
          >
            Add
          </Button>
        )
      }
    >
      {error ? <ErrorBox error={error} /> : null}
      {result ? (
        result.temporaryPassword ? (
          <div className="stack">
            <div className="alert success">Account created. Share this temporary password securely; it is shown only once. Ask them to change it in Settings.</div>
            <input className="input mono" readOnly value={result.temporaryPassword} onFocus={(e) => e.target.select()} />
          </div>
        ) : (
          <div className="alert success">Existing user added to this workspace.</div>
        )
      ) : (
        <>
          <Field label="Email">
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Role">
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
              {["viewer", "editor", "admin", "owner"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          <div className="faint">No email is sent (local-first). Users without an account get a temporary password to share.</div>
        </>
      )}
    </Modal>
  );
}

function TokenModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [days, setDays] = useState("90");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      title="New API token"
      onClose={onClose}
      footer={
        token ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const r = await post<{ token: string }>("/api/api-tokens", { name, scopes, expiresInDays: days ? Number(days) : null });
                setToken(r.token);
                onDone();
              } catch (err) {
                setError(err);
              }
            }}
          >
            Create
          </Button>
        )
      }
    >
      {error ? <ErrorBox error={error} /> : null}
      {token ? (
        <div className="stack">
          <div className="alert warn">Copy this token now. It is stored only as a hash and cannot be shown again.</div>
          <input className="input mono" readOnly value={token} onFocus={(e) => e.target.select()} />
        </div>
      ) : (
        <>
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Desktop MCP" />
          </Field>
          <div className="label">Scopes</div>
          {[
            ["read", "List and read workflows, executions, tables"],
            ["write", "Create and edit drafts, tables"],
            ["execute", "Run tests, retry executions"],
            ["admin", "Workspace administration (admins only)"],
          ].map(([s, d]) => (
            <label key={s} className="checkbox">
              <input type="checkbox" checked={scopes.includes(s!)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s!] : scopes.filter((x) => x !== s))} /> <b>{s}</b> <span className="faint">{d}</span>
            </label>
          ))}
          <Field label="Expires in (days)" help="Leave empty for no expiry (not recommended).">
            <input className="input" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </>
      )}
    </Modal>
  );
}

export function SettingsPage() {
  const { me, can, refresh } = useSession();
  const toast = useToast();
  const ws = useAsync(() => get<{ id: string; name: string; settings: { aiMonthlyTokenBudget?: number; executionRetentionDays?: number; require2fa?: boolean } }>("/api/workspace"));
  const [offset, setOffset] = useState(0);
  const audit = useAsync(() => (can("admin") ? get<{ items: Array<{ id: number; actor_type: string; actor_id: string | null; action: string; resource_type: string | null; resource_id: string | null; ip: string | null; created_at: string }>; total: number }>(`/api/audit${qs({ limit: 25, offset })}`) : Promise.resolve(null)), [offset]);
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "" });
  if (!ws.data) return <Loading />;
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Workspace configuration, your account and the audit log.</p>
        </div>
      </div>
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <WorkspaceSettings
          initial={ws.data}
          disabled={!can("admin")}
          onSave={async (body) => {
            try {
              await patch("/api/workspace", body);
              toast("Settings saved");
              await refresh();
            } catch (err) {
              toast(errorMessage(err), "error");
            }
          }}
        />
        <div className="stack">
        <TwoFactorCard />
        <div className="card card-pad stack">
          <h2>Your account</h2>
          <div className="muted">
            {me?.user.name} · {me?.user.email}
          </div>
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
          </Field>
          <Field label="New password" help="At least 10 characters. You will be signed out everywhere.">
            <input className="input" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
          </Field>
          <Button
            onClick={async () => {
              try {
                await post("/api/auth/change-password", pw);
                toast("Password changed — please sign in again");
                await refresh();
              } catch (err) {
                toast(errorMessage(err), "error");
              }
            }}
          >
            Change password
          </Button>
        </div>
        </div>
      </div>
      {can("admin") && (
        <div className="card">
          <div className="card-head">
            <h2>Audit log</h2>
          </div>
          {!audit.data ? (
            <Loading />
          ) : (
            <>
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Resource</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.items.map((a) => (
                    <tr key={a.id}>
                      <td className="faint">{formatDate(a.created_at)}</td>
                      <td className="mono">{a.action}</td>
                      <td className="small">
                        {a.actor_type} <span className="faint">{a.actor_id}</span>
                      </td>
                      <td className="small">
                        {a.resource_type} <span className="faint">{a.resource_id}</span>
                      </td>
                      <td className="faint">{a.ip}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination total={audit.data.total} limit={25} offset={offset} onChange={setOffset} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceSettings({ initial, disabled, onSave }: { initial: { name: string; settings: { aiMonthlyTokenBudget?: number; executionRetentionDays?: number; require2fa?: boolean } }; disabled: boolean; onSave: (b: unknown) => Promise<void> }) {
  const [require2fa, setRequire2fa] = useState(initial.settings.require2fa === true);
  const [name, setName] = useState(initial.name);
  const [budget, setBudget] = useState(String(initial.settings.aiMonthlyTokenBudget ?? 0));
  const [retention, setRetention] = useState(String(initial.settings.executionRetentionDays ?? 90));
  return (
    <div className="card card-pad stack">
      <h2>Workspace</h2>
      <Field label="Name">
        <input className="input" disabled={disabled} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Monthly AI token budget" help="0 = unlimited. AI steps fail with a clear error once the budget is used up.">
        <input className="input" type="number" min={0} disabled={disabled} value={budget} onChange={(e) => setBudget(e.target.value)} />
      </Field>
      <Field label="Keep execution history (days)">
        <input className="input" type="number" min={1} disabled={disabled} value={retention} onChange={(e) => setRetention(e.target.value)} />
      </Field>
      <label className="checkbox">
        <input type="checkbox" disabled={disabled} checked={require2fa} onChange={(e) => setRequire2fa(e.target.checked)} /> Require two-factor authentication for all members
      </label>
      {!disabled && <Button variant="primary" onClick={() => onSave({ name, settings: { aiMonthlyTokenBudget: Number(budget), executionRetentionDays: Number(retention), require2fa } })}>Save</Button>}
    </div>
  );
}
