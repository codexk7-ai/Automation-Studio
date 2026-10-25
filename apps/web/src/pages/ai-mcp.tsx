import { Bot, Plug, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { del, get, patch, post } from "../api";
import { Link } from "../router";
import { useSession } from "../session";
import { Button, Confirm, Empty, ErrorBox, Field, JsonView, Loading, Modal, StatusBadge, errorMessage, timeAgo, useAsync, useToast } from "../ui";

export function AiPage() {
  const { can } = useSession();
  const creds = useAsync(() => get<Array<{ id: string; name: string; metadata: { provider?: string; model?: string } }>>("/api/credentials?type=ai_provider"));
  const usage = useAsync(() => get<{ ai: Array<{ day: string; provider: string; model: string; input_tokens: number; output_tokens: number; cost: number | null; calls: number }>; aiMonthlyTokenBudget: number }>("/api/usage"));
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>AI models</h1>
          <p>AI steps (generate, summarize, classify, extract, transform, agent) run on the model connection you pick per step.</p>
        </div>
        {can("editor") && (
          <Link to="/connections" className="btn btn-primary">
            <Plus size={15} /> Add AI connection
          </Link>
        )}
      </div>
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card card-pad stack" style={{ gap: 6 }}>
          <h3>Local & free: Ollama</h3>
          <div className="small muted">
            Install Ollama, run <code>ollama pull llama3.2</code>, then add an "AI model provider" connection with provider <b>OpenAI-compatible</b> and base URL <code>http://localhost:11434/v1</code>. Nothing leaves your machine.
          </div>
        </div>
        <div className="card card-pad stack" style={{ gap: 6 }}>
          <h3>Hosted (optional)</h3>
          <div className="small muted">Anthropic (default model claude-opus-5-5) or any OpenAI-compatible API. Hosted APIs bill per token — set a monthly budget in Settings.</div>
        </div>
        <div className="card card-pad stack" style={{ gap: 6 }}>
          <h3>Mock test adapter</h3>
          <div className="small muted">Steps without a connection use a deterministic heuristic adapter. Its output is marked <code>_mock: true</code> and is meant for testing only.</div>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Model connections</h2>
        </div>
        {creds.error ? (
          <div className="card-pad"><ErrorBox error={creds.error} /></div>
        ) : !creds.data ? (
          <Loading />
        ) : creds.data.length === 0 ? (
          <Empty title="No AI connections" icon={<Bot size={32} />}>
            AI steps currently use the mock adapter.
          </Empty>
        ) : (
          <table className="data">
            <tbody>
              {creds.data.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td>{c.metadata.provider === "anthropic" ? "Anthropic" : "OpenAI-compatible"}</td>
                  <td className="muted">{c.metadata.model}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Usage (30 days)</h2>
          <span className="faint">Monthly budget: {usage.data?.aiMonthlyTokenBudget ? `${usage.data.aiMonthlyTokenBudget.toLocaleString()} tokens` : "unlimited"} · <Link to="/settings">change</Link></span>
        </div>
        {!usage.data ? (
          <Loading />
        ) : usage.data.ai.length === 0 ? (
          <Empty title="No AI usage yet" />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Day</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Calls</th>
                <th>Input tokens</th>
                <th>Output tokens</th>
                <th>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.data.ai.map((r, i) => (
                <tr key={i}>
                  <td>{r.day}</td>
                  <td>{r.provider}</td>
                  <td className="mono">{r.model}</td>
                  <td>{r.calls}</td>
                  <td>{r.input_tokens.toLocaleString()}</td>
                  <td>{r.output_tokens.toLocaleString()}</td>
                  <td>{r.cost !== null ? `$${r.cost.toFixed(4)}` : <span className="faint">unknown</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface McpServerRow {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  status: string;
  last_error: string | null;
  last_checked_at: string | null;
  tools: Array<{ name: string; description: string; inputSchema: unknown; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean } }>;
  tool_policies: Record<string, { enabled: boolean; allowForAi: boolean }>;
}

export function McpPage() {
  const { can } = useSession();
  const toast = useToast();
  const data = useAsync(() => get<{ servers: McpServerRow[]; platformEndpoint: string; platformTools: Array<{ name: string; scope: string; description: string }> }>("/api/mcp-servers"));
  const calls = useAsync(() => get<Array<{ id: number; direction: string; tool: string; status: string; duration_ms: number; error: string | null; created_at: string }>>("/api/mcp-calls"));
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<{ server: McpServerRow; tool: string } | null>(null);
  const [removing, setRemoving] = useState<McpServerRow | null>(null);
  if (data.error) return <div className="page"><ErrorBox error={data.error} onRetry={data.reload} /></div>;
  if (!data.data) return <Loading />;
  const d = data.data;
  const setPolicy = async (s: McpServerRow, tool: string, policy: { enabled: boolean; allowForAi: boolean }) => {
    try {
      await patch(`/api/mcp-servers/${s.id}`, { toolPolicies: { [tool]: policy } });
      await data.reload();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  const clientConfig = JSON.stringify({ mcpServers: { "automation-studio": { type: "http", url: d.platformEndpoint, headers: { Authorization: "Bearer <API token from Team & API>" } } } }, null, 2);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>MCP</h1>
          <p>Expose this platform to AI assistants over MCP, and call tools on external MCP servers from workflows.</p>
        </div>
      </div>
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h2>This platform as an MCP server</h2>
          </div>
          <div className="card-pad stack">
            <Field label="Endpoint (Streamable HTTP)">
              <input className="input mono" readOnly value={d.platformEndpoint} onFocus={(e) => e.target.select()} />
            </Field>
            <div className="small muted">
              Create an API token in <Link to="/team">Team & API</Link> with the scopes the client needs (read / write / execute). Example client configuration:
            </div>
            <pre className="json mono">{clientConfig}</pre>
            <div className="small muted">
              For stdio clients run <code>npm run mcp:stdio</code> with <code>AUTOMATION_STUDIO_TOKEN</code> set (see docs/MCP.md).
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Platform tools</h2>
          </div>
          <table className="data">
            <tbody>
              {d.platformTools.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td>
                    <span className={`badge ${t.scope === "read" ? "" : t.scope === "write" ? "amber" : "blue"}`}>{t.scope}</span>
                  </td>
                  <td className="small muted">{t.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>External MCP servers</h2>
          {can("admin") && (
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              <Plus size={14} /> Register server
            </Button>
          )}
        </div>
        {d.servers.length === 0 ? (
          <Empty title="No external servers" icon={<Plug size={32} />}>
            Register a Streamable HTTP MCP server. Its tools stay disabled until an admin enables them.
          </Empty>
        ) : (
          d.servers.map((s) => (
            <div key={s.id} style={{ borderTop: "1px solid var(--border)" }}>
              <div className="card-pad row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row">
                    <h3>{s.name}</h3>
                    <StatusBadge status={s.status} />
                    {!s.enabled && <span className="badge">disabled</span>}
                  </div>
                  <div className="faint mono truncate">{s.url}</div>
                  {s.last_error && <div className="small" style={{ color: "var(--danger)" }}>{s.last_error}</div>}
                  <div className="faint">checked {timeAgo(s.last_checked_at)}</div>
                </div>
                {can("admin") && (
                  <>
                    <Button
                      size="sm"
                      onClick={async () => {
                        try {
                          await post(`/api/mcp-servers/${s.id}/refresh`);
                          await data.reload();
                        } catch (err) {
                          toast(errorMessage(err), "error");
                        }
                      }}
                    >
                      <RefreshCw size={14} /> Refresh tools
                    </Button>
                    <Button size="sm" onClick={async () => (await patch(`/api/mcp-servers/${s.id}`, { enabled: !s.enabled }), data.reload())}>
                      {s.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setRemoving(s)}>
                      Remove
                    </Button>
                  </>
                )}
              </div>
              {s.tools.length > 0 && (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>Description (from server — untrusted)</th>
                      <th>Enabled</th>
                      <th>AI agents may call</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {s.tools.map((t) => {
                      const pol = s.tool_policies[t.name] ?? { enabled: false, allowForAi: false };
                      return (
                        <tr key={t.name}>
                          <td className="mono">
                            {t.name} {t.annotations?.destructiveHint && <span className="badge red">destructive</span>}
                          </td>
                          <td className="small muted" style={{ maxWidth: 420 }}>
                            {t.description}
                          </td>
                          <td>
                            <input type="checkbox" disabled={!can("admin")} checked={pol.enabled} onChange={(e) => setPolicy(s, t.name, { enabled: e.target.checked, allowForAi: e.target.checked && pol.allowForAi })} aria-label={`Enable ${t.name}`} />
                          </td>
                          <td>
                            <input type="checkbox" disabled={!can("admin") || !pol.enabled} checked={pol.allowForAi} onChange={(e) => setPolicy(s, t.name, { enabled: pol.enabled, allowForAi: e.target.checked })} aria-label={`Allow AI for ${t.name}`} />
                          </td>
                          <td>
                            {can("admin") && pol.enabled && (
                              <Button size="sm" onClick={() => setTesting({ server: s, tool: t.name })}>
                                Test
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          ))
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Tool call audit trail</h2>
        </div>
        {!calls.data ? (
          <Loading />
        ) : calls.data.length === 0 ? (
          <Empty title="No MCP tool calls yet" />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Direction</th>
                <th>Tool</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {calls.data.slice(0, 50).map((c) => (
                <tr key={c.id}>
                  <td className="faint">{timeAgo(c.created_at)}</td>
                  <td>{c.direction}</td>
                  <td className="mono">{c.tool}</td>
                  <td>
                    <StatusBadge status={c.status === "succeeded" ? "succeeded" : "failed"} />
                  </td>
                  <td>{c.duration_ms} ms</td>
                  <td className="small muted truncate" style={{ maxWidth: 320 }}>
                    {c.error}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && <AddServerModal onClose={() => setAdding(false)} onDone={async () => (setAdding(false), await data.reload())} />}
      {testing && <TestToolModal server={testing.server} tool={testing.tool} onClose={() => setTesting(null)} />}
      {removing && (
        <Confirm
          title="Remove MCP server?"
          danger
          confirmLabel="Remove"
          message={`Workflow steps calling "${removing.name}" will fail.`}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await del(`/api/mcp-servers/${removing.id}`);
            await data.reload();
          }}
        />
      )}
    </div>
  );
}

function AddServerModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const creds = useAsync(() => get<Array<{ id: string; name: string }>>("/api/credentials?type=http_auth"));
  const [form, setForm] = useState({ name: "", url: "", credentialId: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Register external MCP server"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const s = await post<{ id: string }>("/api/mcp-servers", { ...form, credentialId: form.credentialId || null });
                await post(`/api/mcp-servers/${s.id}/refresh`);
                onDone();
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Register & discover tools
          </Button>
        </>
      }
    >
      {error ? <ErrorBox error={error} /> : null}
      <Field label="Name">
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="URL (Streamable HTTP endpoint)" help="Private/local addresses are blocked unless an administrator allowlists them (OUTBOUND_ALLOWLIST).">
        <input className="input mono" value={form.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setForm({ ...form, url: e.target.value })} />
      </Field>
      <Field label="Authentication (optional)">
        <select className="input" value={form.credentialId} onChange={(e) => setForm({ ...form, credentialId: e.target.value })}>
          <option value="">None</option>
          {creds.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

function TestToolModal({ server, tool, onClose }: { server: McpServerRow; tool: string; onClose: () => void }) {
  const t = server.tools.find((x) => x.name === tool)!;
  const [args, setArgs] = useState("{}");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`Test ${tool}`}
      wide
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setResult(await post(`/api/mcp-servers/${server.id}/tools/${encodeURIComponent(tool)}/test`, { arguments: JSON.parse(args) }));
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          Call tool
        </Button>
      }
    >
      <div className="alert warn">This performs a real call to the external server. Arguments are validated against the tool's input schema first.</div>
      <div className="label">Input schema</div>
      <JsonView value={t.inputSchema} maxHeight={200} />
      <Field label="Arguments (JSON)">
        <textarea className="input mono" rows={6} value={args} onChange={(e) => setArgs(e.target.value)} />
      </Field>
      {error ? <ErrorBox error={error} /> : null}
      {result !== null && <JsonView value={result} />}
    </Modal>
  );
}
