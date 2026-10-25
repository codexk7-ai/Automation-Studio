import type { CredentialTypeDefinition, ExpressionScope, IntegrationDefinition, NodeTypeDefinition, WorkflowNode } from "@automation-studio/core";
import type { AppContext } from "../context.ts";

export interface LoadedCredential {
  id: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
}

export type StepResult =
  | { output: unknown; branch?: string; stop?: boolean }
  | { wait: { until?: string; reason: string; state?: unknown } };

export interface StepContext {
  app: AppContext;
  workspaceId: string;
  projectId: string;
  workflowId: string;
  executionId: string;
  nodeId: string;
  node: WorkflowNode;
  /** Node config with defaults applied and templates rendered (except `rawFields`). */
  config: Record<string, unknown>;
  /** Unrendered config, for fields rendered per item. */
  rawConfig: Record<string, unknown>;
  scope: ExpressionScope;
  credential?: LoadedCredential;
  /** Simulate external side effects (test runs). */
  useMocks: boolean;
  attempt: number;
  signal: AbortSignal;
  /** Stable per execution+node; send to providers that support idempotency keys. */
  idempotencyKey: string;
  /** State persisted when the node previously returned `wait`. */
  waitState?: unknown;
  /** Sub-workflow nesting depth of this execution. */
  depth: number;
  /** Renders a template with additional scope (e.g. `item`, `index`). */
  render(value: unknown, extra?: Partial<ExpressionScope>): unknown;
  log(message: string, data?: Record<string, unknown>): void;
  /** Runs another workflow of the same workspace synchronously and returns its final step outputs. */
  runSubworkflow(workflowId: string, input: unknown): Promise<SubworkflowResult>;
}

export interface SubworkflowResult {
  executionId: string;
  status: string;
  output: unknown;
  error?: unknown;
}

export interface NodeImplementation extends NodeTypeDefinition {
  /** Config keys left unrendered so the handler can render them per item. */
  rawFields?: string[];
  /** Default step timeout in ms. */
  defaultTimeoutMs?: number;
  execute(ctx: StepContext): Promise<StepResult>;
  /** Called while the step is waiting; return null to keep waiting. */
  resume?(ctx: StepContext): Promise<StepResult | null>;
  /** Simulated behaviour for test runs / missing credentials. Must label its output with `_mock: true`. */
  mock?(ctx: StepContext): Promise<StepResult>;
  /** Event-driven triggers: internal event types this trigger listens to. */
  events?: string[];
  /** Whether an event matches this trigger's (published) configuration. */
  matchEvent?(config: Record<string, unknown>, eventType: string, payload: Record<string, unknown>, meta: EventMeta): boolean;
  /** Polling triggers: fetch new items since the stored state. */
  poll?(ctx: PollContext): Promise<PollResult>;
}

export interface EventMeta {
  credentialId?: string;
}

export interface PollContext {
  app: AppContext;
  workspaceId: string;
  workflowId: string;
  config: Record<string, unknown>;
  credential?: LoadedCredential;
  /** Persisted between polls (cursor, seen IDs). */
  state: Record<string, unknown>;
  signal: AbortSignal;
}

export interface PollResult {
  /** Each item starts one execution; `dedupeKey` prevents double-processing. */
  items: Array<{ data: unknown; dedupeKey: string }>;
  state: Record<string, unknown>;
}

export interface CredentialTypeImplementation extends CredentialTypeDefinition {
  /** Verifies a credential against the provider (cheap read-only call). */
  test?(data: Record<string, unknown>, app: AppContext): Promise<{ ok: boolean; message: string }>;
  /** Refreshes OAuth tokens; returns the updated data or null if not needed. */
  refresh?(data: Record<string, unknown>, app: AppContext): Promise<Record<string, unknown> | null>;
  /** Builds the account label shown in the UI after OAuth (non-secret). */
  describe?(data: Record<string, unknown>): Record<string, unknown>;
}

export interface IntegrationModule {
  definition: IntegrationDefinition;
  nodes: NodeImplementation[];
  credentialTypes?: CredentialTypeImplementation[];
}
