/**
 * Safe expression language for workflow templates.
 *
 * Templates embed expressions in `{{ ... }}`. Expressions are parsed into an
 * AST and interpreted; nothing is ever passed to `eval`/`Function`. Only a
 * fixed set of root variables and whitelisted pure functions are reachable,
 * property access is restricted to own data properties, and evaluation is
 * bounded by source length, AST depth and a step budget.
 *
 * Examples:
 *   {{ trigger.body.email }}
 *   {{ steps.classify.output.label == "hot" ? "priority" : "normal" }}
 *   Hello {{ default(trigger.body.name, "there") }}!
 */

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = "ExpressionError";
  }
}

export const EXPRESSION_ROOTS = ["trigger", "steps", "item", "index", "vars", "execution", "workflow"] as const;

const MAX_SOURCE_LENGTH = 4000;
const MAX_DEPTH = 64;
const MAX_STEPS = 20_000;
const MAX_STRING = 1_000_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);

// ---------------------------------------------------------------------------
// Tokenizer

type TokenType = "num" | "str" | "ident" | "punc" | "eof";
interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const PUNCTUATION = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "<", ">", "+", "-", "*", "/", "%", "!", "?", ":", ".", ",", "(", ")", "[", "]"];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExpressionError("Invalid number", i);
      tokens.push({ type: "num", value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\") {
          const next = src[j + 1];
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'" };
          if (next === undefined) throw new ExpressionError("Unterminated string", i);
          out += map[next] ?? next;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new ExpressionError("Unterminated string", i);
      tokens.push({ type: "str", value: out, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      tokens.push({ type: "ident", value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const punc = PUNCTUATION.find((p) => src.startsWith(p, i));
    if (!punc) throw new ExpressionError(`Unexpected character '${ch}'`, i);
    tokens.push({ type: "punc", value: punc, pos: i });
    i += punc.length;
  }
  tokens.push({ type: "eof", value: "", pos: src.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser

export type Ast =
  | { kind: "literal"; value: unknown }
  | { kind: "ident"; name: string }
  | { kind: "member"; object: Ast; property: Ast; computed: boolean; optional: boolean }
  | { kind: "call"; name: string; args: Ast[] }
  | { kind: "unary"; op: string; arg: Ast }
  | { kind: "binary"; op: string; left: Ast; right: Ast }
  | { kind: "conditional"; test: Ast; consequent: Ast; alternate: Ast }
  | { kind: "array"; items: Ast[] };

const BINARY_PRECEDENCE: Record<string, number> = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "===": 4,
  "!==": 4,
  "<": 5,
  ">": 5,
  "<=": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.i]!;
  }
  private next(): Token {
    return this.tokens[this.i++]!;
  }
  private isPunc(value: string): boolean {
    const t = this.peek();
    return t.type === "punc" && t.value === value;
  }
  private expectPunc(value: string): void {
    const t = this.next();
    if (t.type !== "punc" || t.value !== value) throw new ExpressionError(`Expected '${value}'`, t.pos);
  }

  parse(): Ast {
    const ast = this.parseConditional(0);
    const t = this.peek();
    if (t.type !== "eof") throw new ExpressionError(`Unexpected token '${t.value}'`, t.pos);
    return ast;
  }

  private guard(depth: number): void {
    if (depth > MAX_DEPTH) throw new ExpressionError("Expression is nested too deeply");
  }

  private parseConditional(depth: number): Ast {
    this.guard(depth);
    const test = this.parseBinary(0, depth + 1);
    if (this.isPunc("?")) {
      this.next();
      const consequent = this.parseConditional(depth + 1);
      this.expectPunc(":");
      const alternate = this.parseConditional(depth + 1);
      return { kind: "conditional", test, consequent, alternate };
    }
    return test;
  }

  private parseBinary(minPrec: number, depth: number): Ast {
    this.guard(depth);
    let left = this.parseUnary(depth + 1);
    for (;;) {
      const t = this.peek();
      const prec = t.type === "punc" ? BINARY_PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec <= minPrec) break;
      this.next();
      const right = this.parseBinary(prec, depth + 1);
      left = { kind: "binary", op: t.value, left, right };
    }
    return left;
  }

  private parseUnary(depth: number): Ast {
    this.guard(depth);
    if (this.isPunc("!") || this.isPunc("-")) {
      const op = this.next().value;
      return { kind: "unary", op, arg: this.parseUnary(depth + 1) };
    }
    return this.parsePostfix(depth + 1);
  }

  private parsePostfix(depth: number): Ast {
    let node = this.parsePrimary(depth + 1);
    for (;;) {
      this.guard(depth);
      if (this.isPunc(".") || this.isPunc("?.")) {
        const optional = this.next().value === "?.";
        if (this.isPunc("[")) {
          this.next();
          const property = this.parseConditional(depth + 1);
          this.expectPunc("]");
          node = { kind: "member", object: node, property, computed: true, optional };
          continue;
        }
        const t = this.next();
        if (t.type !== "ident") throw new ExpressionError("Expected property name", t.pos);
        node = { kind: "member", object: node, property: { kind: "literal", value: t.value }, computed: false, optional };
      } else if (this.isPunc("[")) {
        this.next();
        const property = this.parseConditional(depth + 1);
        this.expectPunc("]");
        node = { kind: "member", object: node, property, computed: true, optional: false };
      } else if (this.isPunc("(")) {
        throw new ExpressionError("Only whitelisted functions can be called", this.peek().pos);
      } else {
        return node;
      }
    }
  }

  private parsePrimary(depth: number): Ast {
    this.guard(depth);
    const t = this.next();
    switch (t.type) {
      case "num":
        return { kind: "literal", value: Number(t.value) };
      case "str":
        return { kind: "literal", value: t.value };
      case "ident": {
        if (t.value === "true") return { kind: "literal", value: true };
        if (t.value === "false") return { kind: "literal", value: false };
        if (t.value === "null") return { kind: "literal", value: null };
        if (t.value === "undefined") return { kind: "literal", value: undefined };
        if (this.isPunc("(")) {
          this.next();
          if (!Object.hasOwn(FUNCTIONS, t.value)) throw new ExpressionError(`Unknown function '${t.value}'`, t.pos);
          const args: Ast[] = [];
          if (!this.isPunc(")")) {
            do {
              args.push(this.parseConditional(depth + 1));
            } while (this.isPunc(",") && this.next());
          }
          this.expectPunc(")");
          return { kind: "call", name: t.value, args };
        }
        if (!(EXPRESSION_ROOTS as readonly string[]).includes(t.value)) {
          throw new ExpressionError(`Unknown variable '${t.value}'. Use one of: ${EXPRESSION_ROOTS.join(", ")}`, t.pos);
        }
        return { kind: "ident", name: t.value };
      }
      case "punc":
        if (t.value === "(") {
          const inner = this.parseConditional(depth + 1);
          this.expectPunc(")");
          return inner;
        }
        if (t.value === "[") {
          const items: Ast[] = [];
          if (!this.isPunc("]")) {
            do {
              items.push(this.parseConditional(depth + 1));
            } while (this.isPunc(",") && this.next());
          }
          this.expectPunc("]");
          return { kind: "array", items };
        }
        throw new ExpressionError(`Unexpected '${t.value}'`, t.pos);
      default:
        throw new ExpressionError("Unexpected end of expression", t.pos);
    }
  }
}

const astCache = new Map<string, Ast>();

export function parseExpression(src: string): Ast {
  if (src.length > MAX_SOURCE_LENGTH) throw new ExpressionError(`Expression exceeds ${MAX_SOURCE_LENGTH} characters`);
  const cached = astCache.get(src);
  if (cached) return cached;
  const ast = new Parser(tokenize(src)).parse();
  if (astCache.size > 5000) astCache.clear();
  astCache.set(src, ast);
  return ast;
}

// ---------------------------------------------------------------------------
// Evaluation

export interface ExpressionScope {
  trigger?: unknown;
  steps?: Record<string, unknown>;
  item?: unknown;
  index?: number;
  vars?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  workflow?: Record<string, unknown>;
}

function safeGet(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (typeof key !== "string" && typeof key !== "number") throw new ExpressionError("Property keys must be strings or numbers");
  const k = String(key);
  if (FORBIDDEN_KEYS.has(k)) throw new ExpressionError(`Access to '${k}' is not allowed`);
  if (typeof obj === "string") {
    if (k === "length") return obj.length;
    if (/^\d+$/.test(k)) return obj[Number(k)];
    return undefined;
  }
  if (Array.isArray(obj)) {
    if (k === "length") return obj.length;
    if (/^-?\d+$/.test(k)) {
      const n = Number(k);
      return n < 0 ? obj[obj.length + n] : obj[n];
    }
    return undefined;
  }
  if (typeof obj === "object") {
    if (!Object.hasOwn(obj, k)) return undefined;
    const desc = Object.getOwnPropertyDescriptor(obj, k);
    if (!desc || !("value" in desc)) return undefined; // never invoke getters
    const v = desc.value;
    return typeof v === "function" ? undefined : v;
  }
  return undefined;
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a);
    const nb = Number(b);
    return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb;
  }
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b);
  return false;
}

