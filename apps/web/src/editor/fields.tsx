import type { FieldSpec } from "@automation-studio/core";
import { Plus, Trash2, Braces } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { get } from "../api";
import { useSession } from "../session";

/** Callback the mapping picker uses to insert an expression into the focused input. */
export type Inserter = (text: string) => void;

interface FieldProps {
  field: FieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  onFocusInsert: (fn: Inserter) => void;
  error?: string;
}

const isExpr = (v: unknown) => typeof v === "string" && v.includes("{{");

/** Text input that supports inserting mapped expressions at the cursor. */
function ExprInput({ value, onChange, onFocusInsert, multiline, placeholder, mono, ariaLabel }: { value: string; onChange: (v: string) => void; onFocusInsert: (fn: Inserter) => void; multiline?: boolean; placeholder?: string; mono?: boolean; ariaLabel: string }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const register = () =>
    onFocusInsert((text) => {
      const el = ref.current;
      const v = el?.value ?? value;
      const start = el?.selectionStart ?? v.length;
      const end = el?.selectionEnd ?? v.length;
      const next = v.slice(0, start) + text + v.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(start + text.length, start + text.length);
      });
    });
  const cls = `input ${mono ? "mono" : ""} ${isExpr(value) ? "has-expr" : ""}`;
  return multiline ? (
    <textarea ref={ref} className={cls} value={value} placeholder={placeholder} rows={4} onFocus={register} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel} />
  ) : (
    <input ref={ref} className={cls} value={value} placeholder={placeholder} onFocus={register} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel} />
  );
}

function JsonField({ value, onChange, onFocusInsert, label }: { value: unknown; onChange: (v: unknown) => void; onFocusInsert: (fn: Inserter) => void; label: string }) {
  const [text, setText] = useState(() => (value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string | null>(null);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2));
    }
  }, [value]);
  const commit = (t: string) => {
    setText(t);
    if (!t.trim()) {
      setError(null);
      last.current = undefined;
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(t);
      setError(null);
      last.current = parsed;
      onChange(parsed);
    } catch {
      // Allow a bare template like {{ steps.x.output }} as the whole value.
      if (/^\s*\{\{[\s\S]*\}\}\s*$/.test(t)) {
        setError(null);
        last.current = t.trim();
        onChange(t.trim());
      } else setError("Not valid JSON yet — expressions go inside JSON strings, e.g. \"{{ trigger.body.email }}\".");
    }
  };
  return (
    <>
      <ExprInput value={text} onChange={commit} onFocusInsert={onFocusInsert} multiline mono ariaLabel={label} />
      {error && <div className="help" style={{ color: "var(--warning)" }}>{error}</div>}
    </>
  );
}

