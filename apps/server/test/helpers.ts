import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorkflowDefinitionInput } from "@automation-studio/core";
import { createApp, type App } from "../src/app.ts";
import type { Principal } from "../src/auth/principal.ts";
import { registerUser } from "../src/services/accounts.ts";
import { createWorkflow, publishWorkflow } from "../src/services/workflows.ts";

export const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export async function testApp(extraAllowlist: string[] = []): Promise<App> {
  return createApp({
    env: "test",
    pgliteDataDir: "memory://",
    databaseUrl: "",
    encryptionKey: TEST_KEY,
    logLevel: "silent",
    workerMode: "off",
    outboundAllowlist: extraAllowlist,
    smtp: null,
    publicUrl: "http://localhost:8787",
    authRateLimitPerMinute: 1000,
  });
}

let counter = 0;
export async function testUser(app: App, role: Principal["role"] = "owner"): Promise<{ principal: Principal; userId: string; workspaceId: string }> {
  counter++;
  const { user, workspaceId } = await registerUser(app.ctx, { email: `user${counter}-${Date.now()}@example.com`, name: `User ${counter}`, password: "correct horse battery" });
  return { principal: { actorType: "user", userId: user.id, workspaceId, role }, userId: user.id, workspaceId };
}

export async function makeWorkflow(app: App, p: Principal, definition: WorkflowDefinitionInput, publish = true) {
  const wf = await createWorkflow(app.ctx, p, { name: `WF ${Date.now()}`, definition });
  if (publish) await publishWorkflow(app.ctx, p, wf.id);
  return wf;
}

/** Runs the worker until no due jobs remain. */
export async function drain(app: App): Promise<void> {
  await app.worker.drain();
}

export async function executionState(app: App, id: string) {
  const exec = await app.ctx.db.one<{ status: string; error: unknown }>("SELECT status, error FROM executions WHERE id = $1", [id]);
  const steps = await app.ctx.db.query<{ node_id: string; status: string; output: unknown; error: unknown; attempt: number; branch: string | null }>(
    "SELECT node_id, status, output, error, attempt, branch FROM execution_steps WHERE execution_id = $1",
    [id],
  );
  return { ...exec!, steps: Object.fromEntries(steps.map((s) => [s.node_id, s])) };
}

/** Local HTTP server for mock external APIs. */
export async function mockServer(handler: (req: IncomingMessage & { body: string }, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => void handler(Object.assign(req, { body }), res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, hostKey: `127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
