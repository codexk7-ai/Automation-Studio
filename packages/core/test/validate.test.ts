import { describe, expect, it } from "vitest";
import type { NodeTypeDefinition } from "../src/definitions.ts";
import { evaluateRules } from "../src/conditions.ts";
import { redact, REDACTED } from "../src/redact.ts";
import { validateWorkflow } from "../src/validate.ts";

const types: Record<string, NodeTypeDefinition> = {
  "trigger.manual": { type: "trigger.manual", integration: "core", kind: "trigger", name: "Manual", description: "", fields: [] },
  "logic.condition": { type: "logic.condition", integration: "core", kind: "logic", name: "Condition", description: "", fields: [{ key: "rules", label: "Rules", type: "conditions", required: true }], branches: ["true", "false"] },
  "logic.switch": { type: "logic.switch", integration: "core", kind: "logic", name: "Switch", description: "", fields: [{ key: "value", label: "Value", type: "string", required: true }, { key: "cases", label: "Cases", type: "cases" }], dynamicBranches: true },
  "http.request": {
    type: "http.request",
    integration: "http",
    kind: "action",
    name: "HTTP",
    description: "",
    fields: [
      { key: "url", label: "URL", type: "string", required: true },
      { key: "method", label: "Method", type: "select", options: [{ value: "GET", label: "GET" }, { value: "POST", label: "POST" }], default: "GET" },
    ],
  },
  "email.send": { type: "email.send", integration: "email", kind: "action", name: "Email", description: "", fields: [{ key: "to", label: "To", type: "string", required: true }], credentialType: "smtp", credentialRequired: true, minRole: "editor" },
};
const ctx = { getNodeType: (t: string) => types[t] };

const base = () => ({
  schemaVersion: 1,
  nodes: [
    { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
    { id: "check", type: "logic.condition", name: "Check", config: { rules: [{ left: "{{ trigger.x }}", operator: "equals", right: "1" }] } },
    { id: "call", type: "http.request", name: "Call", config: { url: "https://example.com/{{ trigger.id }}" } },
  ],
  edges: [
    { id: "e1", source: "trigger", target: "check" },
    { id: "e2", source: "check", target: "call", branch: "true" },
  ],
});

describe("validateWorkflow", () => {
  it("accepts a valid workflow and returns a plan", () => {
    const res = validateWorkflow(base(), ctx);
    expect(res.errors).toEqual([]);
    expect(res.plan).toEqual(["trigger", "check", "call"]);
  });

  it("rejects unknown nodes, missing fields, bad selects", () => {
    const def = base();
    def.nodes.push({ id: "x", type: "nope.nothing", name: "X", config: {} });
    (def.nodes[2]!.config as Record<string, unknown>) = { method: "DELETE" };
    def.edges.push({ id: "e3", source: "call", target: "x" });
    const codes = validateWorkflow(def, ctx).errors.map((e) => e.code);
    expect(codes).toContain("unknown_node");
    expect(codes).toContain("required_field");
    expect(codes).toContain("invalid_field");
  });

  it("rejects cycles, missing branches and bad references", () => {
    const def = base();
    def.edges.push({ id: "e3", source: "call", target: "check" });
    expect(validateWorkflow(def, ctx).errors.map((e) => e.code)).toContain("cycle");

    const def2 = base();
    def2.edges[1] = { id: "e2", source: "check", target: "call" } as never;
    expect(validateWorkflow(def2, ctx).errors.map((e) => e.code)).toContain("missing_branch");

    const def3 = base();
    (def3.nodes[1]!.config as Record<string, unknown>).rules = [{ left: "{{ steps.call.output.status }}", operator: "equals", right: 1 }];
    expect(validateWorkflow(def3, ctx).errors.map((e) => e.code)).toContain("invalid_reference");

    const def4 = base();
    (def4.nodes[2]!.config as Record<string, unknown>).url = "{{ 1 + }}";
    expect(validateWorkflow(def4, ctx).errors.map((e) => e.code)).toContain("invalid_expression");
  });

  it("validates dynamic switch branches", () => {
    const def = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger.manual", name: "T", config: {} },
        { id: "s", type: "logic.switch", name: "S", config: { value: "{{ trigger.kind }}", cases: [{ branch: "sales", equals: "sales" }] } },
        { id: "a", type: "http.request", name: "A", config: { url: "https://a.example" } },
      ],
      edges: [
        { id: "1", source: "t", target: "s" },
        { id: "2", source: "s", target: "a", branch: "support" },
      ],
    };
    expect(validateWorkflow(def, ctx).errors.map((e) => e.code)).toContain("unknown_branch");
    def.edges[1]!.branch = "default";
    expect(validateWorkflow(def, ctx).valid).toBe(true);
  });

  it("enforces credentials and roles", () => {
    const def = base();
    def.nodes.push({ id: "mail", type: "email.send", name: "Mail", config: { to: "a@b.co" } });
    def.edges.push({ id: "e3", source: "call", target: "mail" });
    expect(validateWorkflow(def, { ...ctx, forActivation: true }).errors.map((e) => e.code)).toContain("missing_credential");
    (def.nodes[3] as Record<string, unknown>).credentialId = "cred1";
    expect(validateWorkflow(def, { ...ctx, credentials: new Map([["cred1", "oauth"]]) }).errors.map((e) => e.code)).toContain("invalid_credential");
    expect(validateWorkflow(def, { ...ctx, credentials: new Map([["cred1", "smtp"]]), role: "viewer" }).errors.map((e) => e.code)).toContain("unauthorized_node");
    expect(validateWorkflow(def, { ...ctx, credentials: new Map([["cred1", "smtp"]]), role: "editor" }).valid).toBe(true);
  });

  it("requires exactly one trigger", () => {
    const def = base();
    def.nodes.push({ id: "t2", type: "trigger.manual", name: "T2", config: {} });
    expect(validateWorkflow(def, ctx).errors.map((e) => e.code)).toContain("multiple_triggers");
  });
});

