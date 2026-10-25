import { CheckSquare, Mail } from "lucide-react";
import { Fragment, useState } from "react";
import { get, post } from "../api";
import { Link } from "../router";
import { useSession } from "../session";
import { Button, Empty, ErrorBox, JsonView, Loading, StatusBadge, errorMessage, formatDate, timeAgo, useAsync, useToast } from "../ui";

interface Approval {
  id: string;
  execution_id: string;
  workflow_name: string;
  workflow_id: string;
  title: string;
  message: string;
  data: unknown;
  status: string;
  comment: string | null;
  created_at: string;
  expires_at: string | null;
}

export function ApprovalsPage() {
  const { can } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState("pending");
  const list = useAsync(() => get<Approval[]>(`/api/approvals?status=${status}`), [status]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const decide = async (a: Approval, decision: "approved" | "rejected") => {
    try {
      await post(`/api/approvals/${a.id}/decision`, { decision, comment: comments[a.id] });
      toast(decision === "approved" ? "Approved — the workflow continues" : "Rejected");
      await list.reload();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Approvals</h1>
          <p>Human-in-the-loop checkpoints, e.g. before AI-drafted messages are sent.</p>
        </div>
      </div>
      <div className="tabs">
        {["pending", "all"].map((s) => (
          <button key={s} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>
            {s === "pending" ? "Pending" : "History"}
          </button>
        ))}
      </div>
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <div className="card">
          <Empty title={status === "pending" ? "Nothing waiting for approval" : "No approvals yet"} icon={<CheckSquare size={32} />} />
        </div>
      ) : (
        <div className="stack">
          {list.data.map((a) => (
            <div key={a.id} className="card">
              <div className="card-head">
                <div>
                  <h3>{a.title}</h3>
                  <div className="faint">
                    {a.workflow_name} · <Link to={`/executions/${a.execution_id}`}>execution</Link> · {timeAgo(a.created_at)}
                    {a.expires_at && a.status === "pending" && ` · expires ${formatDate(a.expires_at)}`}
                  </div>
                </div>
                <StatusBadge status={a.status} />
              </div>
              <div className="card-pad stack">
                {a.message && <div style={{ whiteSpace: "pre-wrap" }}>{a.message}</div>}
                {a.data !== null && a.data !== undefined && <JsonView value={a.data} maxHeight={320} />}
                {a.comment && <div className="muted">Comment: {a.comment}</div>}
                {a.status === "pending" && can("editor") && (
                  <div className="row">
                    <input className="input" style={{ maxWidth: 420 }} placeholder="Optional comment" value={comments[a.id] ?? ""} onChange={(e) => setComments({ ...comments, [a.id]: e.target.value })} aria-label="Comment" />
                    <Button variant="primary" onClick={() => decide(a, "approved")}>
                      Approve
                    </Button>
                    <Button variant="danger" onClick={() => decide(a, "rejected")}>
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface OutboxItem {
  id: string;
  execution_id: string | null;
  provider: string;
  status: string;
  to_addresses: string;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  error: string | null;
  created_at: string;
}

export function OutboxPage() {
  const list = useAsync(() => get<OutboxItem[]>("/api/outbox"));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Email outbox</h1>
          <p>
            Every email a workflow produced. <span className="badge violet">captured</span> means no SMTP was configured and the message was <b>not delivered</b>; <span className="badge violet">simulated</span> comes from test runs.
          </p>
        </div>
      </div>
      <div className="card">
        {list.error ? (
          <div className="card-pad">
            <ErrorBox error={list.error} onRetry={list.reload} />
          </div>
        ) : !list.data ? (
          <Loading />
        ) : list.data.length === 0 ? (
          <Empty title="No emails yet" icon={<Mail size={32} />} />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>To</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Via</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((m) => (
                <Fragment key={m.id}>
                  <tr className="clickable" onClick={() => setOpen(open === m.id ? null : m.id)}>
                    <td>{m.to_addresses}</td>
                    <td style={{ fontWeight: 600 }}>{m.subject}</td>
                    <td>
                      <StatusBadge status={m.status} />
                    </td>
                    <td className="faint">{m.provider}</td>
                    <td className="faint">{timeAgo(m.created_at)}</td>
                  </tr>
                  {open === m.id && (
                    <tr>
                      <td colSpan={5}>
                        {m.error && <div className="alert error">{m.error}</div>}
                        <pre className="json" style={{ fontFamily: "var(--font)", fontSize: 13 }}>{m.body_text ?? m.body_html ?? ""}</pre>
                        {m.execution_id && <Link to={`/executions/${m.execution_id}`}>Open execution</Link>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
