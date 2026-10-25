import { toText } from "./expression.ts";

export const CONDITION_OPERATORS = [
  { value: "equals", label: "equals", unary: false },
  { value: "not_equals", label: "does not equal", unary: false },
  { value: "contains", label: "contains", unary: false },
  { value: "not_contains", label: "does not contain", unary: false },
  { value: "starts_with", label: "starts with", unary: false },
  { value: "ends_with", label: "ends with", unary: false },
  { value: "gt", label: "greater than", unary: false },
  { value: "gte", label: "greater than or equal", unary: false },
  { value: "lt", label: "less than", unary: false },
  { value: "lte", label: "less than or equal", unary: false },
  { value: "is_empty", label: "is empty", unary: true },
  { value: "is_not_empty", label: "is not empty", unary: true },
  { value: "is_true", label: "is true", unary: true },
  { value: "is_false", label: "is false", unary: true },
  { value: "is_email", label: "is a valid email", unary: true },
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]["value"];
export const CONDITION_OPERATOR_VALUES = CONDITION_OPERATORS.map((o) => o.value) as string[];

export interface ConditionRule {
  left: unknown;
  operator: ConditionOperator;
  right?: unknown;
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && Object.keys(v).length === 0);
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(toText(v).trim());
}

function cmp(a: unknown, b: unknown): number {
  const na = num(a);
  const nb = num(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && toText(a).trim() !== "" && toText(b).trim() !== "") return na - nb;
  const da = Date.parse(toText(a));
  const db = Date.parse(toText(b));
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return toText(a).localeCompare(toText(b));
}

/** Evaluates one rule whose operands have already been rendered. */
export function evaluateRule(rule: ConditionRule, caseSensitive = false): boolean {
  const norm = (v: unknown) => (caseSensitive ? toText(v) : toText(v).toLowerCase());
  const { left, right } = rule;
  switch (rule.operator) {
    case "equals":
      return typeof left === "number" || typeof right === "number" ? cmp(left, right) === 0 : norm(left) === norm(right);
    case "not_equals":
      return !evaluateRule({ ...rule, operator: "equals" }, caseSensitive);
    case "contains":
      return Array.isArray(left) ? left.some((x) => norm(x) === norm(right)) : norm(left).includes(norm(right));
    case "not_contains":
      return !evaluateRule({ ...rule, operator: "contains" }, caseSensitive);
    case "starts_with":
      return norm(left).startsWith(norm(right));
    case "ends_with":
      return norm(left).endsWith(norm(right));
    case "gt":
      return cmp(left, right) > 0;
    case "gte":
      return cmp(left, right) >= 0;
    case "lt":
      return cmp(left, right) < 0;
    case "lte":
      return cmp(left, right) <= 0;
    case "is_empty":
      return isEmpty(left);
    case "is_not_empty":
      return !isEmpty(left);
    case "is_true":
      return left === true || ["true", "1", "yes"].includes(toText(left).toLowerCase());
    case "is_false":
      return !evaluateRule({ ...rule, operator: "is_true" }, caseSensitive);
    case "is_email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toText(left).trim());
    default:
      throw new Error(`Unknown condition operator '${String(rule.operator)}'`);
  }
}

export function evaluateRules(rules: ConditionRule[], combinator: "and" | "or" = "and", caseSensitive = false): boolean {
  if (rules.length === 0) return true;
  return combinator === "or" ? rules.some((r) => evaluateRule(r, caseSensitive)) : rules.every((r) => evaluateRule(r, caseSensitive));
}
