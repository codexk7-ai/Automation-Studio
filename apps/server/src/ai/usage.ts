import type { AppContext } from "../context.ts";
import { StepError } from "../errors.ts";
import type { AiProvider, CompletionResult } from "./providers.ts";

/** Rejects AI calls once the workspace's monthly token budget is spent. */
export async function assertBudget(app: AppContext, workspaceId: string): Promise<void> {
  const ws = await app.db.one<{ settings: { aiMonthlyTokenBudget?: number } }>("SELECT settings FROM workspaces WHERE id = $1", [workspaceId]);
  const budget = Number(ws?.settings?.aiMonthlyTokenBudget ?? 0);
  if (!budget) return;
  const used = await app.db.one<{ n: number }>(
    "SELECT COALESCE(sum(input_tokens + output_tokens), 0)::int AS n FROM ai_usage WHERE workspace_id = $1 AND created_at >= date_trunc('month', now())",
    [workspaceId],
  );
  if ((used?.n ?? 0) >= budget) throw new StepError("permanent", `The workspace's monthly AI token budget (${budget.toLocaleString()} tokens) is used up. An admin can raise it in Settings → AI.`);
}

export async function recordUsage(app: AppContext, provider: AiProvider, result: CompletionResult, ctx: { workspaceId: string; executionId?: string; nodeId?: string }): Promise<number | null> {
  const price = provider.pricing(result.model);
  const cost = price ? (result.usage.inputTokens * price.input + result.usage.outputTokens * price.output) / 1_000_000 : null;
  await app.db.query(
    "INSERT INTO ai_usage (workspace_id, execution_id, node_id, provider, model, input_tokens, output_tokens, estimated_cost_usd) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [ctx.workspaceId, ctx.executionId ?? null, ctx.nodeId ?? null, provider.kind, result.model, result.usage.inputTokens, result.usage.outputTokens, cost],
  );
  return cost;
}
