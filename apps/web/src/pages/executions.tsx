import type { WorkflowDefinition } from "@automation-studio/core";
import { Activity, ArrowLeft, RotateCcw, StopCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { get, post, qs } from "../api";
import { iconFor } from "../editor/nodes";
import { Link, useRouter } from "../router";
import { nodeDef, useSession } from "../session";
import { Button, Empty, ErrorBox, JsonView, Loading, Pagination, StatusBadge, errorMessage, formatDate, formatDuration, timeAgo, useAsync, useToast } from "../ui";

interface ExecutionItem {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: string;
  mode: string;
  use_mocks: boolean;
  error: { message?: string } | null;
  created_at: string;
  duration_ms: number;
  step_executions: number;
}

export function ExecutionsPage({ failedOnly }: { failedOnly?: boolean }) {
  const { navigate, search } = useRouter();
  const [status, setStatus] = useState(failedOnly ? "failed" : "");
  const [workflowId, setWorkflowId] = useState(search.get("workflowId") ?? "");
  const [offset, setOffset] = useState(0);
  useEffect(() => setStatus(failedOnly ? "failed" : ""), [failedOnly]);
  const workflows = useAsync(() => get<{ items: Array<{ id: string; name: string }> }>("/api/workflows?limit=200&status=all"));
  const list = useAsync(() => get<{ items: ExecutionItem[]; total: number; limit: number; offset: number }>(`/api/executions${qs({ status, workflowId, limit: 30, offset })}`), [status, workflowId, offset]);
  // Live refresh while anything is in flight.
  useEffect(() => {
    if (!list.data?.items.some((i) => ["queued", "running"].includes(i.status))) return;
    const t = setTimeout(() => void list.reload(), 2000);
    return () => clearTimeout(t);
  }, [list.data, list.reload]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{failedOnly ? "Failed executions" : "Executions"}</h1>
          <p>{failedOnly ? "Inspect errors and retry failed steps." : "Every workflow run with step-by-step inputs and outputs (sensitive values redacted)."}</p>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <select className="input" style={{ width: 160 }} value={status} onChange={(e) => (setStatus(e.target.value), setOffset(0))} aria-label="Status filter">
          <option value="">All statuses</option>
          {["queued", "running", "waiting", "succeeded", "failed", "cancelled"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className="input" style={{ width: 260 }} value={workflowId} onChange={(e) => (setWorkflowId(e.target.value), setOffset(0))} aria-label="Workflow filter">
          <option value="">All workflows</option>
          {workflows.data?.items.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={() => void list.reload()}>
          Refresh
        </Button>
      </div>
      <div className="card">
        {list.error ? (
          <div className="card-pad">
            <ErrorBox error={list.error} onRetry={list.reload} />
          </div>
        ) : !list.data ? (
          <Loading />
        ) : list.data.items.length === 0 ? (
          <Empty title={failedOnly ? "No failed executions" : "No executions yet"} icon={<Activity size={32} />} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Workflow</th>
                    <th>Status</th>
                    <th>Trigger</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => navigate(`/executions/${e.id}`)}>
                      <td style={{ fontWeight: 600 }}>{e.workflow_name}</td>
                      <td>
                        <StatusBadge status={e.status} />
                      </td>
                      <td>
                        <span className="badge">{e.mode}</span> {e.use_mocks && <span className="badge violet">simulated</span>}
                      </td>
                      <td className="faint" title={formatDate(e.created_at)}>
                        {timeAgo(e.created_at)}
                      </td>
                      <td className="faint">{formatDuration(e.duration_ms)}</td>
                      <td className="muted truncate" style={{ maxWidth: 360 }}>
                        {e.error?.message ?? ""}
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
    </div>
  );
}

interface StepRow {
  node_id: string;
  status: string;
  attempt: number;
  branch: string | null;
  input: unknown;
  output: unknown;
  error: { message?: string; kind?: string } | null;
  wait_state: { until?: string; reason?: string } | null;
  next_attempt_at: string | null;
  logs: Array<{ time: string; message: string }>;
  started_at: string | null;
  finished_at: string | null;
}

interface ExecutionDetail {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: string;
  mode: string;
  use_mocks: boolean;
  error: { message?: string; nodeId?: string } | null;
  trigger_data: unknown;
  definition: WorkflowDefinition;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  retry_of: string | null;
  parent_execution_id: string | null;
  steps: StepRow[];
  attempts: Array<{ node_id: string; attempt: number; status: string; error: { message?: string } | null; duration_ms: number | null }>;
  children: Array<{ id: string; status: string }>;
  approvals: Array<{ id: string; node_id: string; title: string; status: string }>;
}

export function ExecutionDetailPage({ id }: { id: string }) {
  const { catalog, can } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();
  const exec = useAsync(() => get<ExecutionDetail>(`/api/executions/${id}`), [id]);
  useEffect(() => {
    if (!exec.data || !["queued", "running", "waiting"].includes(exec.data.status)) return;
    const t = setTimeout(() => void exec.reload(), exec.data.status === "waiting" ? 5000 : 1500);
    return () => clearTimeout(t);
  }, [exec.data, exec.reload]);
  if (exec.error) return <div className="page"><ErrorBox error={exec.error} onRetry={exec.reload} /></div>;
  if (!exec.data) return <Loading />;
  const e = exec.data;
  const order = e.definition.nodes.map((n) => n.id);
  const steps = [...e.steps].sort((a, b) => order.indexOf(a.node_id) - order.indexOf(b.node_id));

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      const r = (await fn()) as { executionId?: string };
      toast(msg);
      if (r?.executionId && r.executionId !== id) navigate(`/executions/${r.executionId}`);
      else await exec.reload();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="row">
            <Link to="/executions">
              <ArrowLeft size={16} />
            </Link>
            <h1>{e.workflow_name}</h1>
            <StatusBadge status={e.status} />
            {e.use_mocks && <span className="badge violet">simulated external actions</span>}
          </div>
          <p>
            <code>{e.id}</code> · {e.mode} · started {formatDate(e.started_at ?? e.created_at)}
            {e.finished_at && ` · took ${formatDuration(new Date(e.finished_at).getTime() - new Date(e.started_at ?? e.created_at).getTime())}`}
            {e.retry_of && (
              <>
                {" "}
                · retry of <Link to={`/executions/${e.retry_of}`}>{e.retry_of}</Link>
              </>
            )}
          </p>
        </div>
        <div className="row">
          <Button onClick={() => navigate(`/workflows/${e.workflow_id}`)}>Open workflow</Button>
          {can("editor") && ["queued", "running", "waiting"].includes(e.status) && (
            <Button variant="danger" onClick={() => act(() => post(`/api/executions/${id}/cancel`), "Cancellation requested")}>
              <StopCircle size={15} /> Cancel
            </Button>
          )}
          {can("editor") && ["failed", "cancelled"].includes(e.status) && (
            <>
              <Button variant="primary" onClick={() => act(() => post(`/api/executions/${id}/retry`, { strategy: "failed_steps" }), "Retrying failed steps")} title="Re-runs only failed and skipped steps; succeeded steps are not repeated">
                <RotateCcw size={15} /> Retry failed steps
              </Button>
              <Button onClick={() => act(() => post(`/api/executions/${id}/retry`, { strategy: "from_start" }), "Started a new run")}>Re-run from start</Button>
            </>
          )}
        </div>
      </div>
      {e.error?.message && <div className="alert error" style={{ marginBottom: 16 }}>{e.error.message}</div>}
      {e.approvals.some((a) => a.status === "pending") && (
        <div className="alert warn" style={{ marginBottom: 16 }}>
          Waiting for approval — <Link to="/approvals">review it in Approvals</Link>.
        </div>
      )}
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
        <div>
          {steps.map((s) => {
            const node = e.definition.nodes.find((n) => n.id === s.node_id);
            const nd = node ? nodeDef(catalog, node.type) : undefined;
            const attempts = e.attempts.filter((a) => a.node_id === s.node_id);
            const duration = s.started_at && s.finished_at ? new Date(s.finished_at).getTime() - new Date(s.started_at).getTime() : null;
            return (
              <details key={s.node_id} className="timeline-step" open={s.status === "failed"}>
                <summary>
                  <span className={`node-icon k-${nd?.kind ?? "action"}`}>{iconFor(node?.type ?? "")}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{node?.name ?? s.node_id}</div>
                    <div className="faint">
                      {nd?.name} {s.branch && <>· branch <b>{s.branch}</b></>} {s.attempt > 1 && <>· {s.attempt} attempts</>}
                    </div>
                  </div>
                  {duration !== null && <span className="faint">{formatDuration(duration)}</span>}
                  <StatusBadge status={s.status} />
                </summary>
                <div className="body">
                  {s.error?.message && <div className="alert error">{s.error.message}</div>}
                  {s.wait_state?.reason && (
                    <div className="alert warn">
                      Waiting ({s.wait_state.reason}){s.wait_state.until ? ` until ${formatDate(s.wait_state.until)}` : ""}
                    </div>
                  )}
                  {s.next_attempt_at && s.status === "pending" && <div className="alert info">Retry scheduled for {formatDate(s.next_attempt_at)}</div>}
                  {s.input !== null && s.input !== undefined && (
                    <>
                      <div className="label">Input (rendered configuration)</div>
                      <JsonView value={s.input} maxHeight={240} />
                    </>
                  )}
                  {s.output !== null && s.output !== undefined && (
                    <>
                      <div className="label">Output</div>
                      <JsonView value={s.output} maxHeight={300} />
                    </>
                  )}
                  {s.logs?.length > 0 && (
                    <>
                      <div className="label">Logs</div>
                      <pre className="json mono">{s.logs.map((l) => `${l.time.slice(11, 19)}  ${l.message}`).join("\n")}</pre>
                    </>
                  )}
                  {attempts.length > 1 && (
                    <>
                      <div className="label">Attempts</div>
                      {attempts.map((a) => (
                        <div key={a.attempt} className="small">
                          #{a.attempt} <StatusBadge status={a.status} /> {formatDuration(a.duration_ms)} <span className="muted">{a.error?.message}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </details>
            );
          })}
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h3>Trigger data</h3>
            </div>
            <div className="card-pad">
              <JsonView value={e.trigger_data} maxHeight={420} />
            </div>
          </div>
          {e.children.length > 0 && (
            <div className="card card-pad">
              <h3 style={{ marginBottom: 8 }}>Sub-workflow runs</h3>
              {e.children.map((c) => (
                <div key={c.id} className="row small">
                  <Link to={`/executions/${c.id}`}>{c.id}</Link> <StatusBadge status={c.status} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
