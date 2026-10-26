import {
  Activity,
  AlertOctagon,
  BarChart3,
  Bell,
  Bot,
  CheckSquare,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  Database,
  FileText,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Mail,
  Menu,
  Plug,
  Puzzle,
  Search,
  Settings,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { get, post } from "./api";
import { WorkflowEditor } from "./editor/editor";
import { SettingsPage, TeamPage, UsagePage } from "./pages/admin";
import { AiPage, McpPage } from "./pages/ai-mcp";
import { ApprovalsPage, OutboxPage } from "./pages/approvals";
import { AuthPage } from "./pages/auth";
import { ConnectionsPage } from "./pages/connections";
import { DashboardPage } from "./pages/dashboard";
import { ExecutionDetailPage, ExecutionsPage } from "./pages/executions";
import { FormsPage, PublicFormPage } from "./pages/forms";
import { IntegrationsPage } from "./pages/integrations";
import { TableDetailPage, TablesPage } from "./pages/tables";
import { TemplatesPage } from "./pages/templates";
import { TwoFactorRequiredPage } from "./pages/two-factor";
import { WorkflowsPage } from "./pages/workflows";
import { Link, match, useRouter } from "./router";
import { useSession } from "./session";
import { CommandPalette, ThemeSwitch, useTheme, usePersistentFlag } from "./shell";
import { Loading, useAsync } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  count?: number;
}

const s = 18;
const NAV: Array<{ title?: string; items: NavItem[] }> = [
  {
    items: [
      { to: "/", label: "Dashboard", icon: <LayoutDashboard size={s} /> },
      { to: "/workflows", label: "Workflows", icon: <Workflow size={s} /> },
      { to: "/templates", label: "Templates", icon: <LayoutTemplate size={s} /> },
    ],
  },
  {
    title: "Runs",
    items: [
      { to: "/executions", label: "Executions", icon: <Activity size={s} /> },
      { to: "/executions/failed", label: "Failed", icon: <AlertOctagon size={s} /> },
      { to: "/approvals", label: "Approvals", icon: <CheckSquare size={s} /> },
      { to: "/outbox", label: "Email outbox", icon: <Mail size={s} /> },
    ],
  },
  {
    title: "Connect",
    items: [
      { to: "/integrations", label: "Integrations", icon: <Puzzle size={s} /> },
      { to: "/connections", label: "Connections", icon: <KeyRound size={s} /> },
      { to: "/ai", label: "AI models", icon: <Bot size={s} /> },
      { to: "/mcp-servers", label: "MCP servers", icon: <Plug size={s} /> },
    ],
  },
  {
    title: "Data",
    items: [
      { to: "/tables", label: "Tables", icon: <Database size={s} /> },
      { to: "/forms", label: "Forms", icon: <FileText size={s} /> },
    ],
  },
  {
    title: "Workspace",
    items: [
      { to: "/usage", label: "Usage", icon: <BarChart3 size={s} /> },
      { to: "/team", label: "Team & API", icon: <Users size={s} /> },
      { to: "/settings", label: "Settings", icon: <Settings size={s} /> },
    ],
  },
];
const ALL_ITEMS = NAV.flatMap((g) => g.items);

/** The nav item that best matches the path (longest prefix wins). */
function activeItem(path: string): NavItem | undefined {
  return ALL_ITEMS.filter((i) => (i.to === "/" ? path === "/" : path === i.to || path.startsWith(`${i.to}/`))).sort((a, b) => b.to.length - a.to.length)[0];
}

