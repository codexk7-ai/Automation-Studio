import { isTriggerType, renderTemplate, toText, type WorkflowDefinition } from "@automation-studio/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { emitEvent } from "../engine/events.ts";
import { startExecution } from "../engine/executions.ts";
import { notFound } from "../errors.ts";
import { parseWhatsAppWebhook } from "../integrations/whatsapp.ts";
import { hmacSha256, safeEqual } from "../security/crypto.ts";
import { loadCredential } from "../services/credentials.ts";
import { publicForm, submitForm, type FormRow } from "../services/forms.ts";

const DROP_HEADERS = /^(authorization|cookie|proxy-authorization|x-api-key|x-hub-signature.*|x-webhook-signature|x-signature.*|.*-signature|x-forwarded-.*|x-real-ip|connection|content-length|host)$/i;

function cleanHeaders(headers: Record<string, unknown>, signatureHeader?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (DROP_HEADERS.test(k) || (signatureHeader && k.toLowerCase() === signatureHeader.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : toText(v);
  }
  return out;
}

function verifySignature(config: Record<string, unknown>, secret: string, req: FastifyRequest): boolean {
  const header = toText(config.signatureHeader || "x-webhook-signature").toLowerCase();
  const provided = toText(req.headers[header]);
  if (!provided || !secret) return false;
  if (config.verification === "shared_secret") return safeEqual(provided, secret);
  if (config.verification === "hmac_sha256") {
    const raw = req.rawBody ?? (typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? ""));
    const hex = hmacSha256(secret, raw, "hex");
    const b64 = hmacSha256(secret, raw, "base64");
    const value = provided.replace(/^sha256=/i, "");
    return safeEqual(value.toLowerCase(), hex) || safeEqual(value, b64);
  }
  return true;
}

