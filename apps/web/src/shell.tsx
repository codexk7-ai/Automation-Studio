import { CornerDownLeft, FileText, Laptop, Moon, Plus, Search, Sun, Workflow as WorkflowIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get } from "./api";
import { useRouter } from "./router";

// ---------------------------------------------------------------------------
// Theme (system / light / dark), remembered per browser.

export type ThemeChoice = "system" | "light" | "dark";

function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem("as-theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

/** Applies the saved theme before the first render (no flash of the wrong theme). */
export function initTheme() {
  applyTheme(readTheme());
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const set = useCallback((t: ThemeChoice) => {
    setTheme(t);
    try {
      localStorage.setItem("as-theme", t);
    } catch {
      /* storage unavailable: theme still applies for this visit */
    }
  }, []);
  return [theme, set];
}

export function ThemeSwitch({ theme, onChange }: { theme: ThemeChoice; onChange: (t: ThemeChoice) => void }) {
  const opts: Array<[ThemeChoice, ReactNode, string]> = [
    ["light", <Sun size={14} key="l" />, "Light theme"],
    ["system", <Laptop size={14} key="s" />, "System theme"],
    ["dark", <Moon size={14} key="d" />, "Dark theme"],
  ];
  return (
    <div className="segmented" role="group" aria-label="Theme">
      {opts.map(([v, icon, label]) => (
        <button key={v} aria-pressed={theme === v} title={label} aria-label={label} onClick={() => onChange(v)}>
          {icon}
        </button>
      ))}
    </div>
  );
}

export function usePersistentFlag(key: string, initial = false): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(key) === "1" ? true : localStorage.getItem(key) === "0" ? false : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: boolean) => {
    setV(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  return [v, set];
}

// ---------------------------------------------------------------------------
// Command palette (Ctrl/Cmd + K)

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  icon: ReactNode;
  hint?: string;
  run: () => void;
}

export function CommandPalette({ open, onClose, pages }: { open: boolean; onClose: () => void; pages: Array<{ to: string; label: string; icon: ReactNode }> }) {
  const { navigate } = useRouter();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [tables, setTables] = useState<Array<{ id: string; name: string }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    setTimeout(() => inputRef.current?.focus(), 10);
    void get<{ items: Array<{ id: string; name: string }> }>("/api/workflows?limit=100")
      .then((r) => setWorkflows(r.items))
      .catch(() => setWorkflows([]));
    void get<Array<{ id: string; name: string }>>("/api/tables")
      .then(setTables)
      .catch(() => setTables([]));
  }, [open]);

  const go = useCallback(
    (to: string) => {
      onClose();
      navigate(to);
    },
    [navigate, onClose],
  );

  const commands = useMemo<PaletteCommand[]>(() => {
    const all: PaletteCommand[] = [
      { id: "new-wf", label: "Create workflow", group: "Actions", icon: <Plus size={16} />, run: () => go("/workflows?new=1") },
      { id: "tpl", label: "Start from a template", group: "Actions", icon: <FileText size={16} />, run: () => go("/templates") },
      ...pages.map((p) => ({ id: `page:${p.to}`, label: p.label, group: "Go to", icon: p.icon, hint: "page", run: () => go(p.to) })),
      ...workflows.map((w) => ({ id: `wf:${w.id}`, label: w.name, group: "Workflows", icon: <WorkflowIcon size={16} />, hint: "workflow", run: () => go(`/workflows/${w.id}`) })),
      ...tables.map((t) => ({ id: `tbl:${t.id}`, label: t.name, group: "Tables", icon: <FileText size={16} />, hint: "table", run: () => go(`/tables/${t.id}`) })),
    ];
    const needle = q.trim().toLowerCase();
    if (!needle) return all.filter((c) => c.group !== "Workflows" || all.indexOf(c) < pages.length + 8).slice(0, 40);
    return all.filter((c) => c.label.toLowerCase().includes(needle)).slice(0, 40);
  }, [q, pages, workflows, tables, go]);

  useEffect(() => setActive(0), [q]);
  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(commands.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commands[active]?.run();
    } else if (e.key === "Escape") onClose();
  };

  let lastGroup = "";
  return (
    <div className="modal-backdrop cmdk-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-input">
          <Search size={18} color="var(--text-3)" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search pages, workflows, tables, actions…" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="cmdk-list" />
          <span className="kbd">esc</span>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox">
          {commands.length === 0 && <div className="faint" style={{ padding: 16 }}>No results for "{q}".</div>}
          {commands.map((c, i) => {
            const header = c.group !== lastGroup ? <div className="cmdk-group">{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header}
                <button className="cmdk-item" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={c.run}>
                  {c.icon}
                  <span className="truncate">{c.label}</span>
                  {i === active ? <CornerDownLeft size={14} className="hint" /> : c.hint ? <span className="hint">{c.hint}</span> : null}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
