import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.ts";
import type { Principal } from "../src/auth/principal.ts";
import { createCredential } from "../src/services/credentials.ts";
import { createWorkflow, publishWorkflow, runWorkflow } from "../src/services/workflows.ts";
import { drain, executionState, testApp, testUser } from "./helpers.ts";

/**
 * Live AI verification against a real local model through the app's
 * OpenAI-compatible adapter. Runs only when Ollama is reachable
 * (OLLAMA_URL, default http://127.0.0.1:11434) and the model is pulled;
 * otherwise reported as skipped — never as passed.
 */
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:1b";

async function ollamaReady(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const tags = (await res.json()) as { models?: Array<{ name: string }> };
    return !!tags.models?.some((m) => m.name === MODEL || m.name === `${MODEL}:latest`);
  } catch {
    return false;
  }
}

const ready = await ollamaReady();

describe.skipIf(!ready)(`live AI via Ollama (${MODEL})`, () => {
  let app: App;
  let p: Principal;
  let credId: string;

  beforeAll(async () => {
    const u = new URL(OLLAMA);
    app = await testApp([`${u.hostname}:${u.port || 80}`]);
    p = (await testUser(app)).principal;
    credId = (await createCredential(app.ctx, p, { name: "Ollama", type: "ai_provider", data: { provider: "openai_compatible", baseUrl: `${OLLAMA}/v1`, defaultModel: MODEL } })).id;
  });
  afterAll(async () => app?.close());

  async function run(node: Record<string, unknown>) {
    const wf = await createWorkflow(app.ctx, p, {
      name: `ai ${Date.now()}`,
      definition: {
        schemaVersion: 1,
        nodes: [{ id: "trigger", type: "trigger.manual", name: "T", config: {} }, { id: "ai", name: "AI", credentialId: credId, config: {}, timeoutMs: 300_000, ...node } as never],
        edges: [{ id: "e", source: "trigger", target: "ai" }],
      },
    });
    await publishWorkflow(app.ctx, p, wf.id);
    const { executionId } = await runWorkflow(app.ctx, p, wf.id, { mode: "manual" });
    await drain(app);
    return executionState(app, executionId);
  }

  it("classifies into one of the allowed labels with schema-validated output", async () => {
    const s = await run({ type: "ai.classify", config: { text: "Our CFO approved a $50k budget and we must go live in two weeks. Please send a quote today.", categories: ["hot", "warm", "cold"] } });
    expect(s.status, JSON.stringify(s.steps.ai?.error)).toBe("succeeded");
    const out = s.steps.ai!.output as Record<string, unknown>;
    expect(["hot", "warm", "cold"]).toContain(out.label);
    expect(out.provider).toBe("openai_compatible");
    expect(out._mock).toBeUndefined();
    console.log("classify →", out.label, out.confidence, out.usage);
  }, 300_000);

  it("extracts structured fields", async () => {
    const s = await run({ type: "ai.extract", config: { text: "Hi, I'm Grace Hopper from Navy Labs. Reach me at grace@navylabs.example.", fields: { name: "Full name", email: "Email address", company: "Company" } } });
    expect(s.status, JSON.stringify(s.steps.ai?.error)).toBe("succeeded");
    const data = (s.steps.ai!.output as { data: Record<string, string> }).data;
    expect(Object.keys(data).sort()).toEqual(["company", "email", "name"]);
    expect(String(data.email).toLowerCase()).toContain("grace@navylabs.example");
    console.log("extract →", data);
  }, 300_000);

  it("summarizes text", async () => {
    const s = await run({ type: "ai.summarize", config: { text: "The quarterly review covered three topics. Revenue grew 12 percent. Two new hires join engineering next month. The office move is postponed until spring.", style: "tldr" } });
    expect(s.status, JSON.stringify(s.steps.ai?.error)).toBe("succeeded");
    const summary = (s.steps.ai!.output as { summary: string }).summary;
    expect(summary.length).toBeGreaterThan(10);
    expect(summary).not.toContain("[Mock AI output]");
    console.log("summary →", summary);
  }, 300_000);
});

describe.skipIf(ready)("live AI via Ollama", () => {
  it.skip(`skipped: Ollama not reachable at ${OLLAMA} or model ${MODEL} not pulled`, () => undefined);
});
