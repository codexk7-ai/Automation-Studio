import { CONDITION_OPERATOR_VALUES } from "./conditions.ts";
import type { FieldSpec, NodeTypeDefinition, Role } from "./definitions.ts";
import { roleAtLeast } from "./definitions.ts";
import { analyzeTemplates, hasExpression } from "./expression.ts";
import { ancestorsOf, descendantsOf, topologicalOrder } from "./graph.ts";
import { isTriggerType, workflowDefinitionSchema, type WorkflowDefinition, type WorkflowNode } from "./schema.ts";

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  field?: string;
  edgeId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Parsed definition when structurally valid. */
  definition?: WorkflowDefinition;
  /** Deterministic execution plan (topological order). */
  plan?: string[];
}

export interface ValidationContext {
  getNodeType: (type: string) => NodeTypeDefinition | undefined;
  /** credentialId -> credential type, scoped to the workflow's project. */
  credentials?: Map<string, string>;
  tableIds?: Set<string>;
  workflowIds?: Set<string>;
  mcpServerIds?: Set<string>;
  /** Role of the user saving/activating the workflow. */
  role?: Role;
  /** Activation requires stricter checks (credentials present, etc.). */
  forActivation?: boolean;
}

export function branchesFor(def: NodeTypeDefinition | undefined, node: WorkflowNode): string[] | undefined {
  if (!def) return undefined;
  if (def.dynamicBranches) {
    const cases = Array.isArray(node.config.cases) ? (node.config.cases as Array<{ branch?: unknown }>) : [];
    return [...cases.map((c) => String(c.branch ?? "")).filter(Boolean), "default"];
  }
  return def.branches;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

function checkField(field: FieldSpec, value: unknown, node: WorkflowNode, ctx: ValidationContext, errors: ValidationIssue[]): void {
  const push = (message: string, code = "invalid_field") => errors.push({ code, message: `${node.name}: ${field.label} ${message}`, nodeId: node.id, field: field.key });
  if (isBlank(value)) {
    if (field.required) push("is required.", "required_field");
    return;
  }
  const expr = hasExpression(value);
  if (expr && field.allowExpressions === false) {
    push("does not accept expressions.");
    return;
  }
  switch (field.type) {
    case "number":
      if (!expr && (typeof value !== "number" || Number.isNaN(value))) push("must be a number.");
      else if (!expr && typeof value === "number") {
        if (field.min !== undefined && value < field.min) push(`must be at least ${field.min}.`);
        if (field.max !== undefined && value > field.max) push(`must be at most ${field.max}.`);
      }
      return;
    case "boolean":
      if (!expr && typeof value !== "boolean") push("must be true or false.");
      return;
    case "select":
      if (!expr && !field.options?.some((o) => o.value === value)) push(`must be one of: ${field.options?.map((o) => o.value).join(", ")}.`);
      return;
    case "string":
    case "text":
      if (typeof value !== "string" && typeof value !== "number") push("must be text.");
      return;
    case "keyvalue":
      if (typeof value !== "object" || Array.isArray(value)) push("must be an object of key/value pairs.");
      return;
    case "string_list":
      if (!Array.isArray(value) && typeof value !== "string") push("must be a list.");
      return;
    case "conditions": {
      if (!Array.isArray(value)) {
        push("must be a list of rules.");
        return;
      }
      value.forEach((rule, i) => {
        const r = rule as { operator?: unknown };
        if (!r || typeof r !== "object" || !CONDITION_OPERATOR_VALUES.includes(String(r.operator))) push(`rule ${i + 1} has an unknown operator.`);
      });
      return;
    }
    case "cases": {
      if (!Array.isArray(value)) {
        push("must be a list of cases.");
        return;
      }
      const seen = new Set<string>();
      for (const c of value as Array<{ branch?: unknown }>) {
        const b = String(c?.branch ?? "");
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(b)) push(`case name '${b}' is invalid.`);
        if (b === "default") push("cannot use the reserved case name 'default'.");
        if (seen.has(b)) push(`case '${b}' is duplicated.`);
        seen.add(b);
      }
      return;
    }
    case "table":
      if (!expr && ctx.tableIds && !ctx.tableIds.has(String(value))) push("refers to a table that does not exist in this project.", "invalid_reference");
      return;
    case "workflow":
      if (!expr && ctx.workflowIds && !ctx.workflowIds.has(String(value))) push("refers to a workflow that does not exist in this project.", "invalid_reference");
      return;
    case "mcp_server":
      if (!expr && ctx.mcpServerIds && !ctx.mcpServerIds.has(String(value))) push("refers to an MCP server that is not registered in this project.", "invalid_reference");
      return;
    case "json":
      return;
  }
}

