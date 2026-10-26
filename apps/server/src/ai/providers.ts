import Anthropic from "@anthropic-ai/sdk";
import { toText } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { errorKindForStatus, StepError } from "../errors.ts";
import type { LoadedCredential } from "../integrations/types.ts";
import { safeRequest } from "../security/ssrf.ts";

/**
 * Provider abstraction for AI nodes. All model output is treated as
 * untrusted: callers validate structured output and tool arguments before
 * acting on them.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  stopReason: string;
}

export interface CompletionRequest {
  system?: string;
  prompt: string;
  /** JSON schema the response must follow. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  model?: string;
  signal?: AbortSignal;
}

export interface Conversation {
  send(input: { userText?: string; toolResults?: Array<{ id: string; content: string; isError?: boolean }> }, signal?: AbortSignal): Promise<CompletionResult>;
}

export interface AiProvider {
  /** "anthropic" | "openai_compatible" | "mock" */
  kind: string;
  defaultModel: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  conversation(opts: { system: string; tools: ToolSpec[]; maxTokens?: number; effort?: CompletionRequest["effort"]; model?: string }): Conversation;
  /** USD per 1M tokens when known. */
  pricing(model: string): { input: number; output: number } | null;
}

// ---------------------------------------------------------------------------
// Anthropic (official SDK)

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
const ANTHROPIC_PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

