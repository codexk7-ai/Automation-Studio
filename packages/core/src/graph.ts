import type { WorkflowDefinition, WorkflowEdge } from "./schema.ts";

export interface WorkflowGraph {
  nodeIds: string[];
  incoming: Map<string, WorkflowEdge[]>;
  outgoing: Map<string, WorkflowEdge[]>;
}

export function buildGraph(def: Pick<WorkflowDefinition, "nodes" | "edges">): WorkflowGraph {
  const nodeIds = def.nodes.map((n) => n.id);
  const incoming = new Map<string, WorkflowEdge[]>(nodeIds.map((id) => [id, []]));
  const outgoing = new Map<string, WorkflowEdge[]>(nodeIds.map((id) => [id, []]));
  for (const e of def.edges) {
    incoming.get(e.target)?.push(e);
    outgoing.get(e.source)?.push(e);
  }
  return { nodeIds, incoming, outgoing };
}

/**
 * Kahn topological sort. Returns the order, or the set of nodes involved in a
 * cycle when the graph is not a DAG. Ties are broken by definition order so
 * the plan is deterministic.
 */
export function topologicalOrder(def: Pick<WorkflowDefinition, "nodes" | "edges">): { order: string[]; cyclic: string[] } {
  const g = buildGraph(def);
  const indegree = new Map<string, number>(g.nodeIds.map((id) => [id, 0]));
  for (const e of def.edges) {
    if (indegree.has(e.target) && indegree.has(e.source)) indegree.set(e.target, indegree.get(e.target)! + 1);
  }
  const position = new Map(g.nodeIds.map((id, i) => [id, i]));
  const ready = g.nodeIds.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const id = ready.shift()!;
    order.push(id);
    for (const e of g.outgoing.get(id) ?? []) {
      if (!indegree.has(e.target)) continue;
      const d = indegree.get(e.target)! - 1;
      indegree.set(e.target, d);
      if (d === 0) ready.push(e.target);
    }
  }
  const cyclic = g.nodeIds.filter((id) => !order.includes(id));
  return { order, cyclic };
}

/** All transitive predecessors of a node. */
export function ancestorsOf(def: Pick<WorkflowDefinition, "nodes" | "edges">, nodeId: string): Set<string> {
  const g = buildGraph(def);
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of g.incoming.get(cur) ?? []) {
      if (!seen.has(e.source)) {
        seen.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return seen;
}

/** All transitive successors of a node. */
export function descendantsOf(def: Pick<WorkflowDefinition, "nodes" | "edges">, nodeId: string): Set<string> {
  const g = buildGraph(def);
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of g.outgoing.get(cur) ?? []) {
      if (!seen.has(e.target)) {
        seen.add(e.target);
        stack.push(e.target);
      }
    }
  }
  return seen;
}