/**
 * Validates a workflow definition against the node registry and project
 * resources. Rejects unknown nodes, invalid schemas, missing required fields,
 * invalid references, cycles, unauthorized nodes, unsupported expressions and
 * invalid credential references.
 */
export function validateWorkflow(input: unknown, ctx: ValidationContext): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const parsed = workflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ code: "schema", message: `${issue.path.join(".") || "definition"}: ${issue.message}` });
    }
    return { valid: false, errors, warnings };
  }
  const def = parsed.data;
  const nodesById = new Map<string, WorkflowNode>();
  for (const n of def.nodes) {
    if (nodesById.has(n.id)) errors.push({ code: "duplicate_node", message: `Duplicate node ID '${n.id}'.`, nodeId: n.id });
    nodesById.set(n.id, n);
  }

  // Trigger checks
  const triggers = def.nodes.filter((n) => isTriggerType(n.type));
  if (triggers.length === 0) errors.push({ code: "missing_trigger", message: "A workflow needs exactly one trigger." });
  if (triggers.length > 1) errors.push({ code: "multiple_triggers", message: "A workflow can only have one trigger." });

  // Edge checks
  const edgeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  for (const e of def.edges) {
    if (edgeIds.has(e.id)) errors.push({ code: "duplicate_edge", message: `Duplicate edge ID '${e.id}'.`, edgeId: e.id });
    edgeIds.add(e.id);
    const src = nodesById.get(e.source);
    const tgt = nodesById.get(e.target);
    if (!src || !tgt) {
      errors.push({ code: "dangling_edge", message: `Connection '${e.id}' refers to a missing node.`, edgeId: e.id });
      continue;
    }
    if (e.source === e.target) errors.push({ code: "self_loop", message: `${src.name} cannot connect to itself.`, edgeId: e.id, nodeId: src.id });
    if (isTriggerType(tgt.type)) errors.push({ code: "trigger_input", message: `Triggers cannot have incoming connections (${tgt.name}).`, edgeId: e.id, nodeId: tgt.id });
    const key = `${e.source}->${e.target}:${e.branch ?? ""}`;
    if (edgeKeys.has(key)) errors.push({ code: "duplicate_connection", message: `Duplicate connection from ${src.name} to ${tgt.name}.`, edgeId: e.id });
    edgeKeys.add(key);
    const srcDef = ctx.getNodeType(src.type);
    const branches = branchesFor(srcDef, src);
    if (branches && branches.length > 0) {
      if (!e.branch) errors.push({ code: "missing_branch", message: `Connections from ${src.name} must choose a branch (${branches.join(", ")}).`, edgeId: e.id, nodeId: src.id });
      else if (!branches.includes(e.branch)) errors.push({ code: "unknown_branch", message: `${src.name} has no branch '${e.branch}'.`, edgeId: e.id, nodeId: src.id });
    } else if (e.branch) {
      errors.push({ code: "unexpected_branch", message: `${src.name} does not have named branches.`, edgeId: e.id, nodeId: src.id });
    }
  }

  // Cycles
  const { order, cyclic } = topologicalOrder(def);
  if (cyclic.length) {
    errors.push({ code: "cycle", message: `Workflow contains a cycle involving: ${cyclic.map((id) => nodesById.get(id)?.name ?? id).join(", ")}. Use a Loop node for iteration.` });
  }

  // Reachability
  const trigger = triggers[0];
  if (trigger && !cyclic.length) {
    const reachable = descendantsOf(def, trigger.id);
    for (const n of def.nodes) {
      if (n.id !== trigger.id && !reachable.has(n.id)) warnings.push({ code: "unreachable", message: `${n.name} is not connected to the trigger and will never run.`, nodeId: n.id });
    }
  }

  // Per-node checks
  for (const node of def.nodes) {
    const nd = ctx.getNodeType(node.type);
    if (!nd) {
      errors.push({ code: "unknown_node", message: `Unknown node type '${node.type}' (${node.name}).`, nodeId: node.id });
      continue;
    }
    if (ctx.role && nd.minRole && !roleAtLeast(ctx.role, nd.minRole)) {
      errors.push({ code: "unauthorized_node", message: `${node.name}: your role cannot use '${nd.name}' (requires ${nd.minRole}).`, nodeId: node.id });
    }
    const known = new Set(nd.fields.map((f) => f.key));
    for (const key of Object.keys(node.config)) {
      if (!known.has(key)) warnings.push({ code: "unknown_field", message: `${node.name}: unknown setting '${key}' will be ignored.`, nodeId: node.id, field: key });
    }
    for (const field of nd.fields) {
      if (field.showWhen && !field.showWhen.equals.includes(node.config[field.showWhen.key] ?? fieldDefault(nd, field.showWhen.key))) continue;
      checkField(field, node.config[field.key], node, ctx, errors);
    }

    // Expressions and references
    const { errors: exprErrors, stepRefs } = analyzeTemplates(node.config);
    for (const msg of exprErrors) errors.push({ code: "invalid_expression", message: `${node.name}: ${msg}`, nodeId: node.id });
    if (isTriggerType(node.type) && stepRefs.size) {
      errors.push({ code: "invalid_reference", message: `${node.name}: triggers cannot reference other steps.`, nodeId: node.id });
    }
    if (stepRefs.size && !cyclic.length) {
      const ancestors = ancestorsOf(def, node.id);
      for (const ref of stepRefs) {
        if (!nodesById.has(ref)) errors.push({ code: "invalid_reference", message: `${node.name}: references unknown step '${ref}'.`, nodeId: node.id });
        else if (!ancestors.has(ref)) errors.push({ code: "invalid_reference", message: `${node.name}: references '${ref}', which does not run before this step.`, nodeId: node.id });
      }
    }

    // Credentials
    if (nd.credentialType) {
      if (!node.credentialId) {
        if (nd.credentialRequired) {
          (ctx.forActivation ? errors : warnings).push({ code: "missing_credential", message: `${node.name}: choose a ${nd.credentialType} connection.`, nodeId: node.id });
        }
      } else if (ctx.credentials) {
        const t = ctx.credentials.get(node.credentialId);
        if (!t) errors.push({ code: "invalid_credential", message: `${node.name}: the selected connection does not exist or is not shared with this project.`, nodeId: node.id });
        else if (t !== nd.credentialType) errors.push({ code: "invalid_credential", message: `${node.name}: connection type '${t}' does not match required '${nd.credentialType}'.`, nodeId: node.id });
      }
    } else if (node.credentialId) {
      warnings.push({ code: "unused_credential", message: `${node.name}: this step does not use a connection.`, nodeId: node.id });
    }
  }

  return { valid: errors.length === 0, errors, warnings, definition: def, plan: cyclic.length ? undefined : order };
}

function fieldDefault(def: NodeTypeDefinition, key: string): unknown {
  return def.fields.find((f) => f.key === key)?.default;
}

/** Applies field defaults for keys absent from a node config. */
export function withDefaults(def: NodeTypeDefinition, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const f of def.fields) {
    if (out[f.key] === undefined && f.default !== undefined) out[f.key] = structuredClone(f.default);
  }
  return out;
}
