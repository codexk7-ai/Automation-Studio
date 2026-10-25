import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.ts";
import type { Principal } from "../src/auth/principal.ts";
import { startExecution } from "../src/engine/executions.ts";
import { getWorkflow } from "../src/services/workflows.ts";
import { cancelExecution, decideApproval, retryExecution } from "../src/services/executions.ts";
import { drain, executionState, makeWorkflow, mockServer, testApp, testUser } from "./helpers.ts";

let app: App;
let p: Principal;
let api: Awaited<ReturnType<typeof mockServer>>;
let flaky = 0;
const received: unknown[] = [];

beforeAll(async () => {
  api = await mockServer(async (req, res) => {
    if (req.url?.startsWith("/flaky")) {
      flaky++;
      res.writeHead(flaky < 3 ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ attempt: flaky }));
      return;
    }
    if (req.url?.startsWith("/fail")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad" }));
      return;
    }
    received.push(req.body ? JSON.parse(req.body) : null);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, echo: req.body ? JSON.parse(req.body) : null }));
  });
  app = await testApp([api.hostKey]);
  p = (await testUser(app)).principal;
});

afterAll(async () => {
  await app.close();
  await api.close();
});

async function run(definition: Parameters<typeof makeWorkflow>[2], triggerData: unknown, opts: { useMocks?: boolean } = {}) {
  const wf = await makeWorkflow(app, p, definition);
  const row = await getWorkflow(app.ctx, p.workspaceId, wf.id);
  const v = await app.ctx.db.one<{ definition: never }>("SELECT definition FROM workflow_versions WHERE id = $1", [row.active_version_id]);
  const { executionId } = await startExecution(app.ctx, { workspaceId: p.workspaceId, workflowId: wf.id, workflowVersionId: row.active_version_id, definition: v!.definition, mode: "manual", triggerData, useMocks: opts.useMocks });
  await drain(app);
  return { executionId, workflowId: wf.id, state: await executionState(app, executionId) };
}

