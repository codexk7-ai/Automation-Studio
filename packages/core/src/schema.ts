import { z } from "zod";

/**
 * Versioned workflow definition. Execution order is derived exclusively from
 * `edges`; `position` is editor metadata and never influences execution.
 */
export const WORKFLOW_SCHEMA_VERSION = 1 as const;

export const NODE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(1),
  backoffMs: z.number().int().min(0).max(3_600_000).default(1000),
  backoffMultiplier: z.number().min(1).max(10).default(2),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const nodeSchema = z.object({
  id: z.string().regex(NODE_ID_PATTERN, "Node IDs must start with a letter and contain only letters, digits and underscores (max 64)."),
  type: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()).default({}),
  credentialId: z.string().max(64).nullish(),
  retry: retryPolicySchema.optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  onError: z.enum(["fail", "continue"]).default("fail"),
  disabled: z.boolean().default(false),
  notes: z.string().max(4000).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});
export type WorkflowNode = z.infer<typeof nodeSchema>;

export const edgeSchema = z.object({
  id: z.string().min(1).max(128),
  source: z.string().min(1),
  target: z.string().min(1),
  /** Named output branch of the source node (e.g. "true"/"false" for conditions). */
  branch: z.string().max(64).nullish(),
});
export type WorkflowEdge = z.infer<typeof edgeSchema>;

export const workflowSettingsSchema = z.object({
  timeoutMs: z.number().int().min(1000).max(86_400_000).default(300_000),
  maxStepExecutions: z.number().int().min(1).max(10_000).default(1000),
  /** Whether the same trigger event (by dedupe key) may start more than one execution. */
  dedupeWindowSeconds: z.number().int().min(0).max(604_800).default(86_400),
  errorNotificationEmail: z.string().email().nullish(),
});
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

export const workflowDefinitionSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  nodes: z.array(nodeSchema).min(1).max(500),
  edges: z.array(edgeSchema).max(2000).default([]),
  settings: workflowSettingsSchema.default(workflowSettingsSchema.parse({})),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowDefinitionInput = z.input<typeof workflowDefinitionSchema>;

/** Portable export format (import/export as JSON). */
export const workflowExportSchema = z.object({
  format: z.literal("automation-studio.workflow"),
  formatVersion: z.literal(1),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(""),
  definition: workflowDefinitionSchema,
});
export type WorkflowExport = z.infer<typeof workflowExportSchema>;

export const WORKFLOW_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const EXECUTION_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const STEP_STATUSES = [
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export function parseWorkflowDefinition(input: unknown): WorkflowDefinition {
  return workflowDefinitionSchema.parse(input);
}

export function isTriggerType(type: string): boolean {
  return type.startsWith("trigger.");
}