export async function registerHookRoutes(server: FastifyInstance, app: AppContext): Promise<void> {
  const hookLimit = { config: { rateLimit: { max: 300, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => `${(req.params as { key?: string }).key ?? ""}:${req.ip}` } } };

  /** Workflow webhook trigger: /hooks/w/:key */
  const handleWebhook = async (req: FastifyRequest, reply: FastifyReply) => {
    const key = (req.params as { key: string }).key;
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(key)) throw notFound("Webhook");
    const wf = await app.db.one<{ id: string; workspace_id: string; status: string; active_version_id: string | null }>("SELECT id, workspace_id, status, active_version_id FROM workflows WHERE webhook_key = $1", [key]);
    if (!wf || !wf.active_version_id) throw notFound("Webhook");
    if (wf.status !== "active") return reply.status(409).send({ error: { code: "workflow_inactive", message: "This workflow is paused." } });
    const version = await app.db.one<{ definition: WorkflowDefinition }>("SELECT definition FROM workflow_versions WHERE id = $1", [wf.active_version_id]);
    const def = version!.definition;
    const trigger = def.nodes.find((n) => isTriggerType(n.type));
    if (!trigger || trigger.type !== "trigger.webhook") throw notFound("Webhook");
    const cfg = trigger.config;
    const method = toText(cfg.method || "POST");
    if (method !== "ANY" && req.method !== method) return reply.status(405).send({ error: { code: "method_not_allowed", message: `Use ${method}.` } });

    if (cfg.verification && cfg.verification !== "none") {
      let secret = "";
      if (trigger.credentialId) {
        try {
          secret = toText((await loadCredential(app, wf.workspace_id, trigger.credentialId)).data.secret);
        } catch {
          secret = "";
        }
      }
      if (!verifySignature(cfg, secret, req)) return reply.status(401).send({ error: { code: "invalid_signature", message: "Request verification failed." } });
    }

    const triggerData = {
      method: req.method,
      query: req.query ?? {},
      headers: cleanHeaders(req.headers as Record<string, unknown>, toText(cfg.signatureHeader)),
      body: req.body ?? null,
      receivedAt: new Date().toISOString(),
    };
    let dedupeKey: string | null = null;
    if (cfg.dedupeKey) {
      try {
        const v = renderTemplate(toText(cfg.dedupeKey), { trigger: triggerData });
        dedupeKey = v === null || v === undefined || v === "" ? null : toText(v);
      } catch {
        dedupeKey = null;
      }
    }
    const res = await startExecution(app, { workspaceId: wf.workspace_id, workflowId: wf.id, workflowVersionId: wf.active_version_id, definition: def, mode: "webhook", triggerData, dedupeKey });
    if (res.duplicate) return reply.status(200).send({ accepted: false, duplicate: true, executionId: res.executionId });

    if (cfg.responseMode === "respond_node") {
      // Wait (bounded) for a 'Respond to webhook' step; the run itself continues in the worker.
      const timeout = Math.min(30_000, Math.max(1000, Number(cfg.responseTimeoutMs) || 10_000));
      const respondIds = def.nodes.filter((n) => n.type === "flow.respond_webhook").map((n) => n.id);
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const row = await app.db.one<{ output: { status: number; contentType: string; headers: Record<string, string>; body: unknown } | null }>(
          "SELECT output FROM execution_steps WHERE execution_id = $1 AND node_id = ANY($2::text[]) AND status = 'succeeded' LIMIT 1",
          [res.executionId, `{${respondIds.map((i) => `"${i}"`).join(",")}}`],
        );
        if (row?.output) {
          const o = row.output;
          reply.status(o.status ?? 200).headers(o.headers ?? {}).header("content-type", o.contentType || "application/json");
          return typeof o.body === "string" ? o.body : JSON.stringify(o.body ?? null);
        }
        const exec = await app.db.one<{ status: string }>("SELECT status FROM executions WHERE id = $1", [res.executionId]);
        if (exec && ["failed", "cancelled", "succeeded"].includes(exec.status)) break;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return reply.status(202).send({ accepted: true, executionId: res.executionId });
  };
  server.route({ method: ["GET", "POST", "PUT", "PATCH", "DELETE"], url: "/hooks/w/:key", ...hookLimit, handler: handleWebhook });

  /** WhatsApp Cloud API webhook: verification (GET) and events (POST). */
  server.get("/hooks/whatsapp/:credentialId", hookLimit, async (req, reply) => {
    const { credentialId } = req.params as { credentialId: string };
    const q = req.query as Record<string, string>;
    const row = await app.db.one<{ workspace_id: string; type: string }>("SELECT workspace_id, type FROM credentials WHERE id = $1", [credentialId]);
    if (!row || row.type !== "whatsapp_cloud") throw notFound("Webhook");
    const cred = await loadCredential(app, row.workspace_id, credentialId);
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] && safeEqual(q["hub.verify_token"], toText(cred.data.verifyToken))) {
      return reply.header("content-type", "text/plain").send(toText(q["hub.challenge"]).slice(0, 200));
    }
    return reply.status(403).send({ error: { code: "forbidden", message: "Verification failed." } });
  });

  server.post("/hooks/whatsapp/:credentialId", hookLimit, async (req, reply) => {
    const { credentialId } = req.params as { credentialId: string };
    const row = await app.db.one<{ workspace_id: string; type: string }>("SELECT workspace_id, type FROM credentials WHERE id = $1", [credentialId]);
    if (!row || row.type !== "whatsapp_cloud") throw notFound("Webhook");
    const cred = await loadCredential(app, row.workspace_id, credentialId);
    const signature = toText(req.headers["x-hub-signature-256"]).replace(/^sha256=/, "");
    const expected = hmacSha256(toText(cred.data.appSecret), req.rawBody ?? "", "hex");
    if (!signature || !safeEqual(signature, expected)) return reply.status(401).send({ error: { code: "invalid_signature", message: "Invalid signature." } });
    let started = 0;
    for (const evt of parseWhatsAppWebhook(req.body)) {
      started += (await emitEvent(app, row.workspace_id, evt.type, evt.payload, { dedupeKey: evt.key, meta: { credentialId } })).length;
    }
    return { received: true, executions: started };
  });

  /** Public forms */
  const formLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.ip } } };
  server.get("/api/public/forms/:slug", formLimit, async (req) => publicForm(app, (req.params as { slug: string }).slug));
  server.post("/api/public/forms/:slug", formLimit, async (req) => {
    const form = await app.db.one<FormRow>("SELECT * FROM forms WHERE slug = $1 AND is_public = TRUE", [(req.params as { slug: string }).slug]);
    if (!form) throw notFound("Form");
    const b = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    // Honeypot field for simple bots.
    if (b._hp) return { ok: true, message: form.success_message };
    return submitForm(app, form, b);
  });
}