function KeyValueField({ value, onChange, onFocusInsert, allowExpr }: { value: unknown; onChange: (v: unknown) => void; onFocusInsert: (fn: Inserter) => void; allowExpr: boolean }) {
  const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries((value as Record<string, unknown>) ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const emit = (next: Array<[string, string]>) => {
    setRows(next);
    const obj: Record<string, unknown> = {};
    for (const [k, v] of next) if (k.trim()) obj[k.trim()] = v;
    onChange(obj);
  };
  return (
    <div>
      {rows.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <input className="input" placeholder="key" value={k} aria-label="Key" onChange={(e) => emit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          {allowExpr ? (
            <ExprInput value={v} onChange={(nv) => emit(rows.map((r, j) => (j === i ? [r[0], nv] : r)))} onFocusInsert={onFocusInsert} placeholder="value or {{ expression }}" ariaLabel={`Value for ${k || "key"}`} />
          ) : (
            <input className="input" value={v} aria-label={`Value for ${k || "key"}`} onChange={(e) => emit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          )}
          <button className="btn btn-ghost btn-icon" aria-label="Remove row" onClick={() => emit(rows.filter((_, j) => j !== i))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => emit([...rows, ["", ""]])}>
        <Plus size={14} /> Add field
      </button>
    </div>
  );
}

function ConditionsField({ value, onChange, onFocusInsert }: { value: unknown; onChange: (v: unknown) => void; onFocusInsert: (fn: Inserter) => void }) {
  const { catalog } = useSession();
  const rules = (Array.isArray(value) ? value : []) as Array<{ left: string; operator: string; right?: string }>;
  const ops = catalog?.conditionOperators ?? [];
  const set = (i: number, patch: Partial<{ left: string; operator: string; right: string }>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div>
      {rules.map((r, i) => {
        const unary = ops.find((o) => o.value === r.operator)?.unary;
        return (
          <div className="rule-row" key={i}>
            <div style={{ gridColumn: "1 / -1" }}>
              <ExprInput value={String(r.left ?? "")} onChange={(v) => set(i, { left: v })} onFocusInsert={onFocusInsert} placeholder="{{ steps.x.output.value }}" ariaLabel="Left value" />
            </div>
            <select className="input" value={r.operator} onChange={(e) => set(i, { operator: e.target.value })} aria-label="Operator">
              {ops.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {unary ? <span /> : <ExprInput value={String(r.right ?? "")} onChange={(v) => set(i, { right: v })} onFocusInsert={onFocusInsert} placeholder="value" ariaLabel="Right value" />}
            <div style={{ gridColumn: "1 / -1", textAlign: "right" }}>
              <button className="btn btn-ghost btn-sm" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                <Trash2 size={13} /> Remove
              </button>
            </div>
          </div>
        );
      })}
      <button className="btn btn-sm" onClick={() => onChange([...rules, { left: "", operator: "equals", right: "" }])}>
        <Plus size={14} /> Add condition
      </button>
    </div>
  );
}

function CasesField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const cases = (Array.isArray(value) ? value : []) as Array<{ branch: string; equals: string }>;
  return (
    <div>
      {cases.map((c, i) => (
        <div className="kv-row" key={i}>
          <input className="input mono" placeholder="branch name" value={c.branch} aria-label="Branch name" onChange={(e) => onChange(cases.map((x, j) => (j === i ? { ...x, branch: e.target.value.replace(/[^a-zA-Z0-9_-]/g, "") } : x)))} />
          <input className="input" placeholder="equals value" value={String(c.equals ?? "")} aria-label="Matches value" onChange={(e) => onChange(cases.map((x, j) => (j === i ? { ...x, equals: e.target.value } : x)))} />
          <button className="btn btn-ghost btn-icon" aria-label="Remove case" onClick={() => onChange(cases.filter((_, j) => j !== i))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => onChange([...cases, { branch: `case${cases.length + 1}`, equals: "" }])}>
        <Plus size={14} /> Add case
      </button>
      <div className="help">Unmatched values go to the "default" branch.</div>
    </div>
  );
}

const resourceCache = new Map<string, Promise<Array<{ id: string; name: string }>>>();
function useResource(kind: "table" | "workflow" | "mcp_server" | "form") {
  const [items, setItems] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    const url = { table: "/api/tables", workflow: "/api/workflows?limit=200", mcp_server: "/api/mcp-servers", form: "/api/forms" }[kind];
    if (!resourceCache.has(kind)) {
      resourceCache.set(
        kind,
        get<any>(url).then((r) => (Array.isArray(r) ? r : (r.items ?? r.servers ?? []))),
      );
      setTimeout(() => resourceCache.delete(kind), 5000);
    }
    void resourceCache.get(kind)!.then(setItems).catch(() => setItems([]));
  }, [kind]);
  return items;
}

function ResourceSelect({ kind, value, onChange, label }: { kind: "table" | "workflow" | "mcp_server" | "form"; value: unknown; onChange: (v: unknown) => void; label: string }) {
  const items = useResource(kind);
  return (
    <select className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value || undefined)} aria-label={label}>
      <option value="">Select…</option>
      {items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))}
      {value && !items.some((i) => i.id === value) ? <option value={String(value)}>{String(value)} (not found)</option> : null}
    </select>
  );
}

export function FieldInput({ field, value, onChange, onFocusInsert, error }: FieldProps) {
  const allowExpr = field.allowExpressions !== false;
  const [exprMode, setExprMode] = useState(() => isExpr(value) && ["number", "boolean", "select"].includes(field.type));
  const togglable = allowExpr && ["number", "boolean", "select"].includes(field.type);

  let input: React.ReactNode;
  if (exprMode) {
    input = <ExprInput value={String(value ?? "")} onChange={onChange} onFocusInsert={onFocusInsert} placeholder="{{ expression }}" ariaLabel={field.label} />;
  } else {
    switch (field.type) {
      case "string":
        input = allowExpr ? (
          <ExprInput value={String(value ?? "")} onChange={(v) => onChange(v)} onFocusInsert={onFocusInsert} placeholder={field.placeholder} ariaLabel={field.label} />
        ) : (
          <input className="input" value={String(value ?? "")} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} aria-label={field.label} />
        );
        break;
      case "text":
        input = <ExprInput value={String(value ?? "")} onChange={onChange} onFocusInsert={onFocusInsert} multiline placeholder={field.placeholder} ariaLabel={field.label} />;
        break;
      case "number":
        input = <input className="input" type="number" value={value === undefined || value === null ? "" : String(value)} min={field.min} max={field.max} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} aria-label={field.label} />;
        break;
      case "boolean":
        input = (
          <label className="checkbox">
            <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {field.label}
          </label>
        );
        break;
      case "select":
        input = (
          <select className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} aria-label={field.label}>
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
        break;
      case "json":
        input = <JsonField value={value} onChange={onChange} onFocusInsert={onFocusInsert} label={field.label} />;
        break;
      case "keyvalue":
        input = <KeyValueField value={value} onChange={onChange} onFocusInsert={onFocusInsert} allowExpr={allowExpr} />;
        break;
      case "string_list":
        input = (
          <textarea
            className="input"
            rows={3}
            aria-label={field.label}
            placeholder="One per line"
            value={Array.isArray(value) ? value.join("\n") : String(value ?? "")}
            onChange={(e) => onChange(e.target.value.split("\n").map((s) => s.trim()).filter((s, i, a) => s !== "" || i < a.length - 1))}
          />
        );
        break;
      case "conditions":
        input = <ConditionsField value={value} onChange={onChange} onFocusInsert={onFocusInsert} />;
        break;
      case "cases":
        input = <CasesField value={value} onChange={onChange} />;
        break;
      case "table":
      case "workflow":
      case "mcp_server":
      case "form":
        input = <ResourceSelect kind={field.type} value={value} onChange={onChange} label={field.label} />;
        break;
      default:
        input = <input className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} aria-label={field.label} />;
    }
  }

  return (
    <div className="field">
      {field.type !== "boolean" || exprMode ? (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <label>
            {field.label}
            {field.required && <span style={{ color: "var(--danger)" }}> *</span>}
          </label>
          {togglable && (
            <button className={`btn btn-ghost btn-sm ${exprMode ? "" : ""}`} title="Use an expression" aria-pressed={exprMode} onClick={() => setExprMode(!exprMode)}>
              <Braces size={13} /> {exprMode ? "fixed" : "fx"}
            </button>
          )}
        </div>
      ) : null}
      {input}
      {field.description && <div className="help">{field.description}</div>}
      {error && <div className="help" style={{ color: "var(--danger)" }}>{error}</div>}
    </div>
  );
}
