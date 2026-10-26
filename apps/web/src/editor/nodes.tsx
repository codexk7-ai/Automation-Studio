import type { NodeTypeDefinition, WorkflowDefinition, WorkflowNode } from "@automation-studio/core";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Bot, Braces, CheckCircle2, Clock, Database, GitBranch, Globe, Loader2, Mail, MessageCircle, MinusCircle, Play, Plug, Sheet, Sparkles, Table, Timer, Users, Webhook, XCircle, Video, Zap, Hash, FileSpreadsheet, Filter, Repeat, ShieldCheck, Hand } from "lucide-react";
import type { ReactNode } from "react";

export interface FlowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  def?: NodeTypeDefinition;
  status?: string;
  hasError?: boolean;
  branches: string[];
}

export function iconFor(type: string, size = 15): ReactNode {
  const map: Array<[RegExp, ReactNode]> = [
    [/^trigger\.webhook/, <Webhook size={size} />],
    [/^trigger\.schedule/, <Clock size={size} />],
    [/^trigger\.manual/, <Play size={size} />],
    [/^trigger\.(table|form)/, <Table size={size} />],
    [/^trigger\.execution_failed/, <XCircle size={size} />],
    [/whatsapp/, <MessageCircle size={size} />],
    [/youtube/, <Video size={size} />],
    [/^trigger\./, <Zap size={size} />],
    [/^logic\.condition|^logic\.switch/, <GitBranch size={size} />],
    [/^logic\.filter/, <Filter size={size} />],
    [/^logic\.delay/, <Timer size={size} />],
    [/^logic\.loop|call_workflow/, <Repeat size={size} />],
    [/^human\./, <Hand size={size} />],
    [/^flow\./, <ShieldCheck size={size} />],
    [/^ai\.agent/, <Bot size={size} />],
    [/^ai\./, <Sparkles size={size} />],
    [/^mcp\./, <Plug size={size} />],
    [/^http\./, <Globe size={size} />],
    [/^email\./, <Mail size={size} />],
    [/^sheets\./, <Sheet size={size} />],
    [/^hubspot\./, <Users size={size} />],
    [/^slack\./, <Hash size={size} />],
    [/^postgres\./, <Database size={size} />],
    [/^tables\./, <Table size={size} />],
    [/^csv\./, <FileSpreadsheet size={size} />],
  ];
  return map.find(([re]) => re.test(type))?.[1] ?? <Braces size={size} />;
}

function StatusIcon({ status }: { status?: string }) {
  if (!status) return null;
  const s = 15;
  const icon =
    status === "succeeded" ? <CheckCircle2 size={s} /> : status === "failed" ? <XCircle size={s} /> : status === "running" || status === "queued" ? <Loader2 size={s} className="spin" /> : status === "waiting" ? <Clock size={s} /> : <MinusCircle size={s} />;
  return (
    <span className={`status st-${status}`} title={status}>
      {icon}
    </span>
  );
}

export function WorkflowNodeView({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const kind = d.def?.kind ?? "action";
  const isTrigger = kind === "trigger";
  return (
    <div className={`flow-node ${selected ? "selected" : ""} ${d.hasError ? "has-error" : ""} ${d.node.disabled ? "disabled" : ""}`}>
      {!isTrigger && <Handle type="target" position={Position.Top} />}
      <div className="hd">
        <span className={`node-icon k-${kind}`}>{iconFor(d.node.type)}</span>
        <div style={{ minWidth: 0 }}>
          <div className="tt truncate">{d.node.name}</div>
          <div className="sub truncate">{d.def?.name ?? d.node.type}</div>
        </div>
        <StatusIcon status={d.status} />
      </div>
      {d.branches.length > 0 ? (
        <>
          <div className="branches">
            {d.branches.map((b) => (
              <span key={b}>{b}</span>
            ))}
          </div>
          {d.branches.map((b, i) => (
            <Handle key={b} id={b} type="source" position={Position.Bottom} style={{ left: `${((i + 0.5) / d.branches.length) * 100}%` }} />
          ))}
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  );
}

export const nodeTypes = { wf: WorkflowNodeView };

export function branchesOf(def: NodeTypeDefinition | undefined, node: WorkflowNode): string[] {
  if (!def) return [];
  if (def.dynamicBranches) {
    const cases = Array.isArray(node.config.cases) ? (node.config.cases as Array<{ branch?: string }>) : [];
    return [...cases.map((c) => String(c.branch ?? "")).filter(Boolean), "default"];
  }
  return def.branches ?? [];
}

/** All transitive predecessors (for data mapping). */
export function ancestors(def: WorkflowDefinition, nodeId: string): string[] {
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of def.edges) {
      if (e.target === cur && !seen.has(e.source)) {
        seen.add(e.source);
        stack.push(e.source);
      }
    }
  }
  const order = def.nodes.map((n) => n.id);
  return [...seen].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export function newNodeId(def: WorkflowDefinition, type: string): string {
  const base = type.split(".").pop()!.replace(/[^a-zA-Z0-9]/g, "_").replace(/^[^a-zA-Z]+/, "") || "step";
  const ids = new Set(def.nodes.map((n) => n.id));
  if (!ids.has(base)) return base;
  for (let i = 2; ; i++) if (!ids.has(`${base}${i}`)) return `${base}${i}`;
}

export { autoLayout } from "@automation-studio/core";
