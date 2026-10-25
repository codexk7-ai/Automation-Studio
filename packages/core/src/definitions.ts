/**
 * Serializable metadata describing node types. The server owns the executable
 * handlers; this metadata is shared with the editor to render forms and run
 * client-side validation.
 */

export type FieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "json"
  | "keyvalue"
  | "string_list"
  | "conditions"
  | "cases"
  | "table"
  | "workflow"
  | "mcp_server"
  | "form";

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  description?: string;
  placeholder?: string;
  default?: unknown;
  options?: FieldOption[];
  /** Whether `{{ }}` expressions are accepted. Defaults to true for string-like fields. */
  allowExpressions?: boolean;
  min?: number;
  max?: number;
  /** Only show this field when another field has one of these values. */
  showWhen?: { key: string; equals: unknown[] };
  /** Never echo the value back in logs or previews. */
  sensitive?: boolean;
}

export type NodeKind = "trigger" | "action" | "logic" | "ai" | "data";

export interface NodeTypeDefinition {
  /** Stable identifier, e.g. "http.request". */
  type: string;
  integration: string;
  kind: NodeKind;
  name: string;
  description: string;
  fields: FieldSpec[];
  /** Named output branches. Nodes without branches have a single default output. */
  branches?: string[];
  /** Branches are computed from config (e.g. switch cases). */
  dynamicBranches?: boolean;
  /** Example output used for mapping hints in the editor and in test mode. */
  sampleOutput?: unknown;
  outputDescription?: string;
  /** Credential type required (matches a credential provider id). */
  credentialType?: string;
  credentialRequired?: boolean;
  /** Side effects visible outside the platform (sending messages, writing to SaaS). */
  sideEffects?: "none" | "internal" | "external";
  /** Minimum project role required to place this node in a workflow. */
  minRole?: Role;
  /** Can be run as a single node test from the editor. */
  testable?: boolean;
  /** "live" integrations call a real API; "mock" adapters are clearly labelled simulations. */
  mode?: "live" | "local" | "mock";
}

export interface IntegrationDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  icon: string;
  credentialTypes: string[];
  docsUrl?: string;
  /** Prerequisites such as accounts, verification, quotas or fees. */
  prerequisites: string[];
  /** Live, local (no external account needed) or mock. */
  availability: "local" | "live" | "live+mock";
  scopes?: string[];
  rateLimits?: string;
}

export const ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

export interface CredentialTypeDefinition {
  id: string;
  name: string;
  description: string;
  /** Fields stored encrypted. */
  fields: FieldSpec[];
  /** OAuth2 support. */
  oauth2?: {
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    /** Extra authorize parameters (e.g. access_type=offline). */
    extraParams?: Record<string, string>;
  };
  docsUrl?: string;
}