describe("execution engine", () => {
  it("runs connected steps, maps outputs and routes conditions", async () => {
    const { state } = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "shape", type: "transform.set", name: "Shape", config: { fields: { email: "{{ lower(trigger.email) }}", score: "{{ number(trigger.score) * 2 }}" } } },
          { id: "check", type: "logic.condition", name: "Hot?", config: { rules: [{ left: "{{ steps.shape.output.score }}", operator: "gt", right: 50 }] } },
          { id: "post", type: "http.request", name: "Notify", config: { method: "POST", url: `${api.url}/hook`, bodyType: "json", body: { email: "{{ steps.shape.output.email }}", label: "hot" } } },
          { id: "cold", type: "transform.set", name: "Cold", config: { fields: { label: "cold" } } },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "shape" },
          { id: "e2", source: "shape", target: "check" },
          { id: "e3", source: "check", target: "post", branch: "true" },
          { id: "e4", source: "check", target: "cold", branch: "false" },
        ],
      },
      { email: "ADA@Example.com", score: "40" },
    );
    expect(state.status).toBe("succeeded");
    expect(state.steps.shape!.output).toEqual({ email: "ada@example.com", score: 80 });
    expect(state.steps.check!.branch).toBe("true");
    expect(state.steps.post!.status).toBe("succeeded");
    expect(state.steps.cold!.status).toBe("skipped");
    expect(received.at(-1)).toEqual({ email: "ada@example.com", label: "hot" });
  });

  it("retries transient failures with backoff and records attempts", async () => {
    flaky = 0;
    const { state, executionId } = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "call", type: "http.request", name: "Flaky", config: { url: `${api.url}/flaky` }, retry: { maxAttempts: 3, backoffMs: 10, backoffMultiplier: 1 } },
        ],
        edges: [{ id: "e1", source: "trigger", target: "call" }],
      },
      {},
    );
    expect(state.status).toBe("succeeded");
    expect(state.steps.call!.attempt).toBe(3);
    const attempts = await app.ctx.db.query<{ status: string }>("SELECT status FROM step_attempts WHERE execution_id = $1 ORDER BY id", [executionId]);
    expect(attempts.map((a) => a.status)).toEqual(["failed", "failed", "succeeded"]);
  });

  it("fails permanently on 4xx without retrying, and continue-on-error keeps going", async () => {
    const { state } = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "bad", type: "http.request", name: "Bad", config: { url: `${api.url}/fail` }, retry: { maxAttempts: 3, backoffMs: 10, backoffMultiplier: 1 } },
          { id: "after", type: "transform.set", name: "After", config: { fields: { x: 1 } } },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "bad" },
          { id: "e2", source: "bad", target: "after" },
        ],
      },
      {},
    );
    expect(state.status).toBe("failed");
    expect(state.steps.bad!.attempt).toBe(1);
    expect(state.steps.after!.status).toBe("skipped");

    const cont = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "bad", type: "http.request", name: "Bad", config: { url: `${api.url}/fail` }, onError: "continue" },
          { id: "after", type: "transform.set", name: "After", config: { fields: { status: "{{ steps.bad.status }}" } } },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "bad" },
          { id: "e2", source: "bad", target: "after" },
        ],
      },
      {},
    );
    expect(cont.state.status).toBe("succeeded");
    expect(cont.state.steps.after!.output).toEqual({ status: "failed" });
  });

  it("blocks private network targets (SSRF) unless allowlisted", async () => {
    const { state } = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "meta", type: "http.request", name: "Metadata", config: { url: "http://169.254.169.254/latest/meta-data/" } },
        ],
        edges: [{ id: "e1", source: "trigger", target: "meta" }],
      },
      {},
    );
    expect(state.status).toBe("failed");
    expect(JSON.stringify(state.steps.meta!.error)).toMatch(/private|blocked/i);
  });

  it("enforces step timeouts", async () => {
    const slow = await mockServer(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 1500));
      res.end("{}");
    });
    app.ctx.policy.allowlist.push(slow.hostKey);
    const { state } = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "slow", type: "http.request", name: "Slow", config: { url: slow.url }, timeoutMs: 300 },
        ],
        edges: [{ id: "e1", source: "trigger", target: "slow" }],
      },
      {},
    );
    await slow.close();
    expect(state.status).toBe("failed");
    expect((state.steps.slow!.error as { kind: string }).kind).toBe("timeout");
  });

  it("deduplicates trigger events by key", async () => {
    const wf = await makeWorkflow(app, p, { schemaVersion: 1, nodes: [{ id: "trigger", type: "trigger.manual", name: "Start", config: {} }], edges: [] });
    const row = await getWorkflow(app.ctx, p.workspaceId, wf.id);
    const def = row.draft_definition;
    const a = await startExecution(app.ctx, { workspaceId: p.workspaceId, workflowId: wf.id, workflowVersionId: null, definition: def, mode: "webhook", triggerData: {}, dedupeKey: "evt-1" });
    const b = await startExecution(app.ctx, { workspaceId: p.workspaceId, workflowId: wf.id, workflowVersionId: null, definition: def, mode: "webhook", triggerData: {}, dedupeKey: "evt-1" });
    expect(b.duplicate).toBe(true);
    expect(b.executionId).toBe(a.executionId);
  });

  it("pauses on approval and resumes on decision", async () => {
    const wf = await makeWorkflow(app, p, {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
        { id: "ok", type: "human.approval", name: "Approve", config: { title: "Send?", data: { draft: "{{ trigger.text }}" } } },
        { id: "yes", type: "transform.set", name: "Yes", config: { fields: { sent: true } } },
        { id: "no", type: "transform.set", name: "No", config: { fields: { sent: false } } },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "ok" },
        { id: "e2", source: "ok", target: "yes", branch: "approved" },
        { id: "e3", source: "ok", target: "no", branch: "rejected" },
      ],
    });
    const row = await getWorkflow(app.ctx, p.workspaceId, wf.id);
    const { executionId } = await startExecution(app.ctx, { workspaceId: p.workspaceId, workflowId: wf.id, workflowVersionId: row.active_version_id, definition: row.draft_definition, mode: "manual", triggerData: { text: "hello" } });
    await drain(app);
    let state = await executionState(app, executionId);
    expect(state.status).toBe("waiting");
    const approval = await app.ctx.db.one<{ id: string; data: unknown }>("SELECT id, data FROM approvals WHERE execution_id = $1", [executionId]);
    expect(approval!.data).toEqual({ draft: "hello" });
    await decideApproval(app.ctx, p, approval!.id, "approved", "ok");
    await drain(app);
    state = await executionState(app, executionId);
    expect(state.status).toBe("succeeded");
    expect(state.steps.yes!.status).toBe("succeeded");
    expect(state.steps.no!.status).toBe("skipped");
  });

  it("durably delays and resumes", async () => {
    const { executionId } = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "wait", type: "logic.delay", name: "Wait", config: { mode: "duration", amount: 1, unit: "seconds" } },
          { id: "done", type: "transform.set", name: "Done", config: { fields: { at: "{{ steps.wait.output.resumedAt }}" } } },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "wait" },
          { id: "e2", source: "wait", target: "done" },
        ],
      },
      {},
    );
    expect((await executionState(app, executionId)).status).toBe("waiting");
    await new Promise((r) => setTimeout(r, 1200));
    await drain(app);
    const state = await executionState(app, executionId);
    expect(state.status).toBe("succeeded");
    expect(typeof (state.steps.done!.output as { at: string }).at).toBe("string");
  });

  it("cancels a waiting execution", async () => {
    const { executionId } = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "wait", type: "logic.delay", name: "Wait", config: { mode: "duration", amount: 1, unit: "hours" } },
        ],
        edges: [{ id: "e1", source: "trigger", target: "wait" }],
      },
      {},
    );
    await cancelExecution(app.ctx, p, executionId);
    await app.ctx.db.query("UPDATE jobs SET run_at = now() WHERE status = 'pending'");
    await drain(app);
    expect((await executionState(app, executionId)).status).toBe("cancelled");
  });

  it("retries only failed steps without repeating succeeded side effects", async () => {
    let calls = 0;
    let failNext = true;
    const svc = await mockServer(async (req, res) => {
      if (req.url === "/side") calls++;
      if (req.url === "/maybe" && failNext) {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    app.ctx.policy.allowlist.push(svc.hostKey);
    const { executionId } = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "side", type: "http.request", name: "Side effect", config: { method: "POST", url: `${svc.url}/side` } },
          { id: "maybe", type: "http.request", name: "Maybe", config: { url: `${svc.url}/maybe` } },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "side" },
          { id: "e2", source: "side", target: "maybe" },
        ],
      },
      {},
    );
    expect((await executionState(app, executionId)).status).toBe("failed");
    failNext = false;
    await retryExecution(app.ctx, p, executionId, "failed_steps");
    await drain(app);
    const state = await executionState(app, executionId);
    await svc.close();
    expect(state.status).toBe("succeeded");
    expect(calls).toBe(1);
  });

  it("runs bounded loops through sub-workflows", async () => {
    const child = await makeWorkflow(app, p, {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.manual", name: "Item", config: {} },
        { id: "double", type: "transform.set", name: "Double", config: { fields: { v: "{{ trigger.item * 2 }}" } } },
      ],
      edges: [{ id: "e1", source: "trigger", target: "double" }],
    });
    const { state } = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "loop", type: "logic.loop", name: "Loop", config: { items: "{{ trigger.values }}", workflowId: child.id, maxIterations: 5 } },
          { id: "sum", type: "transform.set", name: "Sum", config: { fields: { total: "{{ sum(pluck(pluck(steps.loop.output.results, \"output\"), \"v\")) }}" } } },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "loop" },
          { id: "e2", source: "loop", target: "sum" },
        ],
      },
      { values: [1, 2, 3] },
    );
    expect(state.status).toBe("succeeded");
    expect(state.steps.sum!.output).toEqual({ total: 12 });

    const tooMany = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "loop", type: "logic.loop", name: "Loop", config: { items: "{{ trigger.values }}", workflowId: child.id, maxIterations: 2 } },
        ],
        edges: [{ id: "e1", source: "trigger", target: "loop" }],
      },
      { values: [1, 2, 3] },
    );
    expect(tooMany.state.status).toBe("failed");
  });

  it("recovers an execution interrupted mid-step (expired lease)", async () => {
    const wf = await makeWorkflow(app, p, {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
        { id: "a", type: "transform.set", name: "A", config: { fields: { ok: true } } },
      ],
      edges: [{ id: "e1", source: "trigger", target: "a" }],
    });
    const row = await getWorkflow(app.ctx, p.workspaceId, wf.id);
    const { executionId } = await startExecution(app.ctx, { workspaceId: p.workspaceId, workflowId: wf.id, workflowVersionId: null, definition: row.draft_definition, mode: "manual", triggerData: {} });
    // Simulate a crashed worker: step marked running, lease and job lock expired.
    await app.ctx.db.query("UPDATE execution_steps SET status = 'running', attempt = 1 WHERE execution_id = $1 AND node_id = 'a'", [executionId]);
    await app.ctx.db.query("UPDATE executions SET status = 'running', lease_owner = 'dead-worker', lease_until = now() - interval '1 minute' WHERE id = $1", [executionId]);
    await app.ctx.db.query("UPDATE jobs SET status = 'running', locked_by = 'dead-worker', locked_until = now() - interval '1 minute' WHERE payload->>'executionId' = $1", [executionId]);
    await drain(app);
    const state = await executionState(app, executionId);
    expect(state.status).toBe("succeeded");
    expect(state.steps.a!.attempt).toBe(2);
  });

  it("emits failure events to failure-alert workflows without loops", async () => {
    const alert = await makeWorkflow(app, p, {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.execution_failed", name: "On failure", config: {} },
        { id: "note", type: "transform.set", name: "Note", config: { fields: { failed: "{{ trigger.workflowName }}" } } },
      ],
      edges: [{ id: "e1", source: "trigger", target: "note" }],
    });
    const { workflowId } = await run(
      {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Start", config: {} },
          { id: "boom", type: "flow.stop_error", name: "Boom", config: { message: "boom" } },
        ],
        edges: [{ id: "e1", source: "trigger", target: "boom" }],
      },
      {},
    );
    const alerts = await app.ctx.db.query<{ status: string; trigger_data: { workflowId: string } }>("SELECT status, trigger_data FROM executions WHERE workflow_id = $1", [alert.id]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe("succeeded");
    expect(alerts[0]!.trigger_data.workflowId).toBe(workflowId);
  });
});
