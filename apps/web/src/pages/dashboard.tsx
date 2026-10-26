import { Activity, AlertOctagon, ArrowRight, Bot, CheckSquare, Database, LayoutTemplate, Mail, Plus, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { get } from "../api";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { Empty, ErrorBox, timeAgo, useAsync } from "../ui";

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
            <div className="seg" style={{ height: `${(d.succeeded / max) * 100}%`, background: "linear-gradient(180deg, var(--accent-2), var(--accent))" }} />
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
      <div className="row faint" style={{ marginTop: 10, gap: 16 }}>
        <span className="row" style={{ gap: 6 }}>
          <span className="dot" style={{ color: "var(--accent)" }} /> succeeded
        </span>
        <span className="row" style={{ gap: 6 }}>
          <span className="dot" style={{ color: "var(--danger)" }} /> failed
        </span>
        <span className="row" style={{ gap: 6 }}>
          <span className="dot" style={{ color: "var(--border-strong)" }} /> waiting / other
        </span>
      </div>
    </div>
  );
}

function Stat({ icon, tone, label, value, sub }: { icon: ReactNode; tone?: string; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="label">
        <span className={`icon-tile ${tone ?? ""}`}>{icon}</span>
        {label}
      </div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function StatSkeleton() {
  return (
    <div className="card stat">
      <div className="skeleton" style={{ width: 120, height: 34 }} />
      <div className="skeleton" style={{ width: 70, height: 30, marginTop: 12 }} />
    </div>
  );
}

export function DashboardPage() {
  const { me, can } = useSession();
  const { navigate } = useRouter();
  const { data, error, reload } = useAsync(() => get<Dashboard>("/api/dashboard"), [me?.workspace.id]);
  if (error) return <div className="page"><ErrorBox error={error} onRetry={reload} /></div>;
  const d = data;
  const total7 = d ? Object.values(d.executions7d).reduce((a, b) => a + b, 0) : 0;
  const failed7 = d?.executions7d.failed ?? 0;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const quick: Array<{ to: string; icon: ReactNode; title: string; text: string; tone?: string }> = [
    { to: "/workflows?new=1", icon: <Plus size={17} />, title: "New workflow", text: "Start from a blank canvas" },
    { to: "/templates", icon: <LayoutTemplate size={17} />, title: "Templates", text: "Lead intake, email, WhatsApp…", tone: "blue" },
    { to: "/ai", icon: <Bot size={17} />, title: "Connect AI", text: "Local Ollama or a hosted model", tone: "amber" },
    { to: "/tables", icon: <Database size={17} />, title: "Data tables", text: "Leads, tickets, customers", tone: "green" },
  ];

  return (
    <div className="page">
      <div className="hero" style={{ marginBottom: 20 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", position: "relative", zIndex: 1 }}>
          <div>
            <h1>
              {greeting}, {me?.user.name.split(" ")[0]}
            </h1>
            <p>{d ? (total7 ? `${total7} runs this week · ${d.workflows.active} active workflows` : "Your automations are ready. Build your first one in minutes.") : "Loading your workspace…"}</p>
          </div>
          {can("editor") && (
            <div className="row">
              <button className="btn" onClick={() => navigate("/templates")}>
                Browse templates
              </button>
              <button className="btn btn-light" onClick={() => navigate("/workflows?new=1")}>
                <Plus size={15} /> New workflow
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {!d ? (
          [0, 1, 2, 3].map((i) => <StatSkeleton key={i} />)
        ) : (
          <>
            <Stat icon={<Workflow size={17} />} label="Active workflows" value={d.workflows.active} sub={`${d.workflows.total} total · ${d.workflows.paused} paused`} />
            <Stat icon={<Activity size={17} />} tone="blue" label="Runs · 7 days" value={total7} sub={total7 ? `${Math.round(((total7 - failed7) / total7) * 100)}% without failure` : "No runs yet"} />
            <Stat icon={<AlertOctagon size={17} />} tone={failed7 ? "red" : "green"} label="Failed · 7 days" value={failed7} sub={<Link to="/executions/failed">Review failures</Link>} />
            <Stat icon={<CheckSquare size={17} />} tone="amber" label="Pending approvals" value={d.pendingApprovals} sub={<Link to="/approvals">Open approvals</Link>} />
          </>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h2>Executions, last 14 days</h2>
            <Link to="/executions">
              All executions <ArrowRight size={13} style={{ verticalAlign: -2 }} />
            </Link>
          </div>
          <div className="card-pad">{!d ? <div className="skeleton" style={{ height: 180 }} /> : total7 || d.daily.length ? <Chart daily={d.daily} /> : <Empty title="No executions yet">Run a workflow to see activity here.</Empty>}</div>
        </div>
        <div className="stack">
          <Stat icon={<Bot size={17} />} label="AI tokens this month" value={d ? d.aiThisMonth.tokens.toLocaleString() : "—"} sub={d ? `${d.aiThisMonth.calls} calls${d.aiThisMonth.cost !== null ? ` · ~$${d.aiThisMonth.cost.toFixed(4)}` : ""}` : undefined} />
          <Stat icon={<Mail size={17} />} tone="green" label="Emails sent · 7 days" value={d?.emails7d.sent ?? "—"} sub={d ? <>{d.emails7d.captured} captured locally · <Link to="/outbox">outbox</Link></> : undefined} />
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
        <div className="card">
          <div className="card-head">
            <h2>Recent failures</h2>
          </div>
          {!d ? (
            <div className="card-pad">
              <div className="skeleton" style={{ height: 120 }} />
            </div>
          ) : d.recentFailures.length === 0 ? (
            <Empty title="No failures">Everything ran smoothly.</Empty>
          ) : (
            <table className="data">
              <tbody>
                {d.recentFailures.map((f) => (
                  <tr key={f.id} className="clickable" onClick={() => navigate(`/executions/${f.id}`)}>
                    <td style={{ fontWeight: 600 }}>{f.workflow_name}</td>
                    <td className="muted truncate" style={{ maxWidth: 280 }}>
                      {f.error?.message ?? "Failed"}
                    </td>
                    <td className="faint" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {timeAgo(f.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Quick start</h2>
          </div>
          <div className="grid grid-2" style={{ padding: 12, gap: 8 }}>
            {quick.map((q) => (
              <button key={q.to} className="card hover quick" onClick={() => navigate(q.to)}>
                <span className={`icon-tile ${q.tone ?? ""}`}>{q.icon}</span>
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 640 }}>{q.title}</div>
                  <div className="faint truncate">{q.text}</div>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
