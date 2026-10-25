import {
  Activity,
  AlertOctagon,
  BarChart3,
  Bot,
  CheckSquare,
  ClipboardList,
  Database,
  FileText,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Mail,
  Plug,
  Puzzle,
  Settings,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { get, post } from "./api";
import { AuthPage } from "./pages/auth";
import { ConnectionsPage } from "./pages/connections";
import { DashboardPage } from "./pages/dashboard";
import { ExecutionDetailPage, ExecutionsPage } from "./pages/executions";
import { ApprovalsPage, OutboxPage } from "./pages/approvals";
import { FormsPage, PublicFormPage } from "./pages/forms";
import { IntegrationsPage } from "./pages/integrations";
import { AiPage, McpPage } from "./pages/ai-mcp";
import { SettingsPage, TeamPage, UsagePage } from "./pages/admin";
import { TableDetailPage, TablesPage } from "./pages/tables";
import { TemplatesPage } from "./pages/templates";
import { WorkflowsPage } from "./pages/workflows";
import { WorkflowEditor } from "./editor/editor";
import { Link, match, useRouter } from "./router";
import { useSession } from "./session";
import { Loading, useAsync } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  count?: number;
}

function NavLink({ item }: { item: NavItem }) {
  const { path } = useRouter();
  const active = item.to === "/" ? path === "/" : path === item.to || path.startsWith(`${item.to}/`);
  return (
    <Link to={item.to} className={active ? "active" : ""}>
      {item.icon}
      {item.label}
      {item.count ? <span className="count">{item.count}</span> : null}
    </Link>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { me, refresh } = useSession();
  const { navigate } = useRouter();
  const approvals = useAsync(() => get<unknown[]>("/api/approvals"), [me?.workspace.id]);
  const s = 17;
  const groups: Array<{ title?: string; items: NavItem[] }> = [
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
        { to: "/approvals", label: "Approvals", icon: <CheckSquare size={s} />, count: approvals.data?.length },
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
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Zap size={16} fill="currentColor" />
          </span>
          {me?.brandName}
        </div>
        <nav className="nav" aria-label="Main">
          {groups.map((g, i) => (
            <div key={i} style={{ display: "contents" }}>
              {g.title && <div className="nav-section">{g.title}</div>}
              {g.items.map((item) => (
                <NavLink key={item.to} item={item} />
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot stack" style={{ gap: 8 }}>
          {me && me.workspaces.length > 1 && (
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
          <div className="row" style={{ gap: 8 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="truncate" style={{ fontWeight: 600 }}>
                {me?.user.name}
              </div>
              <div className="faint truncate">
                {me?.workspace.name} · {me?.role}
              </div>
            </div>
            <button
              className="btn btn-ghost btn-icon"
              title="Sign out"
              aria-label="Sign out"
              onClick={async () => {
                await post("/api/auth/logout");
                await refresh();
                navigate("/login");
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

const ROUTES: Array<[string, (p: Record<string, string>) => ReactNode]> = [
  ["/", () => <DashboardPage />],
  ["/workflows", () => <WorkflowsPage />],
  ["/workflows/:id", (p) => <WorkflowEditor id={p.id!} />],
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

  const formMatch = match("/f/:slug", path);
  if (formMatch) return <PublicFormPage slug={formMatch.slug!} />;
  if (loading) return <Loading />;
  if (!me) return <AuthPage mode={path === "/register" ? "register" : "login"} />;

  for (const [pattern, render] of ROUTES) {
    const params = match(pattern, path);
    if (params) {
      // The editor uses the full main area.
      return <Shell>{render(params)}</Shell>;
    }
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