describe("conditions", () => {
  it("evaluates rules", () => {
    expect(evaluateRules([{ left: "Hot", operator: "equals", right: "hot" }])).toBe(true);
    expect(evaluateRules([{ left: "10", operator: "gt", right: 9 }])).toBe(true);
    expect(evaluateRules([{ left: "", operator: "is_empty" }, { left: "x", operator: "is_empty" }], "or")).toBe(true);
    expect(evaluateRules([{ left: ["a", "b"], operator: "contains", right: "b" }])).toBe(true);
  });
});

describe("redaction", () => {
  it("redacts sensitive keys and known secrets", () => {
    const out = redact({ headers: { Authorization: "Bearer abc.def", accept: "json" }, body: "key=supersecret1", apiKey: "x", tokens: 5 }, ["supersecret1"]) as Record<string, unknown>;
    expect((out.headers as Record<string, unknown>).Authorization).toBe(REDACTED);
    expect(out.body).toBe(`key=${REDACTED}`);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.tokens).toBe(5);
  });
});

describe("autoLayout", () => {
  it("ranks nodes top-to-bottom by longest path and orders branches left-to-right", async () => {
    const { autoLayout } = await import("../src/layout.ts");
    const def = {
      schemaVersion: 1 as const,
      settings: { timeoutMs: 1000, maxStepExecutions: 10, dedupeWindowSeconds: 0 },
      nodes: [
        { id: "t", type: "trigger.manual", name: "T", config: {}, onError: "fail" as const, disabled: false },
        { id: "c", type: "logic.condition", name: "C", config: {}, onError: "fail" as const, disabled: false },
        { id: "no", type: "x", name: "No", config: {}, onError: "fail" as const, disabled: false },
        { id: "yes", type: "x", name: "Yes", config: {}, onError: "fail" as const, disabled: false },
        { id: "end", type: "x", name: "End", config: {}, onError: "fail" as const, disabled: false },
      ],
      edges: [
        { id: "1", source: "t", target: "c" },
        { id: "2", source: "c", target: "yes", branch: "true" },
        { id: "3", source: "c", target: "no", branch: "false" },
        { id: "4", source: "yes", target: "end" },
        { id: "5", source: "t", target: "end" },
      ],
    };
    const out = autoLayout(def, (n) => (n.type === "logic.condition" ? ["true", "false"] : []));
    const pos = Object.fromEntries(out.nodes.map((n) => [n.id, n.position!]));
    expect(pos.t!.y).toBeLessThan(pos.c!.y);
    expect(pos.yes!.y).toBe(pos.no!.y);
    expect(pos.yes!.x).toBeLessThan(pos.no!.x); // "true" branch left of "false"
    expect(pos.end!.y).toBeGreaterThan(pos.yes!.y); // longest path, not shortest
    expect(out.edges).toEqual(def.edges); // layout never changes execution structure
  });
});
