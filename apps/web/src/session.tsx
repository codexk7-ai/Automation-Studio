import type { ConditionOperator, CredentialTypeDefinition, IntegrationDefinition, NodeTypeDefinition, Role } from "@automation-studio/core";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { get, setCsrf, setUnauthorizedHandler } from "./api";

export interface Me {
  user: { id: string; email: string; name: string };
  workspace: { id: string; name: string; settings: Record<string, unknown> };
  role: Role;
  workspaces: Array<{ id: string; name: string; role: Role }>;
  projects: Array<{ id: string; name: string }>;
  csrfToken: string | null;
  brandName: string;
  totpEnabled: boolean;
  recoveryCodesLeft: number;
  require2fa: boolean;
}

export interface Catalog {
  integrations: Array<IntegrationDefinition & { nodeCount: number }>;
  nodes: NodeTypeDefinition[];
  credentialTypes: Array<CredentialTypeDefinition & { oauthAvailable: boolean }>;
  expressionFunctions: string[];
  conditionOperators: Array<{ value: ConditionOperator; label: string; unary: boolean }>;
}

interface SessionState {
  me: Me | null;
  catalog: Catalog | null;
  loading: boolean;
  refresh(): Promise<void>;
  can(role: Role): boolean;
}

const SessionContext = createContext<SessionState>({ me: null, catalog: null, loading: true, refresh: async () => undefined, can: () => false });
const ORDER: Role[] = ["viewer", "editor", "admin", "owner"];

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const m = await get<Me>("/api/auth/me");
      setCsrf(m.csrfToken);
      setMe(m);
      document.title = m.brandName;
      // The catalog can be unavailable (e.g. 2FA enrollment gate) without ending the session.
      setCatalog(await get<Catalog>("/api/catalog").catch(() => null));
    } catch {
      setMe(null);
      setCsrf(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    void refresh();
  }, [refresh]);
  const can = useCallback((role: Role) => !!me && ORDER.indexOf(me.role) >= ORDER.indexOf(role), [me]);
  return <SessionContext.Provider value={{ me, catalog, loading, refresh, can }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

export function nodeDef(catalog: Catalog | null, type: string): NodeTypeDefinition | undefined {
  return catalog?.nodes.find((n) => n.type === type);
}
