import type { WorkflowDefinition, WorkflowNode } from "./schema.ts";

/**
 * Layered top-to-bottom layout: rank = longest path from the trigger, nodes
 * within a rank ordered by their parents' positions (branch order for
 * branching parents), each rank centred. Execution never depends on layout.
 */
export function autoLayout(def: WorkflowDefinition, branchesFor: (n: WorkflowNode) => string[]): WorkflowDefinition {
  const X_GAP = 270;
  const Y_GAP = 140;
  const index = new Map(def.nodes.map((n, i) => [n.id, i]));
  const incoming = new Map<string, typeof def.edges>(def.nodes.map((n) => [n.id, []]));
  const outgoing = new Map<string, typeof def.edges>(def.nodes.map((n) => [n.id, []]));
  for (const e of def.edges) {
    incoming.get(e.target)?.push(e);
    outgoing.get(e.source)?.push(e);
  }
  // Longest-path ranks via Kahn's algorithm (definitions are acyclic once valid; leftovers get rank 0).
  const rank = new Map<string, number>(def.nodes.map((n) => [n.id, 0]));
  const indeg = new Map(def.nodes.map((n) => [n.id, incoming.get(n.id)!.length]));
  const queue = def.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of outgoing.get(id) ?? []) {
      if (!rank.has(e.target)) continue;
      rank.set(e.target, Math.max(rank.get(e.target)!, rank.get(id)! + 1));
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (indeg.get(e.target) === 0) queue.push(e.target);
    }
  }
  const layers: string[][] = [];
  for (const n of def.nodes) (layers[rank.get(n.id)!] ??= []).push(n.id);
  const x = new Map<string, number>();
  for (const layer of layers) {
    if (!layer) continue;
    const key = (id: string) => {
      const parents = incoming.get(id)!;
      if (!parents.length) return index.get(id)!;
      return (
        parents.reduce((sum, e) => {
          const src = def.nodes.find((n) => n.id === e.source)!;
          const branches = branchesFor(src);
          const offset = e.branch && branches.length ? (branches.indexOf(e.branch) - (branches.length - 1) / 2) * 0.5 : 0;
          return sum + (x.get(e.source) ?? 0) + offset;
        }, 0) / parents.length
      );
    };
    layer.sort((a, b) => key(a) - key(b) || index.get(a)! - index.get(b)!);
    layer.forEach((id, i) => x.set(id, i - (layer.length - 1) / 2));
  }
  return {
    ...def,
    nodes: def.nodes.map((n) => ({ ...n, position: { x: Math.round(300 + x.get(n.id)! * X_GAP), y: 40 + rank.get(n.id)! * Y_GAP } })),
  };
}