function anthropicError(err: unknown): StepError {
  if (err instanceof Anthropic.RateLimitError) return new StepError("rate_limit", `Anthropic: rate limited`, {}, Number(err.headers?.get?.("retry-after")) * 1000 || undefined);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new StepError("auth", `Anthropic: ${err.message}`);
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) return new StepError("permanent", `Anthropic: ${err.message}`);
  if (err instanceof Anthropic.APIError) return new StepError(err.status ? errorKindForStatus(err.status) : "transient", `Anthropic: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new StepError("transient", `Anthropic: connection error`);
  return err instanceof StepError ? err : new StepError("permanent", (err as Error).message);
}

class AnthropicProvider implements AiProvider {
  kind = "anthropic";
  private readonly client: Anthropic;

  constructor(
    app: AppContext,
    apiKey: string,
    readonly defaultModel: string,
  ) {
    // Only the workspace's own key is used: never ambient ANTHROPIC_* environment credentials or base URLs
    // of the server process. All traffic goes through the SSRF-guarded fetch.
    this.client = new Anthropic({ apiKey, authToken: null, baseURL: "https://api.anthropic.com", fetch: app.fetch as unknown as typeof fetch, maxRetries: 1, timeout: 120_000 });
  }

  pricing(model: string) {
    return ANTHROPIC_PRICING[model] ?? null;
  }

  private async create(params: { model: string; system?: string; messages: Anthropic.Beta.BetaMessageParam[]; tools?: ToolSpec[]; maxTokens: number; effort: string; jsonSchema?: Record<string, unknown> }, signal?: AbortSignal) {
    try {
      const response = await this.client.beta.messages.create(
        {
          model: params.model,
          max_tokens: params.maxTokens,
          system: params.system,
          messages: params.messages,
          // Server-side refusal fallback: a policy decline is retried on a fallback model inside the same call.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: {
            effort: params.effort as "low" | "medium" | "high",
            ...(params.jsonSchema ? { format: { type: "json_schema" as const, schema: params.jsonSchema } } : {}),
          },
          tools: params.tools?.map((t) => ({ name: t.name, description: t.description.slice(0, 1024), input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema })),
        },
        { signal },
      );
      return response;
    } catch (err) {
      throw anthropicError(err);
    }
  }

  private toResult(response: Anthropic.Beta.BetaMessage): CompletionResult {
    if (response.stop_reason === "refusal") throw new StepError("permanent", "The model declined this request.");
    const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    const toolCalls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
    return { text, toolCalls, usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }, model: response.model, stopReason: response.stop_reason ?? "end_turn" };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const response = await this.create(
      { model: req.model || this.defaultModel, system: req.system, messages: [{ role: "user", content: req.prompt }], maxTokens: req.maxTokens ?? 16000, effort: req.effort ?? "medium", jsonSchema: req.jsonSchema },
      req.signal,
    );
    return this.toResult(response);
  }

  conversation(opts: { system: string; tools: ToolSpec[]; maxTokens?: number; effort?: CompletionRequest["effort"]; model?: string }): Conversation {
    // Append-only history; assistant content is echoed back unchanged (including thinking blocks).
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    return {
      send: async (input, signal) => {
        if (input.toolResults?.length) {
          messages.push({ role: "user", content: input.toolResults.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.isError === true })) });
        } else {
          messages.push({ role: "user", content: input.userText ?? "" });
        }
        const response = await this.create({ model: opts.model || this.defaultModel, system: opts.system, messages, tools: opts.tools, maxTokens: opts.maxTokens ?? 16000, effort: opts.effort ?? "medium" }, signal);
        messages.push({ role: "assistant", content: response.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
        return this.toResult(response);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions (Ollama, LM Studio, vLLM, llama.cpp, OpenAI, OpenRouter, Groq…)

interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

class OpenAiCompatibleProvider implements AiProvider {
  kind = "openai_compatible";

  constructor(
    private readonly app: AppContext,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly defaultModel: string,
    private readonly prices: { input: number; output: number } | null,
  ) {}

  pricing() {
    return this.prices;
  }

  private async chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ message: OaiMessage; usage: CompletionResult["usage"]; model: string; finish: string }> {
    const res = await safeRequest(this.app.fetch, `${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(body),
      timeoutMs: 300_000,
      signal,
      maxBytes: 20_000_000,
    });
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(res.body.toString("utf8"));
    } catch {
      throw new StepError(res.status >= 500 ? "transient" : "permanent", `AI provider returned HTTP ${res.status} with a non-JSON body.`);
    }
    if (res.status >= 400) {
      const msg = toText((data.error as Record<string, unknown>)?.message ?? data.error ?? `HTTP ${res.status}`);
      throw new StepError(errorKindForStatus(res.status), `AI provider: ${msg}`);
    }
    const choice = (data.choices as Array<{ message: OaiMessage; finish_reason: string }>)?.[0];
    if (!choice) throw new StepError("permanent", "AI provider returned no choices.");
    const usage = (data.usage as { prompt_tokens?: number; completion_tokens?: number }) ?? {};
    return { message: choice.message, usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 }, model: toText(data.model) || toText(body.model), finish: choice.finish_reason };
  }

  private toResult(r: Awaited<ReturnType<OpenAiCompatibleProvider["chat"]>>): CompletionResult {
    const toolCalls = (r.message.tool_calls ?? []).map((c) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(c.function.arguments || "{}");
      } catch {
        input = { __invalid_json: c.function.arguments };
      }
      return { id: c.id, name: c.function.name, input };
    });
    return { text: r.message.content ?? "", toolCalls, usage: r.usage, model: r.model, stopReason: r.finish };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const messages: OaiMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });
    const r = await this.chat(
      {
        model: req.model || this.defaultModel,
        messages,
        max_tokens: req.maxTokens ?? 4096,
        ...(req.jsonSchema ? { response_format: { type: "json_schema", json_schema: { name: "output", schema: req.jsonSchema } } } : {}),
      },
      req.signal,
    );
    return this.toResult(r);
  }

  conversation(opts: { system: string; tools: ToolSpec[]; maxTokens?: number; model?: string }): Conversation {
    const messages: OaiMessage[] = [{ role: "system", content: opts.system }];
    const tools = opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description.slice(0, 1024), parameters: t.inputSchema } }));
    return {
      send: async (input, signal) => {
        if (input.toolResults?.length) for (const tr of input.toolResults) messages.push({ role: "tool", tool_call_id: tr.id, content: tr.content });
        else messages.push({ role: "user", content: input.userText ?? "" });
        const r = await this.chat({ model: opts.model || this.defaultModel, messages, max_tokens: opts.maxTokens ?? 4096, ...(tools.length ? { tools } : {}) }, signal);
        messages.push({ role: "assistant", content: r.message.content ?? "", ...(r.message.tool_calls ? { tool_calls: r.message.tool_calls } : {}) });
        return this.toResult(r);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Mock test adapter: deterministic, offline, clearly labelled.

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function mockValueFor(name: string, schema: Record<string, unknown>, text: string): unknown {
  const type = schema.type;
  const lower = name.toLowerCase();
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const hit = (schema.enum as unknown[]).find((e) => text.toLowerCase().includes(String(e).toLowerCase()));
    return hit ?? schema.enum[0];
  }
  if (type === "number" || type === "integer") {
    if (/confidence|probability|score/.test(lower)) return type === "integer" ? 50 : 0.5;
    const m = text.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }
  if (type === "boolean") return /yes|true|interested|demo/i.test(text);
  if (type === "array") return [];
  if (type === "object") return {};
  if (/email/.test(lower)) return text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? "";
  if (/phone/.test(lower)) return text.match(/\+?\d[\d\s().-]{7,}\d/)?.[0]?.trim() ?? "";
  if (/url|website/.test(lower)) return text.match(/https?:\/\/[^\s<>"')]+/)?.[0] ?? "";
  if (/company|organi[sz]ation/.test(lower)) return text.match(/\b(?:at|from)\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)*)/)?.[1] ?? "";
  if (/name/.test(lower)) return text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/)?.[1] ?? "";
  if (/reason/.test(lower)) return "Mock adapter: heuristic result, no AI model was called.";
  return "";
}

