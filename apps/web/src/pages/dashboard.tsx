import { Plus } from "lucide-react";
import { get } from "../api";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { Button, Empty, ErrorBox, Loading, timeAgo, useAsync } from "../ui";

interface Dashboard {
  workflows: { total: number; active: number; paused: number };
  executions7d: Record<string, number>;
  daily: Array<{ day: string; succeeded: number; failed: number; other: number }>;
  recentFailures: Array<{ id: string; workflow_id: string; workflow_name: string; error: { message?: string } | null; created_at: string }>;
  pendingApprovals: number;
  aiThisMonth: { tokens: number; cost: number | null; calls: number };
  emails7d: { sent: number; captured: number };
}

function Chart({ daily }: { daily: Dashboard["daily"] }) {
  const days: Dashboard["daily"] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    days.push(daily.find((x) => x.day === d) ?? { day: d, succeeded: 0, failed: 0, other: 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.succeeded + d.failed + d.other));
  return (
    <div>
      <div className="chart-bars" role="img" aria-label="Executions per day for the last 14 days">
        {days.map((d) => (
          <div className="col" key={d.day} title={`${d.day}: ${d.succeeded} succeeded, ${d.failed} failed, ${d.other} other`}>
            <div className="seg" style={{ height: `${(d.succeeded / max) * 100}%`, background: "var(--success)" }} />
            <div className="seg" style={{ height: `${(d.failed / max) * 100}%`, background: "var(--danger)" }} />
            <div className="seg" style={{ height: `${(d.other / max) * 100}%`, background: "var(--border-strong)" }} />
          </div>
        ))}
      </div>
      <div className="chart-x">
        {days.map((d, i) => (
          <span key={d.day}>{i % 2 === 0 ? d.day.slice(5) : ""}</span>
        ))}
      </div>
      <div className="row faint" style={{ marginTop: 8, gap: 14 }}>
        <span>
          <span className="dot" style={{ color: "var(--success)" }} /> succeeded
        </span>
        <span>
          <span className="dot" style={{ color: "var(--danger)" }} /> failed
        </span>
        <span>
          <span className="dot" style={{ color: "var(--border-strong)" }} /> waiting / other
        </span>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { me, can } = useSession();
  const { navigate } = useRouter();
  const { data, error, loading, reload } = useAsync(() => get<Dashboard>("/api/dashboard"), [me?.workspace.id]);
  if (loading && !data) return <Loading />;
  if (error) return <div className="page"><ErrorBox error={error} onRetry={reload} /></div>;
  const d = data!;
  const total7 = Object.values(d.executions7d).reduce((a, b) => a + b, 0);
  const failed7 = d.executions7d.failed ?? 0;
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Welcome back, {me?.user.name.split(" ")[0]}</h1>
          <p>Here is what your automations did recently.</p>
        </div>
        {can("editor") && (
          <div className="row">
            <Button onClick={() => navigate("/templates")}>Browse templates</Button>
            <Button variant="primary" onClick={() => navigate("/workflows?new=1")}>
              <Plus size={15} /> New workflow
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="label">Active workflows</div>
          <div className="value">{d.workflows.active}</div>
          <div className="sub">
            {d.workflows.total} total · {d.workflows.paused} paused
          </div>
        </div>
        <div className="card stat">
          <div className="label">Executions (7 days)</div>
          <div className="value">{total7}</div>
          <div className="sub">{total7 ? `${Math.round(((total7 - failed7) / total7) * 100)}% without failure` : "No runs yet"}</div>
        </div>
        <div className="card stat">
          <div className="label">Failed (7 days)</div>
          <div className="value" style={{ color: failed7 ? "var(--danger)" : undefined }}>
            {failed7}
          </div>
          <div className="sub">
            <Link to="/executions/failed">Review failures</Link>
          </div>
        </div>
        <div className="card stat">
          <div className="label">Pending approvals</div>
          <div className="value">{d.pendingApprovals}</div>
          <div className="sub">
            <Link to="/approvals">Open approvals</Link>
          </div>
        </div>
      </div>
      <div className="grid grid-3">
        <div className="card" style={{ gridColumn: "span 2" }}>
          <div className="card-head">
            <h2>Executions, last 14 days</h2>
            <Link to="/executions">All executions</Link>
          </div>
          <div className="card-pad">{total7 || d.daily.length ? <Chart daily={d.daily} /> : <Empty title="No executions yet">Run a workflow to see activity here.</Empty>}</div>
        </div>
        <div className="stack">
          <div className="card stat">
            <div className="label">AI this month</div>
            <div className="value">{d.aiThisMonth.tokens.toLocaleString()}</div>
            <div className="sub">
              tokens · {d.aiThisMonth.calls} calls{d.aiThisMonth.cost !== null ? ` · ~$${d.aiThisMonth.cost.toFixed(4)}` : ""}
            </div>
          </div>
          <div className="card stat">
            <div className="label">Emails (7 days)</div>
            <div className="value">{d.emails7d.sent}</div>
            <div className="sub">
              sent via SMTP · {d.emails7d.captured} captured locally (<Link to="/outbox">outbox</Link>)
            </div>
          </div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Recent failures</h2>
        </div>
        {d.recentFailures.length === 0 ? (
          <Empty title="No failures">Everything ran smoothly.</Empty>
        ) : (
          <table className="data">
            <tbody>
              {d.recentFailures.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => navigate(`/executions/${f.id}`)}>
                  <td style={{ fontWeight: 600 }}>{f.workflow_name}</td>
                  <td className="muted truncate" style={{ maxWidth: 520 }}>
                    {f.error?.message ?? "Failed"}
                  </td>
                  <td className="faint" style={{ textAlign: "right" }}>
                    {timeAgo(f.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
