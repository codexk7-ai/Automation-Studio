import { roleAtLeast, type Role } from "@automation-studio/core";
import { forbidden } from "../errors.ts";

export type ApiScope = "read" | "write" | "execute" | "admin";
export const API_SCOPES: ApiScope[] = ["read", "write", "execute", "admin"];

/** The authenticated actor for a request, always bound to one workspace. */
export interface Principal {
  actorType: "user" | "api_token" | "system";
  userId: string | null;
  workspaceId: string;
  role: Role;
  /** API tokens carry scopes; sessions have all scopes permitted by the role. */
  scopes?: ApiScope[];
  tokenId?: string;
  ip?: string;
}

export function requireRole(p: Principal, role: Role): void {
  if (!roleAtLeast(p.role, role)) throw forbidden(`This action requires the ${role} role.`);
}

export function requireScope(p: Principal, scope: ApiScope): void {
  if (p.actorType === "api_token" && !p.scopes?.includes(scope) && !p.scopes?.includes("admin")) {
    throw forbidden(`This API token is missing the '${scope}' scope.`);
  }
}

/** Combined check used by every mutating route. */
export function authorize(p: Principal, role: Role, scope: ApiScope): void {
  requireScope(p, scope);
  requireRole(p, role);
}

export function systemPrincipal(workspaceId: string): Principal {
  return { actorType: "system", userId: null, workspaceId, role: "owner" };
}