export function mockStructured(schema: Record<string, unknown>, text: string): unknown {
  const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(props)) out[k] = mockValueFor(k, s, text);
  return out;
}

class MockProvider implements AiProvider {
  kind = "mock";
  defaultModel = "mock-heuristic-v1";
  pricing() {
    return { input: 0, output: 0 };
  }
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const input = req.prompt;
    let text: string;
    if (req.jsonSchema) text = JSON.stringify(mockStructured(req.jsonSchema, input));
    else {
      const content = /<input>([\s\S]*?)<\/input>/.exec(input)?.[1]?.trim() ?? input;
      const sentences = content.replace(/\s+/g, " ").match(/[^.!?]+[.!?]?/g) ?? [content];
      text = `[Mock AI output] ${sentences.slice(0, 2).join(" ").trim().slice(0, 600)}`;
    }
    return { text, toolCalls: [], usage: { inputTokens: estimateTokens(input + (req.system ?? "")), outputTokens: estimateTokens(text) }, model: this.defaultModel, stopReason: "end_turn" };
  }
  conversation(): Conversation {
    return {
      send: async (input) => {
        const text = input.toolResults ? `[Mock AI output] Received ${input.toolResults.length} tool result(s).` : "[Mock AI output] The mock adapter does not call tools.";
        return { text, toolCalls: [], usage: { inputTokens: estimateTokens(JSON.stringify(input)), outputTokens: estimateTokens(text) }, model: this.defaultModel, stopReason: "end_turn" };
      },
    };
  }
}

export const mockProvider: AiProvider = new MockProvider();

export function providerFromCredential(app: AppContext, credential?: LoadedCredential): AiProvider {
  if (!credential) return mockProvider;
  const d = credential.data;
  switch (d.provider) {
    case "anthropic":
      if (!d.apiKey) throw new StepError("config", "The Anthropic connection has no API key.");
      return new AnthropicProvider(app, toText(d.apiKey), toText(d.defaultModel) || ANTHROPIC_DEFAULT_MODEL);
    case "openai_compatible": {
      const baseUrl = toText(d.baseUrl) || "http://localhost:11434/v1";
      const prices = d.inputPricePerMTok !== undefined && d.inputPricePerMTok !== null ? { input: Number(d.inputPricePerMTok) || 0, output: Number(d.outputPricePerMTok) || 0 } : null;
      return new OpenAiCompatibleProvider(app, baseUrl, toText(d.apiKey), toText(d.defaultModel) || "llama3.2", prices);
    }
    case "mock":
      return mockProvider;
    default:
      throw new StepError("config", `Unknown AI provider '${toText(d.provider)}'.`);
  }
}
