import { LayoutTemplate } from "lucide-react";
import { useState } from "react";
import { get, post } from "../api";
import { useRouter } from "../router";
import { useSession } from "../session";
import { Button, Empty, ErrorBox, Loading, Modal, useAsync, useToast, errorMessage } from "../ui";

interface Template {
  id: string;
  name: string;
  category: string;
  description: string;
  integrations: string[];
  setup: string[];
}

export function TemplatesPage() {
  const { can, catalog } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();
  const list = useAsync(() => get<Template[]>("/api/templates"));
  const [category, setCategory] = useState("All");
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<{ workflowId: string; setup: string[]; created: { tables: Array<{ name: string }>; forms: Array<{ name: string; slug: string }> } } | null>(null);
  if (list.error) return <div className="page"><ErrorBox error={list.error} onRetry={list.reload} /></div>;
  if (!list.data) return <Loading />;
  const categories = ["All", ...new Set(list.data.map((t) => t.category))];
  const items = list.data.filter((t) => category === "All" || t.category === category);
  const integrationName = (id: string) => catalog?.integrations.find((i) => i.id === id)?.name ?? id;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Templates</h1>
          <p>Editable starting points. Using a template creates real tables, forms and a draft workflow you can change freely.</p>
        </div>
      </div>
      <div className="tabs">
        {categories.map((c) => (
          <button key={c} className={category === c ? "active" : ""} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <Empty title="No templates" icon={<LayoutTemplate size={32} />} />
      ) : (
        <div className="grid grid-3">
          {items.map((t) => (
            <div key={t.id} className="card hover tpl-card">
              <span className="badge violet" style={{ alignSelf: "flex-start" }}>
                {t.category}
              </span>
              <h3>{t.name}</h3>
              <div className="muted small" style={{ flex: 1 }}>
                {t.description}
              </div>
              <div className="row" style={{ gap: 4 }}>
                {t.integrations.map((i) => (
                  <span key={i} className="badge">
                    {integrationName(i)}
                  </span>
                ))}
              </div>
              {can("editor") && (
                <Button
                  variant="primary"
                  loading={busy === t.id}
                  onClick={async () => {
                    setBusy(t.id);
                    try {
                      const r = await post<{ workflow: { id: string }; setup: string[]; created: { tables: Array<{ name: string }>; forms: Array<{ name: string; slug: string }> } }>(`/api/templates/${t.id}/instantiate`);
                      setCreated({ workflowId: r.workflow.id, setup: r.setup, created: r.created });
                    } catch (err) {
                      toast(errorMessage(err), "error");
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Use template
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {created && (
        <Modal
          title="Template ready"
          onClose={() => setCreated(null)}
          footer={
            <Button variant="primary" onClick={() => navigate(`/workflows/${created.workflowId}`)}>
              Open in editor
            </Button>
          }
        >
          <div className="muted">A draft workflow was created. It does not run until you publish it.</div>
          {created.created.tables.length > 0 && <div>Tables created: {created.created.tables.map((t) => t.name).join(", ")}</div>}
          {created.created.forms.map((f) => (
            <div key={f.slug}>
              Public form "{f.name}": <a href={`/f/${f.slug}`} target="_blank" rel="noreferrer">{`${window.location.origin}/f/${f.slug}`}</a>
            </div>
          ))}
          <div className="label">Next steps</div>
          <ol style={{ margin: 0, paddingLeft: 18 }} className="small">
            {created.setup.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </Modal>
      )}
    </div>
  );
}
