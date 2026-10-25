import { Search } from "lucide-react";
import { useState } from "react";
import { iconFor } from "../editor/nodes";
import { useSession } from "../session";
import { Loading } from "../ui";

const AVAILABILITY: Record<string, { label: string; cls: string; title: string }> = {
  local: { label: "Built-in", cls: "green", title: "Runs locally with no external account." },
  live: { label: "Live API", cls: "blue", title: "Calls the provider's real API; needs an account/credentials." },
  "live+mock": { label: "Live + test mode", cls: "blue", title: "Calls the real API when connected; simulated in test runs or when not connected." },
};

export function IntegrationsPage() {
  const { catalog } = useSession();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  if (!catalog) return <Loading />;
  const items = catalog.integrations.filter((i) => !q || `${i.name} ${i.description} ${i.category}`.toLowerCase().includes(q.toLowerCase()) || catalog.nodes.some((n) => n.integration === i.id && n.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Integrations</h1>
          <p>Every connector, its triggers and actions, and what you need before it can run for real.</p>
        </div>
        <div className="search" style={{ width: 300 }}>
          <Search size={15} />
          <input className="input" placeholder="Search integrations or actions" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search integrations" />
        </div>
      </div>
      <div className="grid grid-2">
        {items.map((i) => {
          const nodes = catalog.nodes.filter((n) => n.integration === i.id);
          const av = AVAILABILITY[i.availability]!;
          const expanded = open === i.id;
          return (
            <div key={i.id} className="card">
              <div className="card-pad stack" style={{ gap: 10 }}>
                <div className="row">
                  <span className={`node-icon k-${nodes[0]?.kind ?? "action"}`}>{iconFor(nodes[0]?.type ?? "")}</span>
                  <div style={{ flex: 1 }}>
                    <h3>{i.name}</h3>
                    <div className="faint">
                      {i.category} · v{i.version}
                    </div>
                  </div>
                  <span className={`badge ${av.cls}`} title={av.title}>
                    {av.label}
                  </span>
                </div>
                <div className="muted small">{i.description}</div>
                <div className="row" style={{ gap: 4 }}>
                  {nodes.slice(0, expanded ? undefined : 6).map((n) => (
                    <span key={n.type} className="badge" title={n.description}>
                      {n.kind === "trigger" ? "⚡ " : ""}
                      {n.name}
                    </span>
                  ))}
                  {!expanded && nodes.length > 6 && <span className="faint">+{nodes.length - 6} more</span>}
                </div>
                {(i.prerequisites.length > 0 || i.rateLimits || i.scopes) && (
                  <button className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(expanded ? null : i.id)} aria-expanded={expanded}>
                    {expanded ? "Hide details" : "Requirements & limits"}
                  </button>
                )}
                {expanded && (
                  <div className="stack small" style={{ gap: 6 }}>
                    {i.prerequisites.length > 0 && (
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {i.prerequisites.map((p, k) => (
                          <li key={k}>{p}</li>
                        ))}
                      </ul>
                    )}
                    {i.scopes && (
                      <div>
                        Scopes: <code>{i.scopes.join(" ")}</code>
                      </div>
                    )}
                    {i.rateLimits && <div>Rate limits: {i.rateLimits}</div>}
                    {i.docsUrl && (
                      <a href={i.docsUrl} target="_blank" rel="noreferrer">
                        Provider documentation
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