function Shell({ children, bare }: { children: ReactNode; bare?: boolean }) {
  const { me, refresh } = useSession();
  const { navigate, path } = useRouter();
  const [theme, setTheme] = useTheme();
  const [collapsed, setCollapsed] = usePersistentFlag("as-sidebar-collapsed");
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  useEffect(() => setMobileNav(false), [path]);
  const menuRef = useRef<HTMLDivElement>(null);
  const approvals = useAsync(() => get<unknown[]>("/api/approvals"), [me?.workspace.id, path]);
  const pending = approvals.data?.length ?? 0;
  const current = activeItem(path);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, []);

  const initials = (me?.user.name ?? "?")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const signOut = async () => {
    await post("/api/auth/logout");
    await refresh();
    navigate("/login");
  };

  return (
    <div className={`app ${collapsed ? "collapsed" : ""} ${mobileNav ? "nav-open" : ""}`}>
      {mobileNav && <div className="nav-backdrop" onClick={() => setMobileNav(false)} aria-hidden="true" />}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Zap size={17} fill="currentColor" />
          </span>
          <span className="brand-name truncate">{me?.brandName}</span>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map((g, i) => (
            <div key={i} style={{ display: "contents" }}>
              {g.title && <div className="nav-section">{g.title}</div>}
              {g.items.map((item) => (
                <Link key={item.to} to={item.to} className={current?.to === item.to ? "active" : ""} title={collapsed ? item.label : undefined}>
                  {item.icon}
                  <span className="nav-label">{item.label}</span>
                  {item.to === "/approvals" && pending ? <span className="count">{pending}</span> : null}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot stack" style={{ gap: 10 }}>
          {me && me.workspaces.length > 1 && !collapsed && (
            <select
              className="input"
              aria-label="Workspace"
              value={me.workspace.id}
              onChange={async (e) => {
                await post("/api/auth/switch-workspace", { workspaceId: e.target.value });
                await refresh();
                navigate("/");
              }}
            >
              {me.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          <button className="icon-btn" style={{ width: "100%" }} onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
          </button>
        </div>
      </aside>
      <main className="main">
        {!bare && (
          <header className="topbar">
            <button className="icon-btn mobile-only" aria-label="Open navigation" aria-expanded={mobileNav} onClick={() => setMobileNav(true)}>
              <Menu size={19} />
            </button>
            <div className="crumbs truncate">
              <span>{me?.workspace.name}</span>
              <span>/</span>
              <b>{current?.label ?? "Page"}</b>
            </div>
            <span className="spacer" />
            <button className="search-trigger" onClick={() => setPalette(true)} aria-label="Search (Ctrl+K)">
              <Search size={15} />
              <span className="label-text">Search or jump to…</span>
              <span className="kbd">Ctrl K</span>
            </button>
            <ThemeSwitch theme={theme} onChange={setTheme} />
            <button className="icon-btn" aria-label={`Approvals${pending ? ` (${pending} pending)` : ""}`} title="Approvals" onClick={() => navigate("/approvals")}>
              <Bell size={18} />
              {pending ? <span className="pip" /> : null}
            </button>
            <div style={{ position: "relative" }} ref={menuRef}>
              <button className="icon-btn" style={{ width: "auto", padding: 2 }} aria-label="Account menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                <span className="avatar">{initials}</span>
              </button>
              {menu && (
                <div className="menu" role="menu">
                  <div style={{ padding: "8px 10px" }}>
                    <div style={{ fontWeight: 650 }}>{me?.user.name}</div>
                    <div className="faint truncate">{me?.user.email}</div>
                    <div className="faint">
                      {me?.workspace.name} · {me?.role}
                    </div>
                  </div>
                  <hr />
                  <button role="menuitem" onClick={() => (setMenu(false), navigate("/settings"))}>
                    <Settings size={15} /> Account & settings
                  </button>
                  <button role="menuitem" onClick={() => (setMenu(false), navigate("/team"))}>
                    <Users size={15} /> Team & API tokens
                  </button>
                  <hr />
                  <button role="menuitem" onClick={signOut}>
                    <LogOut size={15} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </header>
        )}
        {children}
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)} pages={ALL_ITEMS} />
    </div>
  );
}

const ROUTES: Array<[string, (p: Record<string, string>) => ReactNode, boolean?]> = [
  ["/", () => <DashboardPage />],
  ["/workflows", () => <WorkflowsPage />],
  ["/workflows/:id", (p) => <WorkflowEditor id={p.id!} />, true],
  ["/templates", () => <TemplatesPage />],
  ["/executions", () => <ExecutionsPage />],
  ["/executions/failed", () => <ExecutionsPage failedOnly />],
  ["/executions/:id", (p) => <ExecutionDetailPage id={p.id!} />],
  ["/approvals", () => <ApprovalsPage />],
  ["/outbox", () => <OutboxPage />],
  ["/integrations", () => <IntegrationsPage />],
  ["/connections", () => <ConnectionsPage />],
  ["/ai", () => <AiPage />],
  ["/mcp-servers", () => <McpPage />],
  ["/tables", () => <TablesPage />],
  ["/tables/:id", (p) => <TableDetailPage id={p.id!} />],
  ["/forms", () => <FormsPage />],
  ["/usage", () => <UsagePage />],
  ["/team", () => <TeamPage />],
  ["/settings", () => <SettingsPage />],
];

export function App() {
  const { path } = useRouter();
  const { me, loading } = useSession();
  useTheme(); // apply the saved theme on every screen, including sign-in

  const formMatch = match("/f/:slug", path);
  if (formMatch) return <PublicFormPage slug={formMatch.slug!} />;
  if (loading) return <Loading />;
  if (!me) return <AuthPage mode={path === "/register" ? "register" : "login"} />;
  if (me.require2fa && !me.totpEnabled) return <TwoFactorRequiredPage />;

  for (const [pattern, render, bare] of ROUTES) {
    const params = match(pattern, path);
    if (params) return <Shell bare={bare}>{render(params)}</Shell>;
  }
  return (
    <Shell>
      <div className="page">
        <div className="empty">
          <ClipboardList size={32} />
          <h3>Page not found</h3>
          <Link to="/">Back to dashboard</Link>
        </div>
      </div>
    </Shell>
  );
}
