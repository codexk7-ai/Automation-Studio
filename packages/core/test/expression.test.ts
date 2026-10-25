import { describe, expect, it } from "vitest";
import { analyzeTemplates, evaluateExpression, ExpressionError, parseTemplate, renderTemplate, renderValue } from "../src/expression.ts";

const scope = {
  trigger: { body: { email: "Ada@Example.com", name: "Ada", score: "42", tags: ["a", "b"] } },
  steps: { classify: { output: { label: "hot", confidence: 0.9 } }, list: { output: { items: [{ n: 1 }, { n: 2 }] } } },
  vars: {},
};

describe("expressions", () => {
  it("reads nested paths", () => {
    expect(evaluateExpression("trigger.body.email", scope)).toBe("Ada@Example.com");
    expect(evaluateExpression('steps["classify"].output.label', scope)).toBe("hot");
    expect(evaluateExpression("steps.list.output.items[1].n", scope)).toBe(2);
    expect(evaluateExpression("trigger.body.missing?.deep", scope)).toBeUndefined();
  });

  it("supports operators and functions", () => {
    expect(evaluateExpression('lower(trigger.body.email) == "ada@example.com"', scope)).toBe(true);
    expect(evaluateExpression("number(trigger.body.score) + 8", scope)).toBe(50);
    expect(evaluateExpression('steps.classify.output.confidence > 0.5 ? "yes" : "no"', scope)).toBe("yes");
    expect(evaluateExpression('default(trigger.body.nope, "fallback")', scope)).toBe("fallback");
    expect(evaluateExpression('join(trigger.body.tags, "|")', scope)).toBe("a|b");
    expect(evaluateExpression("sum(pluck(steps.list.output.items, \"n\"))", scope)).toBe(3);
    expect(evaluateExpression('emailDomain(trigger.body.email)', scope)).toBe("example.com");
    expect(evaluateExpression("trigger.body.nope ?? 5", scope)).toBe(5);
  });

  it("renders templates, keeping raw values for single expressions", () => {
    expect(renderTemplate("Hi {{ trigger.body.name }}!", scope)).toBe("Hi Ada!");
    expect(renderTemplate("{{ steps.list.output.items }}", scope)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(renderTemplate("n={{ steps.list.output.items[0] }}", scope)).toBe('n={"n":1}');
    expect(renderValue({ a: ["{{ trigger.body.name }}"], b: 3 }, scope)).toEqual({ a: ["Ada"], b: 3 });
    expect(parseTemplate('x {{ "}}" }} y').map((s) => s.kind)).toEqual(["text", "expr", "text"]);
  });

  it("blocks unsafe access and unknown identifiers", () => {
    expect(() => evaluateExpression("trigger.constructor", scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression('trigger["__proto__"]', scope)).toThrow(ExpressionError);
    expect(() => evaluateExpression("process.env", scope)).toThrow(/Unknown variable/);
    expect(() => evaluateExpression("globalThis", scope)).toThrow(/Unknown variable/);
    expect(() => evaluateExpression("eval('1')", scope)).toThrow(/Unknown function/);
    expect(() => evaluateExpression("trigger.body.name.toUpperCase()", scope)).toThrow(/whitelisted/);
    expect(evaluateExpression("trigger.body.email.length", scope)).toBe(15);
  });

  it("does not invoke getters", () => {
    let called = false;
    const obj = {};
    Object.defineProperty(obj, "x", { enumerable: true, get: () => ((called = true), 1) });
    expect(evaluateExpression("trigger.x", { trigger: obj })).toBeUndefined();
    expect(called).toBe(false);
  });

  it("bounds evaluation", () => {
    expect(() => evaluateExpression("(".repeat(200) + "1" + ")".repeat(200), scope)).toThrow(/nested/);
    expect(() => evaluateExpression("x".repeat(5000), scope)).toThrow(/exceeds/);
  });

  it("collects step references and syntax errors", () => {
    const res = analyzeTemplates({ to: "{{ steps.a.output.email }}", body: "Hi {{ steps.b.output.name }} {{ trigger.x }}", bad: "{{ 1 + }}" });
    expect([...res.stepRefs].sort()).toEqual(["a", "b"]);
    expect(res.errors).toHaveLength(1);
  });
});