export function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function capString(s: string): string {
  if (s.length > MAX_STRING) throw new ExpressionError("Expression result is too large");
  return s;
}

export function evaluateAst(ast: Ast, scope: ExpressionScope): unknown {
  let steps = 0;
  const visit = (node: Ast): unknown => {
    if (++steps > MAX_STEPS) throw new ExpressionError("Expression evaluation budget exceeded");
    switch (node.kind) {
      case "literal":
        return node.value;
      case "ident":
        return (scope as Record<string, unknown>)[node.name];
      case "array":
        return node.items.map(visit);
      case "member": {
        const obj = visit(node.object);
        if ((obj === null || obj === undefined) && node.optional) return undefined;
        return safeGet(obj, visit(node.property));
      }
      case "call": {
        const fn = FUNCTIONS[node.name];
        if (!fn) throw new ExpressionError(`Unknown function '${node.name}'`);
        return fn(...node.args.map(visit));
      }
      case "unary": {
        const v = visit(node.arg);
        return node.op === "!" ? !truthy(v) : -Number(v);
      }
      case "conditional":
        return truthy(visit(node.test)) ? visit(node.consequent) : visit(node.alternate);
      case "binary": {
        if (node.op === "&&") {
          const l = visit(node.left);
          return truthy(l) ? visit(node.right) : l;
        }
        if (node.op === "||") {
          const l = visit(node.left);
          return truthy(l) ? l : visit(node.right);
        }
        if (node.op === "??") {
          const l = visit(node.left);
          return l === null || l === undefined ? visit(node.right) : l;
        }
        const l = visit(node.left);
        const r = visit(node.right);
        switch (node.op) {
          case "==":
            return looseEquals(l, r);
          case "!=":
            return !looseEquals(l, r);
          case "===":
            return l === r;
          case "!==":
            return l !== r;
          case "<":
            return compare(l, r) < 0;
          case ">":
            return compare(l, r) > 0;
          case "<=":
            return compare(l, r) <= 0;
          case ">=":
            return compare(l, r) >= 0;
          case "+":
            if (typeof l === "number" && typeof r === "number") return l + r;
            return capString(toText(l) + toText(r));
          case "-":
            return Number(l) - Number(r);
          case "*":
            return Number(l) * Number(r);
          case "/":
            return Number(l) / Number(r);
          case "%":
            return Number(l) % Number(r);
        }
        throw new ExpressionError(`Unknown operator ${node.op}`);
      }
    }
  };
  return visit(ast);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string") {
    const da = Date.parse(a);
    const db = Date.parse(b);
    if (/^\d{4}-\d{2}-\d{2}/.test(a) && /^\d{4}-\d{2}-\d{2}/.test(b) && !Number.isNaN(da) && !Number.isNaN(db)) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return Number.NaN;
  return na - nb;
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

export function evaluateExpression(src: string, scope: ExpressionScope): unknown {
  return evaluateAst(parseExpression(src), scope);
}

// ---------------------------------------------------------------------------
// Templates

export interface TemplateSegment {
  kind: "text" | "expr";
  value: string;
  start: number;
}

/** Splits a template into literal text and `{{ expression }}` segments. */
export function parseTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let i = 0;
  let textStart = 0;
  while (i < template.length) {
    if (template.startsWith("{{", i)) {
      if (i > textStart) segments.push({ kind: "text", value: template.slice(textStart, i), start: textStart });
      let j = i + 2;
      let quote: string | null = null;
      while (j < template.length) {
        const c = template[j];
        if (quote) {
          if (c === "\\") j++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (template.startsWith("}}", j)) break;
        j++;
      }
      if (j >= template.length) throw new ExpressionError("Unclosed '{{' in template", i);
      segments.push({ kind: "expr", value: template.slice(i + 2, j).trim(), start: i });
      i = j + 2;
      textStart = i;
    } else {
      i++;
    }
  }
  if (textStart < template.length) segments.push({ kind: "text", value: template.slice(textStart), start: textStart });
  return segments;
}

export function hasExpression(value: unknown): boolean {
  return typeof value === "string" && value.includes("{{");
}

/**
 * Renders a template string. A template that consists of exactly one
 * expression returns the raw (typed) value; otherwise values are interpolated
 * as text.
 */
export function renderTemplate(template: string, scope: ExpressionScope): unknown {
  if (!template.includes("{{")) return template;
  const segments = parseTemplate(template);
  if (segments.length === 1 && segments[0]!.kind === "expr") {
    return evaluateExpression(segments[0]!.value, scope);
  }
  let out = "";
  for (const seg of segments) {
    out += seg.kind === "text" ? seg.value : toText(evaluateExpression(seg.value, scope));
    capString(out);
  }
  return out;
}

/** Recursively renders every template string inside a JSON-like value. */
export function renderValue(value: unknown, scope: ExpressionScope, depth = 0): unknown {
  if (depth > 32) throw new ExpressionError("Configuration is nested too deeply");
  if (typeof value === "string") return renderTemplate(value, scope);
  if (Array.isArray(value)) return value.map((v) => renderValue(v, scope, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      out[k] = renderValue(v, scope, depth + 1);
    }
    return out;
  }
  return value;
}

/** Returns the step IDs referenced as `steps.<id>` / `steps["id"]` in an AST. */
export function collectStepReferences(ast: Ast, out = new Set<string>()): Set<string> {
  const walk = (n: Ast): void => {
    switch (n.kind) {
      case "member":
        if (n.object.kind === "ident" && n.object.name === "steps" && n.property.kind === "literal" && typeof n.property.value === "string") {
          out.add(n.property.value);
        }
        walk(n.object);
        walk(n.property);
        return;
      case "call":
        n.args.forEach(walk);
        return;
      case "unary":
        walk(n.arg);
        return;
      case "binary":
        walk(n.left);
        walk(n.right);
        return;
      case "conditional":
        walk(n.test);
        walk(n.consequent);
        walk(n.alternate);
        return;
      case "array":
        n.items.forEach(walk);
        return;
      default:
        return;
    }
  };
  walk(ast);
  return out;
}

/** Validates every template in a value; returns errors and referenced step IDs. */
export function analyzeTemplates(value: unknown): { errors: string[]; stepRefs: Set<string>; usesItem: boolean } {
  const errors: string[] = [];
  const stepRefs = new Set<string>();
  let usesItem = false;
  const visit = (v: unknown, path: string, depth: number): void => {
    if (depth > 32) return;
    if (typeof v === "string") {
      if (!v.includes("{{")) return;
      try {
        for (const seg of parseTemplate(v)) {
          if (seg.kind !== "expr") continue;
          if (seg.value === "") {
            errors.push(`${path}: empty expression`);
            continue;
          }
          const ast = parseExpression(seg.value);
          collectStepReferences(ast, stepRefs);
          if (/\b(item|index)\b/.test(seg.value)) usesItem = true;
        }
      } catch (err) {
        errors.push(`${path}: ${(err as Error).message}`);
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${path}[${i}]`, depth + 1));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) visit(x, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  visit(value, "", 0);
  return { errors, stepRefs, usesItem };
}

// ---------------------------------------------------------------------------
// Whitelisted functions (pure, bounded)

function str(v: unknown): string {
  return toText(v);
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
}
function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function formatDate(value: unknown, pattern: unknown = "YYYY-MM-DD"): string {
  const d = value instanceof Date ? value : new Date(typeof value === "number" ? value : str(value));
  if (Number.isNaN(d.getTime())) return "";
  const map: Record<string, string> = {
    YYYY: String(d.getUTCFullYear()),
    MM: pad(d.getUTCMonth() + 1),
    DD: pad(d.getUTCDate()),
    HH: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
  };
  return str(pattern).replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => map[t]!);
}

export const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = Object.freeze({
  lower: (s) => str(s).toLowerCase(),
  upper: (s) => str(s).toUpperCase(),
  trim: (s) => str(s).trim(),
  capitalize: (s) => {
    const t = str(s);
    return t.charAt(0).toUpperCase() + t.slice(1);
  },
  length: (v) => (typeof v === "string" || Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0),
  count: (v) => arr(v).length,
  concat: (...parts) => capString(parts.map(str).join("")),
  join: (a, sep = ",") => capString(arr(a).map(str).join(str(sep))),
  split: (s, sep = ",") => str(s).split(str(sep)).slice(0, 10_000),
  replace: (s, find, repl) => capString(str(s).split(str(find)).join(str(repl))),
  contains: (h, n) => (Array.isArray(h) ? h.some((x) => looseEquals(x, n)) : str(h).includes(str(n))),
  includes: (h, n) => (Array.isArray(h) ? h.some((x) => looseEquals(x, n)) : str(h).includes(str(n))),
  startsWith: (s, p) => str(s).startsWith(str(p)),
  endsWith: (s, p) => str(s).endsWith(str(p)),
  truncate: (s, n = 100) => {
    const t = str(s);
    const max = Math.max(0, Number(n) || 0);
    return t.length > max ? `${t.slice(0, max)}…` : t;
  },
  slugify: (s) =>
    str(s)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  default: (v, fallback) => (v === null || v === undefined || v === "" ? fallback : v),
  coalesce: (...vals) => vals.find((v) => v !== null && v !== undefined && v !== ""),
  isEmpty: (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && Object.keys(v).length === 0),
  number: (v) => {
    const n = typeof v === "number" ? v : Number(str(v).replace(/,/g, ""));
    return Number.isNaN(n) ? null : n;
  },
  string: (v) => str(v),
  boolean: (v) => (typeof v === "string" ? ["true", "1", "yes", "y", "on"].includes(v.toLowerCase()) : Boolean(v)),
  json: (v) => capString(JSON.stringify(v ?? null)),
  parseJson: (s) => {
    try {
      return JSON.parse(str(s));
    } catch {
      throw new ExpressionError("parseJson: invalid JSON");
    }
  },
  round: (n, digits = 0) => {
    const f = 10 ** Math.min(10, Math.max(0, Number(digits) || 0));
    return Math.round(Number(n) * f) / f;
  },
  floor: (n) => Math.floor(Number(n)),
  ceil: (n) => Math.ceil(Number(n)),
  abs: (n) => Math.abs(Number(n)),
  min: (...v) => Math.min(...v.flatMap(arr).map(Number)),
  max: (...v) => Math.max(...v.flatMap(arr).map(Number)),
  sum: (a) => arr(a).reduce<number>((acc, x) => acc + (Number(x) || 0), 0),
  avg: (a) => {
    const xs = arr(a);
    return xs.length ? xs.reduce<number>((acc, x) => acc + (Number(x) || 0), 0) / xs.length : 0;
  },
  first: (a) => arr(a)[0],
  last: (a) => {
    const xs = arr(a);
    return xs[xs.length - 1];
  },
  slice: (v, start, end) => (typeof v === "string" ? v.slice(Number(start) || 0, end === undefined ? undefined : Number(end)) : arr(v).slice(Number(start) || 0, end === undefined ? undefined : Number(end))),
  unique: (a) => [...new Map(arr(a).map((x) => [JSON.stringify(x), x])).values()],
  pluck: (a, key) => arr(a).map((x) => safeGet(x, str(key))),
  filterBy: (a, key, value) => arr(a).filter((x) => looseEquals(safeGet(x, str(key)), value)),
  sortBy: (a, key) =>
    [...arr(a)].sort((x, y) => {
      const c = compare(safeGet(x, str(key)), safeGet(y, str(key)));
      return Number.isNaN(c) ? 0 : c;
    }),
  keys: (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : []),
  values: (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.values(o) : []),
  get: (o, path, fallback) => {
    let cur: unknown = o;
    for (const part of str(path).split(".").filter(Boolean)) {
      cur = safeGet(cur, part);
      if (cur === undefined) return fallback;
    }
    return cur ?? fallback;
  },
  pick: (o, ...ks) => {
    const out: Record<string, unknown> = {};
    for (const k of ks.flatMap(arr).map(str)) {
      const v = safeGet(o, k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  },
  merge: (...objs) => {
    const out: Record<string, unknown> = {};
    for (const o of objs) {
      if (o && typeof o === "object" && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o)) if (!FORBIDDEN_KEYS.has(k)) out[k] = v;
      }
    }
    return out;
  },
  now: () => new Date().toISOString(),
  today: () => new Date().toISOString().slice(0, 10),
  formatDate,
  addDays: (d, n) => {
    const date = new Date(str(d));
    if (Number.isNaN(date.getTime())) return null;
    date.setUTCDate(date.getUTCDate() + (Number(n) || 0));
    return date.toISOString();
  },
  addMinutes: (d, n) => {
    const date = new Date(str(d));
    if (Number.isNaN(date.getTime())) return null;
    return new Date(date.getTime() + (Number(n) || 0) * 60_000).toISOString();
  },
  urlEncode: (s) => encodeURIComponent(str(s)),
  base64Encode: (s) => btoa(String.fromCharCode(...new TextEncoder().encode(str(s)))),
  base64Decode: (s) => new TextDecoder().decode(Uint8Array.from(atob(str(s)), (c: string) => c.charCodeAt(0))),
  emailDomain: (s) => {
    const m = /@([^@\s>]+)>?$/.exec(str(s).trim());
    return m ? m[1]!.toLowerCase() : "";
  },
  isEmail: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(s).trim()),
  uuid: () => crypto.randomUUID(),
});

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
