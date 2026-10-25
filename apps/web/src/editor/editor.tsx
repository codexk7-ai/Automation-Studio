import type { FieldSpec, NodeTypeDefinition, ValidationIssue, WorkflowDefinition, WorkflowNode } from "@automation-studio/core";
import {
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { AlertTriangle, ArrowLeft, Copy, Download, FlaskConical, History, Pause, Play, Rocket, Save, Search, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, get, post, put } from "../api";
import { Link } from "../router";
import { nodeDef, useSession } from "../session";
import { Button, ErrorBox, JsonView, Loading, Modal, StatusBadge, errorMessage, formatDate, useToast } from "../ui";
import { FieldInput, type Inserter } from "./fields";
import { ancestors, branchesOf, iconFor, newNodeId, nodeTypes, type FlowNodeData } from "./nodes";


interface WorkflowResponse {
  id: string;
  name: string;
  description: string;
  status: string;
  draft_definition: WorkflowDefinition;
  draft_updated_at: string;
  activeVersion: number | null;
  webhookUrl: string | null;
  trigger_type: string | null;
  schedule: { cron: string; timezone: string; next_run_at: string | null } | null;
  pollState: { next_poll_at: string | null; last_error: string | null } | null;
}

interface ValidationState {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

type Samples = Record<string, { source: string; output: unknown }>;

export function WorkflowEditor({ id }: { id: string }) {
  return (
    <ReactFlowProvider>
      <EditorInner id={id} />
    </ReactFlowProvider>
  );
}

function EditorInner({ id }: { id: string }) {
  const { catalog, can } = useSession();
  const toast = useToast();

  const rf = useReactFlow();
  const [wf, setWf] = useState<WorkflowResponse | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [def, setDef] = useState<WorkflowDefinition | null>(null);
  const [name, setName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationState>({ errors: [], warnings: [] });
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [lastRun, setLastRun] = useState<{ id: string; status: string; error?: unknown } | null>(null);
  const [samples, setSamples] = useState<Samples>({});
  const [modal, setModal] = useState<null | "run" | "publish" | "versions" | "import">(null);
  const [showIssues, setShowIssues] = useState(true);
  const editable = can("editor");
  const inserter = useRef<Inserter | null>(null);

  const load = useCallback(async () => {
    try {
      const w = await get<WorkflowResponse>(`/api/workflows/${id}`);
      setWf(w);
      setDef(w.draft_definition);
      setName(w.name);
      setDirty(false);
      setSamples(await get<Samples>(`/api/workflows/${id}/sample-data`));
    } catch (err) {
      setLoadError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  // Debounced server-side validation of the current draft.
  useEffect(() => {
    if (!def) return;
    const t = setTimeout(async () => {
      try {
        setValidation(await post<ValidationState>("/api/validate", { definition: def }));
      } catch (err) {
        if (err instanceof ApiError) setValidation({ errors: [{ code: "schema", message: err.message }], warnings: [] });
      }
    }, 450);
    return () => clearTimeout(t);
  }, [def]);

  // Warn about unsaved changes.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const errorNodes = useMemo(() => new Set(validation.errors.map((e) => e.nodeId).filter(Boolean) as string[]), [validation]);

  // Keep React Flow nodes (with measured sizes) in sync with the definition.
  useEffect(() => {
    if (!def) return;
    setRfNodes((prev) =>
      def.nodes.map((n, i) => {
        const old = prev.find((p) => p.id === n.id);
        const d = nodeDef(catalog, n.type);
        const data: FlowNodeData = { node: n, def: d, status: statuses[n.id], hasError: errorNodes.has(n.id), branches: branchesOf(d, n) };
        return { ...(old ?? {}), id: n.id, type: "wf", position: n.position ?? old?.position ?? { x: 300, y: 40 + i * 150 }, data, selected: n.id === selected } as Node;
      }),
    );
  }, [def, catalog, statuses, errorNodes, selected]);

  const edges: Edge[] = useMemo(
    () =>
      (def?.edges ?? []).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.branch ?? undefined,
        label: e.branch ?? undefined,
        selected: e.id === selectedEdge,
        animated: statuses[e.source] === "succeeded" && !!statuses[e.target] && statuses[e.target] !== "skipped",
      })),
    [def, selectedEdge, statuses],
  );

  const update = useCallback((fn: (d: WorkflowDefinition) => WorkflowDefinition) => {
    setDef((d) => (d ? fn(structuredClone(d)) : d));
    setDirty(true);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setRfNodes((nds) => applyNodeChanges(changes, nds));
      for (const c of changes) {
        if (c.type === "position" && c.position && editable) {
          const pos = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
          setDef((d) => (d ? { ...d, nodes: d.nodes.map((n) => (n.id === c.id ? { ...n, position: pos } : n)) } : d));
          if (c.dragging === false) setDirty(true);
        } else if (c.type === "select" && c.selected) {
          setSelected(c.id);
          setSelectedEdge(null);
        }
      }
    },
    [editable],
  );

  const removeNodes = useCallback(
    (ids: string[]) => {
      update((d) => ({ ...d, nodes: d.nodes.filter((n) => !ids.includes(n.id)), edges: d.edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target)) }));
      setSelected(null);
    },
    [update],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type === "select") setSelectedEdge(c.selected ? c.id : null);
        if (c.type === "remove" && editable) update((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== c.id) }));
      }
    },
    [update, editable],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (!def || c.source === c.target) return false;
      const target = def.nodes.find((n) => n.id === c.target);
      if (!target || target.type.startsWith("trigger.")) return false;
      return !def.edges.some((e) => e.source === c.source && e.target === c.target && (e.branch ?? null) === (c.sourceHandle ?? null));
    },
    [def],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!editable || !isValidConnection(c)) return;
      update((d) => ({ ...d, edges: [...d.edges, { id: `e_${Math.random().toString(36).slice(2, 9)}`, source: c.source!, target: c.target!, branch: c.sourceHandle ?? null }] }));
    },
    [update, isValidConnection, editable],
  );

  const addNode = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      if (!def || !catalog) return;
      const nd = nodeDef(catalog, type)!;
      if (nd.kind === "trigger") {
        // Replace the existing trigger, keeping its outgoing connections.
        const old = def.nodes.find((n) => n.type.startsWith("trigger."));
        update((d) => {
          const nid = old?.id ?? "trigger";
          const nodes = d.nodes.filter((n) => n.id !== nid);
          nodes.unshift({ id: nid, type, name: nd.name, config: defaults(nd), position: old?.position ?? position ?? { x: 80, y: 160 }, onError: "fail", disabled: false });
          return { ...d, nodes };
        });
        setSelected(old?.id ?? "trigger");
        return;
      }
      const nid = newNodeId(def, type);
      const from = selected ? def.nodes.find((n) => n.id === selected) : undefined;
      const pos = position ?? (from?.position ? { x: from.position.x, y: from.position.y + 150 } : { x: 300, y: 200 });
      const fromDef = from ? nodeDef(catalog, from.type) : undefined;
      const fromBranches = from ? branchesOf(fromDef, from) : [];
      update((d) => {
        const node: WorkflowNode = { id: nid, type, name: nd.name, config: defaults(nd), position: pos, onError: "fail", disabled: false };
        const edges = [...d.edges];
        // Auto-connect when added from a selected node with a single output.
        if (from && !position && fromBranches.length === 0) edges.push({ id: `e_${Math.random().toString(36).slice(2, 9)}`, source: from.id, target: nid, branch: null });
        return { ...d, nodes: [...d.nodes, node], edges };
      });
      setSelected(nid);
    },
    [def, catalog, selected, update],
  );

  const duplicateNode = useCallback(
    (nodeId: string) => {
      if (!def) return;
      const n = def.nodes.find((x) => x.id === nodeId);
      if (!n || n.type.startsWith("trigger.")) return;
      const nid = newNodeId(def, n.type);
      update((d) => ({ ...d, nodes: [...d.nodes, { ...structuredClone(n), id: nid, name: `${n.name} (copy)`, position: { x: (n.position?.x ?? 0) + 260, y: n.position?.y ?? 0 } }] }));
      setSelected(nid);
    },
    [def, update],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (!def) return false;
    setSaving(true);
    try {
      const res = await put<{ workflow: WorkflowResponse; validation: ValidationState }>(`/api/workflows/${id}`, { name, definition: def });
      setWf((w) => (w ? { ...w, ...res.workflow, webhookUrl: w.webhookUrl } : w));
      setValidation(res.validation);
      setDirty(false);
      return true;
    } catch (err) {
      toast(errorMessage(err), "error");
      return false;
    } finally {
      setSaving(false);
    }
  }, [def, id, name, toast]);

  // Keyboard shortcuts: Ctrl/Cmd+S save, Delete removes selection, Ctrl/Cmd+D duplicates.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (editable) void save();
      } else if (!typing && (e.key === "Delete" || e.key === "Backspace") && editable) {
        if (selected && !def?.nodes.find((n) => n.id === selected)?.type.startsWith("trigger.")) removeNodes([selected]);
        else if (selectedEdge) update((d) => ({ ...d, edges: d.edges.filter((x) => x.id !== selectedEdge) }));
      } else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && selected && editable) {
        e.preventDefault();
        duplicateNode(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, selected, selectedEdge, def, removeNodes, duplicateNode, update, editable]);

  const pollExecution = useCallback(
    async (executionId: string) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const e = await get<{ status: string; error?: unknown; steps: Array<{ node_id: string; status: string }> }>(`/api/executions/${executionId}`);
        setStatuses(Object.fromEntries(e.steps.map((s) => [s.node_id, s.status])));
        setLastRun({ id: executionId, status: e.status, error: e.error });
        if (["succeeded", "failed", "cancelled", "waiting"].includes(e.status)) {
          setSamples(await get<Samples>(`/api/workflows/${id}/sample-data`));
          return;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    },
    [id],
  );

  const runTest = async (payload: unknown, useMocks: boolean) => {
    if (dirty && !(await save())) return;
    try {
      setStatuses({});
      const r = await post<{ executionId: string }>(`/api/workflows/${id}/run`, { mode: "test", payload, useMocks });
      setModal(null);
      toast("Test run started");
      await pollExecution(r.executionId);
    } catch (err) {
      toast(errorMessage(err), "error");
      if (err instanceof ApiError && (err.details as ValidationState)?.errors) setValidation(err.details as ValidationState);
    }
  };

  const publish = async (note: string) => {
    if (dirty && !(await save())) return;
    try {
      const r = await post<{ version: number; warnings: ValidationIssue[] }>(`/api/workflows/${id}/publish`, { note });
      toast(`Published version ${r.version}${r.warnings.length ? ` (${r.warnings.length} warnings)` : ""}`);
      setModal(null);
      await load();
    } catch (err) {
      toast(errorMessage(err), "error");
      if (err instanceof ApiError && (err.details as ValidationState)?.errors) setValidation(err.details as ValidationState);
    }
  };

  const setStatus = async (action: "pause" | "resume") => {
    try {
      await post(`/api/workflows/${id}/${action}`);
      toast(action === "pause" ? "Workflow paused" : "Workflow resumed");
      await load();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("application/x-node-type");
    if (!type) return;
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNode(type, { x: Math.round(pos.x), y: Math.round(pos.y) });
  };

  if (loadError) {
    return (
      <div className="page">
        <ErrorBox error={loadError} onRetry={load} />
      </div>
    );
  }
  if (!wf || !def || !catalog) return <Loading />;
  const selectedNode = def.nodes.find((n) => n.id === selected) ?? null;

  return (
    <div className="editor">
      <div className="editor-bar">
        <Link to="/workflows" title="Back to workflows">
          <ArrowLeft size={18} />
        </Link>
        <input
          className="name"
          value={name}
          aria-label="Workflow name"
          disabled={!editable}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
        />
        <StatusBadge status={wf.status} />
        {wf.activeVersion ? <span className="badge">v{wf.activeVersion} live</span> : <span className="badge">not published</span>}
        {dirty && <span className="faint">Unsaved changes</span>}
        <span className="spacer" />
        <button className={`btn btn-sm ${validation.errors.length ? "btn-danger" : ""}`} onClick={() => setShowIssues(!showIssues)} title="Validation">
          <AlertTriangle size={14} /> {validation.errors.length} errors · {validation.warnings.length} warnings
        </button>
        {editable && (
          <>
            <Button size="sm" onClick={() => void save()} loading={saving} disabled={!dirty} title="Save draft (Ctrl+S)">
              <Save size={14} /> Save
            </Button>
            <Button size="sm" onClick={() => setModal("run")}>
              <FlaskConical size={14} /> Test
            </Button>
            {wf.status === "active" && (
              <Button size="sm" onClick={() => setStatus("pause")}>
                <Pause size={14} /> Pause
              </Button>
            )}
            {wf.status === "paused" && wf.activeVersion && (
              <Button size="sm" onClick={() => setStatus("resume")}>
                <Play size={14} /> Resume
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => setModal("publish")} disabled={validation.errors.length > 0} title={validation.errors.length ? "Fix validation errors first" : "Publish a new version"}>
              <Rocket size={14} /> Publish
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={() => setModal("versions")} title="Versions">
          <History size={14} />
        </Button>
        <a className="btn btn-sm btn-ghost" href={`/api/workflows/${id}/export`} title="Export JSON" aria-label="Export JSON">
          <Download size={14} />
        </a>
        {editable && (
          <Button size="sm" variant="ghost" onClick={() => setModal("import")} title="Import JSON into this draft">
            <Upload size={14} />
          </Button>
        )}
      </div>
      <div className="editor-body">
        <Palette onAdd={(t) => addNode(t)} disabled={!editable} />
        <div className="canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <ReactFlow
            nodes={rfNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onPaneClick={() => {
              setSelected(null);
              setSelectedEdge(null);
            }}
            deleteKeyCode={null}
            nodesDraggable={editable}
            nodesConnectable={editable}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeStrokeWidth={2} />
          </ReactFlow>
          {lastRun && (
            <div className="card card-pad" style={{ position: "absolute", top: 12, right: 12, zIndex: 5, maxWidth: 340 }}>
              <div className="row">
                <strong>Test run</strong>
                <StatusBadge status={lastRun.status} />
                <span className="spacer" />
                <button className="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss" onClick={() => setLastRun(null)}>
                  <X size={14} />
                </button>
              </div>
              {lastRun.error ? <div className="small" style={{ color: "var(--danger)", marginTop: 6 }}>{String((lastRun.error as { message?: string }).message ?? "")}</div> : null}
              <div style={{ marginTop: 6 }}>
                <Link to={`/executions/${lastRun.id}`}>Open execution details →</Link>
              </div>
            </div>
          )}
          {showIssues && (validation.errors.length > 0 || validation.warnings.length > 0) && (
            <div className="card issues" role="region" aria-label="Validation issues">
              {[...validation.errors.map((i) => ({ ...i, sev: "error" })), ...validation.warnings.map((i) => ({ ...i, sev: "warning" }))].map((i, k) => (
                <div key={k} className="issue" onClick={() => i.nodeId && setSelected(i.nodeId)}>
                  <span className={`badge ${i.sev === "error" ? "red" : "amber"}`}>{i.sev}</span>
                  <span>{i.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <aside className="inspector" aria-label="Inspector">
          {selectedNode ? (
            <NodeInspector
              key={selectedNode.id}
              workflowId={id}
              def={def}
              node={selectedNode}
              nodeType={nodeDef(catalog, selectedNode.type)}
              issues={[...validation.errors, ...validation.warnings].filter((i) => i.nodeId === selectedNode.id)}
              samples={samples}
              editable={editable}
              dirty={dirty}
              save={save}
              onChange={(patch) => update((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === selectedNode.id ? { ...n, ...patch } : n)) }))}
              onDelete={() => removeNodes([selectedNode.id])}
              onDuplicate={() => duplicateNode(selectedNode.id)}
              inserter={inserter}
              onTested={(status) => setStatuses((s) => ({ ...s, [selectedNode.id]: status }))}
              refreshSamples={async () => setSamples(await get<Samples>(`/api/workflows/${id}/sample-data`))}
            />
          ) : (
            <WorkflowPanel wf={wf} def={def} editable={editable} onChange={(patch) => update((d) => ({ ...d, settings: { ...d.settings, ...patch } }))} />
          )}
        </aside>
      </div>
      {modal === "run" && <RunModal def={def} samples={samples} onClose={() => setModal(null)} onRun={runTest} />}
      {modal === "publish" && <PublishModal warnings={validation.warnings} onClose={() => setModal(null)} onPublish={publish} />}
      {modal === "versions" && (
        <VersionsModal
          workflowId={id}
          onClose={() => setModal(null)}
          onRestored={async () => {
            setModal(null);
            await load();
          }}
        />
      )}
      {modal === "import" && (
        <ImportModal
          onClose={() => setModal(null)}
          onImport={(imported) => {
            update(() => ({ ...imported, nodes: imported.nodes.map((n) => ({ ...n, credentialId: null })) }));
            setModal(null);
            toast("Imported into the draft — review and save.");
          }}
        />
      )}
    </div>
  );
}

function defaults(nd: NodeTypeDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of nd.fields) if (f.default !== undefined) out[f.key] = structuredClone(f.default);
  return out;
}

// ---------------------------------------------------------------------------
// Palette

function Palette({ onAdd, disabled }: { onAdd: (type: string) => void; disabled: boolean }) {
  const { catalog } = useSession();
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const nodes = (catalog?.nodes ?? []).filter((n) => !q || `${n.name} ${n.description} ${n.type}`.toLowerCase().includes(q.toLowerCase()));
    const order = ["trigger", "logic", "ai", "data", "action"];
    const labels: Record<string, string> = { trigger: "Triggers", logic: "Logic & flow", ai: "AI", data: "Data", action: "Actions" };
    return order.map((k) => ({ key: k, label: labels[k]!, nodes: nodes.filter((n) => n.kind === k) })).filter((g) => g.nodes.length);
  }, [catalog, q]);
  return (
    <aside className="palette" aria-label="Add steps">
      <div className="search">
        <Search size={15} />
        <input className="input" placeholder="Search apps & actions" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search apps and actions" />
      </div>
      {disabled && <div className="faint" style={{ marginTop: 8 }}>Read-only: your role cannot edit workflows.</div>}
      {groups.map((g) => (
        <div className="palette-group" key={g.key}>
          <h4>{g.label}</h4>
          {g.nodes.map((n) => (
            <button
              key={n.type}
              className="palette-item"
              draggable={!disabled}
              disabled={disabled}
              onDragStart={(e) => e.dataTransfer.setData("application/x-node-type", n.type)}
              onClick={() => onAdd(n.type)}
              title={`${n.description}\n(click to add, or drag onto the canvas)`}
            >
              <span className={`node-icon k-${n.kind}`}>{iconFor(n.type, 14)}</span>
              <span>
                <div className="nm">
                  {n.name} {n.mode === "mock" && <span className="badge violet">mock</span>}
                </div>
                <div className="ds">{n.description.slice(0, 90)}</div>
              </span>
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Inspector

function flatten(value: unknown, prefix: string, out: Array<{ path: string; preview: string }>, depth = 0) {
  if (out.length > 300 || depth > 5) return;
  if (Array.isArray(value)) {
    out.push({ path: prefix, preview: `list (${value.length})` });
    if (value.length) flatten(value[0], `${prefix}[0]`, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    if (prefix) out.push({ path: prefix, preview: "object" });
    for (const [k, v] of Object.entries(value)) {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? (prefix ? `${prefix}.${k}` : k) : `${prefix}["${k}"]`;
      flatten(v, key, out, depth + 1);
    }
    return;
  }
  out.push({ path: prefix, preview: value === null || value === undefined ? "null" : String(value).slice(0, 60) });
}

function MappingPicker({ def, nodeId, samples, onInsert }: { def: WorkflowDefinition; nodeId: string; samples: Samples; onInsert: (expr: string) => void }) {
  const ids = ancestors(def, nodeId);
  if (!ids.length) return <div className="faint">Connect this step to earlier steps to map their data.</div>;
  return (
    <div className="mapping" role="listbox" aria-label="Data from previous steps">
      {ids.map((aid) => {
        const n = def.nodes.find((x) => x.id === aid)!;
        const isTrigger = n.type.startsWith("trigger.");
        const s = samples[aid];
        const rows: Array<{ path: string; preview: string }> = [];
        flatten(s?.output ?? {}, "", rows);
        const root = isTrigger ? "trigger" : `steps.${aid}.output`;
        return (
          <div key={aid}>
            <div className="mp-node">
              {n.name} <span className="faint">({s?.source === "execution" ? "last run" : "sample"})</span>
            </div>
            <div className="mp-row" onClick={() => onInsert(`{{ ${root} }}`)} role="option" aria-selected={false}>
              <span className="mp-key">{root}</span>
              <span className="mp-val">entire output</span>
            </div>
            {rows
              .filter((r) => r.path)
              .map((r) => (
                <div key={r.path} className="mp-row" role="option" aria-selected={false} onClick={() => onInsert(`{{ ${root}${r.path.startsWith("[") ? "" : "."}${r.path} }}`)}>
                  <span className="mp-key">{r.path}</span>
                  <span className="mp-val">{r.preview}</span>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

function NodeInspector(props: {
  workflowId: string;
  def: WorkflowDefinition;
  node: WorkflowNode;
  nodeType?: NodeTypeDefinition;
  issues: ValidationIssue[];
  samples: Samples;
  editable: boolean;
  dirty: boolean;
  save: () => Promise<boolean>;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  inserter: React.MutableRefObject<Inserter | null>;
  onTested: (status: string) => void;
  refreshSamples: () => Promise<void>;
}) {
  const { node, nodeType: nd, onChange, editable } = props;
  const [tab, setTab] = useState<"config" | "settings" | "output">("config");
  const [creds, setCreds] = useState<Array<{ id: string; name: string }>>([]);
  const [test, setTest] = useState<{ status?: string; output?: unknown; error?: unknown; logs?: unknown; busy?: boolean; useMocks: boolean }>({ useMocks: true });
  const toast = useToast();
  useEffect(() => {
    if (nd?.credentialType) void get<Array<{ id: string; name: string }>>(`/api/credentials?type=${nd.credentialType}`).then(setCreds).catch(() => setCreds([]));
  }, [nd?.credentialType]);

  if (!nd) return <div className="inspector-body"><div className="alert error">Unknown node type {node.type}</div></div>;
  const isTrigger = nd.kind === "trigger";
  const setConfig = (key: string, value: unknown) => onChange({ config: { ...node.config, [key]: value } });
  const visible = (f: FieldSpec) => !f.showWhen || f.showWhen.equals.includes(node.config[f.showWhen.key] ?? nd.fields.find((x) => x.key === f.showWhen!.key)?.default);
  const fieldError = (key: string) => props.issues.find((i) => i.field === key && i.code !== "unknown_field")?.message;

  const runNodeTest = async () => {
    if (props.dirty && !(await props.save())) return;
    setTest((t) => ({ ...t, busy: true }));
    try {
      const r = await post<{ status: string; output: unknown; error: unknown; logs: unknown }>(`/api/workflows/${props.workflowId}/nodes/${node.id}/test`, { useMocks: test.useMocks });
      setTest((t) => ({ ...t, ...r, busy: false }));
      props.onTested(r.status);
      setTab("output");
      await props.refreshSamples();
    } catch (err) {
      setTest((t) => ({ ...t, busy: false }));
      toast(errorMessage(err), "error");
    }
  };

  return (
    <>
      <div className="inspector-head">
        <span className={`node-icon k-${nd.kind}`}>{iconFor(node.type)}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <input className="input" value={node.name} disabled={!editable} onChange={(e) => onChange({ name: e.target.value })} aria-label="Step name" />
          <div className="faint truncate" style={{ marginTop: 4 }}>
            {nd.name} · <code>{node.id}</code> {nd.mode === "mock" && <span className="badge violet">mock</span>}
          </div>
        </div>
      </div>
      <div style={{ padding: "0 16px" }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {(["config", "settings", "output"] as const).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "config" ? "Configure" : t === "settings" ? "Settings" : "Test & output"}
            </button>
          ))}
        </div>
      </div>
      <div className="inspector-body">
        {tab === "config" && (
          <>
            <div className="faint">{nd.description}</div>
            {nd.credentialType && (
              <div className="field">
                <label>
                  Connection {nd.credentialRequired && <span style={{ color: "var(--danger)" }}>*</span>}
                </label>
                <select className="input" value={node.credentialId ?? ""} disabled={!editable} onChange={(e) => onChange({ credentialId: e.target.value || null })} aria-label="Connection">
                  <option value="">{nd.credentialRequired ? "Select a connection…" : nd.integration === "ai" ? "None — use mock test adapter" : nd.integration === "email" ? "None — local outbox (not delivered)" : "None"}</option>
                  {creds.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="help">
                  <Link to="/connections">Manage connections</Link>
                </div>
              </div>
            )}
            {nd.fields.filter(visible).map((f) => (
              <FieldInput
                key={f.key}
                field={f}
                value={node.config[f.key]}
                error={fieldError(f.key)}
                onChange={(v) => editable && setConfig(f.key, v)}
                onFocusInsert={(fn) => {
                  props.inserter.current = fn;
                }}
              />
            ))}
            {props.issues
              .filter((i) => !i.field || !nd.fields.some((f) => f.key === i.field))
              .map((i, k) => (
                <div key={k} className={`alert ${i.code === "unreachable" || i.code === "unknown_field" || i.code === "mock_ai" ? "warn" : "error"}`}>
                  {i.message}
                </div>
              ))}
            {!isTrigger && (
              <div className="field">
                <label>Insert data from previous steps</label>
                <MappingPicker
                  def={props.def}
                  nodeId={node.id}
                  samples={props.samples}
                  onInsert={(expr) => {
                    if (props.inserter.current) props.inserter.current(expr);
                    else void navigator.clipboard?.writeText(expr).then(() => toast("Copied — click into a field first to insert directly."));
                  }}
                />
                <div className="help">Click a field, then click a value to insert it. Expressions support functions like lower(), default(), join() and conditions with ? :.</div>
              </div>
            )}
          </>
        )}
        {tab === "settings" && (
          <>
            {!isTrigger && (
              <>
                <div className="field">
                  <label>On error</label>
                  <select className="input" value={node.onError} disabled={!editable} onChange={(e) => onChange({ onError: e.target.value as "fail" | "continue" })}>
                    <option value="fail">Stop the workflow</option>
                    <option value="continue">Continue (downstream steps can read the error)</option>
                  </select>
                </div>
                <div className="grid grid-2" style={{ gap: 8 }}>
                  <div className="field">
                    <label>Max attempts</label>
                    <input className="input" type="number" min={1} max={10} disabled={!editable} value={node.retry?.maxAttempts ?? 1} onChange={(e) => onChange({ retry: { maxAttempts: Number(e.target.value) || 1, backoffMs: node.retry?.backoffMs ?? 2000, backoffMultiplier: node.retry?.backoffMultiplier ?? 2 } })} />
                  </div>
                  <div className="field">
                    <label>Backoff (ms)</label>
                    <input className="input" type="number" min={0} disabled={!editable} value={node.retry?.backoffMs ?? 2000} onChange={(e) => onChange({ retry: { maxAttempts: node.retry?.maxAttempts ?? 1, backoffMs: Number(e.target.value) || 0, backoffMultiplier: node.retry?.backoffMultiplier ?? 2 } })} />
                  </div>
                </div>
                <div className="help">Only transient errors (timeouts, rate limits, 5xx) are retried. Retries can repeat side effects if the provider has no idempotency support.</div>
                <div className="field">
                  <label>Step timeout (ms)</label>
                  <input className="input" type="number" min={100} disabled={!editable} value={node.timeoutMs ?? ""} placeholder="default" onChange={(e) => onChange({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
                <label className="checkbox">
                  <input type="checkbox" checked={node.disabled} disabled={!editable} onChange={(e) => onChange({ disabled: e.target.checked })} /> Disabled (skipped, and steps after it are skipped)
                </label>
              </>
            )}
            <div className="field">
              <label>Notes</label>
              <textarea className="input" disabled={!editable} value={node.notes ?? ""} onChange={(e) => onChange({ notes: e.target.value })} />
            </div>
            {editable && (
              <div className="row">
                {!isTrigger && (
                  <Button size="sm" onClick={props.onDuplicate}>
                    <Copy size={14} /> Duplicate
                  </Button>
                )}
                {!isTrigger && (
                  <Button size="sm" variant="danger" onClick={props.onDelete}>
                    <Trash2 size={14} /> Delete step
                  </Button>
                )}
              </div>
            )}
          </>
        )}
        {tab === "output" && (
          <>
            {!isTrigger && editable && (
              <div className="card card-pad stack" style={{ gap: 8 }}>
                <div className="row">
                  <Button size="sm" variant="primary" loading={test.busy} onClick={runNodeTest}>
                    <FlaskConical size={14} /> Test this step
                  </Button>
                  <label className="checkbox small">
                    <input type="checkbox" checked={test.useMocks} onChange={(e) => setTest((t) => ({ ...t, useMocks: e.target.checked }))} /> Simulate external actions
                  </label>
                </div>
                <div className="faint">Uses the latest outputs (or samples) of previous steps as input.</div>
              </div>
            )}
            {test.status && (
              <div className="stack">
                <div className="row">
                  Result: <StatusBadge status={test.status} />
                </div>
                {test.error ? <JsonView value={test.error} /> : null}
                {test.output !== undefined && test.output !== null ? (
                  <>
                    <div className="label">Output</div>
                    <JsonView value={test.output} />
                  </>
                ) : null}
              </div>
            )}
            <div className="label">{props.samples[node.id]?.source === "execution" ? "Latest output" : "Sample output"}</div>
            <JsonView value={props.samples[node.id]?.output ?? nd.sampleOutput ?? null} />
          </>
        )}
      </div>
    </>
  );
}

function WorkflowPanel({ wf, def, editable, onChange }: { wf: WorkflowResponse; def: WorkflowDefinition; editable: boolean; onChange: (patch: Partial<WorkflowDefinition["settings"]>) => void }) {
  return (
    <div className="inspector-body">
      <h3>Workflow</h3>
      <div className="faint">Select a step to configure it. Drag apps from the left onto the canvas, or click them to add after the selected step. Connect steps by dragging from a handle.</div>
      {wf.webhookUrl && (
        <div className="field">
          <label>Webhook URL</label>
          <input className="input mono" readOnly value={wf.webhookUrl} onFocus={(e) => e.target.select()} />
          <div className="help">Live after publishing. Keep this URL secret, and enable request verification for production.</div>
        </div>
      )}
      {wf.schedule && (
        <div className="small">
          Schedule <code>{wf.schedule.cron}</code> ({wf.schedule.timezone}) · next run {formatDate(wf.schedule.next_run_at)}
        </div>
      )}
      {wf.pollState?.last_error && <div className="alert warn">Last poll failed: {wf.pollState.last_error}</div>}
      <div className="field">
        <label>Workflow timeout (seconds)</label>
        <input className="input" type="number" min={1} disabled={!editable} value={Math.round(def.settings.timeoutMs / 1000)} onChange={(e) => onChange({ timeoutMs: Math.max(1, Number(e.target.value) || 300) * 1000 })} />
      </div>
      <div className="field">
        <label>Duplicate-event window (seconds)</label>
        <input className="input" type="number" min={0} disabled={!editable} value={def.settings.dedupeWindowSeconds} onChange={(e) => onChange({ dedupeWindowSeconds: Math.max(0, Number(e.target.value) || 0) })} />
        <div className="help">Events with the same deduplication key inside this window start only one execution.</div>
      </div>
      <div className="field">
        <label>Max step executions per run</label>
        <input className="input" type="number" min={1} disabled={!editable} value={def.settings.maxStepExecutions} onChange={(e) => onChange({ maxStepExecutions: Math.max(1, Number(e.target.value) || 1000) })} />
      </div>
      <div className="faint">
        Draft saved {formatDate(wf.draft_updated_at)} · {def.nodes.length} steps
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modals

function RunModal({ def, samples, onClose, onRun }: { def: WorkflowDefinition; samples: Samples; onClose: () => void; onRun: (payload: unknown, useMocks: boolean) => Promise<void> }) {
  const trigger = def.nodes.find((n) => n.type.startsWith("trigger."));
  const [text, setText] = useState(() => JSON.stringify(trigger?.config.samplePayload ?? samples[trigger?.id ?? ""]?.output ?? {}, null, 2));
  const [useMocks, setUseMocks] = useState(true);
  const [busy, setBusy] = useState(false);
  let parseError: string | null = null;
  try {
    JSON.parse(text);
  } catch {
    parseError = "Invalid JSON";
  }
  return (
    <Modal
      title="Test run"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!!parseError}
            onClick={async () => {
              setBusy(true);
              await onRun(JSON.parse(text), useMocks);
              setBusy(false);
            }}
          >
            <Play size={14} /> Run draft
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Trigger data</label>
        <textarea className="input mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
        {parseError && <div className="help" style={{ color: "var(--danger)" }}>{parseError}</div>}
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={useMocks} onChange={(e) => setUseMocks(e.target.checked)} /> Simulate external actions (emails, messages, CRM writes, approvals, delays)
      </label>
      <div className="faint">Test runs execute the current draft. Uncheck simulation to perform real actions with your connections.</div>
    </Modal>
  );
}

function PublishModal({ warnings, onClose, onPublish }: { warnings: ValidationIssue[]; onClose: () => void; onPublish: (note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Publish new version"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await onPublish(note);
              setBusy(false);
            }}
          >
            <Rocket size={14} /> Publish & activate
          </Button>
        </>
      }
    >
      <div className="muted">Publishing snapshots the draft as an immutable version and activates its trigger. Running executions keep using the version they started with.</div>
      <div className="field">
        <label>Version note (optional)</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed?" />
      </div>
      {warnings.map((w, i) => (
        <div key={i} className="alert warn">
          {w.message}
        </div>
      ))}
    </Modal>
  );
}

function VersionsModal({ workflowId, onClose, onRestored }: { workflowId: string; onClose: () => void; onRestored: () => void }) {
  const [versions, setVersions] = useState<Array<{ id: string; version: number; note: string; created_at: string; created_by_name: string | null }> | null>(null);
  const toast = useToast();
  useEffect(() => {
    void get(`/api/workflows/${workflowId}/versions`).then(setVersions);
  }, [workflowId]);
  return (
    <Modal title="Versions" onClose={onClose} wide>
      {!versions ? (
        <Loading />
      ) : versions.length === 0 ? (
        <div className="muted">No published versions yet.</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Version</th>
              <th>Note</th>
              <th>Published</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td>v{v.version}</td>
                <td>{v.note || <span className="faint">—</span>}</td>
                <td>
                  {formatDate(v.created_at)} {v.created_by_name && <span className="faint">by {v.created_by_name}</span>}
                </td>
                <td style={{ textAlign: "right" }}>
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        await post(`/api/workflows/${workflowId}/versions/${v.id}/restore`);
                        toast(`Draft restored from v${v.version}`);
                        onRestored();
                      } catch (err) {
                        toast(errorMessage(err), "error");
                      }
                    }}
                  >
                    Restore to draft
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function ImportModal({ onClose, onImport }: { onClose: () => void; onImport: (def: WorkflowDefinition) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title="Import workflow JSON into this draft"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const parsed = JSON.parse(text);
                const definition = parsed.format === "automation-studio.workflow" ? parsed.definition : parsed;
                const res = await post<{ errors: ValidationIssue[] }>("/api/validate", { definition });
                if (res.errors.some((e) => e.code === "schema")) throw new Error(res.errors.map((e) => e.message).join("; "));
                onImport(definition);
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            Replace draft
          </Button>
        </>
      }
    >
      <div className="muted">Paste an exported workflow (or a bare definition). Connections are not imported and must be re-selected.</div>
      <textarea className="input mono" rows={12} value={text} onChange={(e) => setText(e.target.value)} />
      {error && <ErrorBox error={new Error(error)} />}
    </Modal>
  );
}
