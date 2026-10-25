import { toText } from "@automation-studio/core";
import { StepError } from "../errors.ts";
import { apiCall } from "./http.ts";
import type { IntegrationModule, NodeImplementation, StepContext } from "./types.ts";

/**
 * WhatsApp Business Platform (Cloud API) via the official Graph API.
 * Business-initiated conversations require approved message templates;
 * free-form text is only allowed inside the 24-hour customer service window.
 */
const GRAPH = "https://graph.facebook.com";

function waCreds(ctx: StepContext) {
  const d = ctx.credential?.data ?? {};
  const token = toText(d.accessToken);
  const phoneNumberId = toText(d.phoneNumberId);
  if (!token || !/^\d{5,30}$/.test(phoneNumberId)) throw new StepError("config", "The WhatsApp connection needs an access token and a numeric phone number ID.");
  return { token, phoneNumberId, version: /^v\d+\.\d+$/.test(toText(d.apiVersion)) ? toText(d.apiVersion) : "v23.0" };
}

export function normalizePhone(v: unknown): string {
  const digits = toText(v).replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 15) throw new StepError("config", `'${toText(v)}' is not a valid international phone number (E.164, digits only, country code first).`);
  return digits;
}

function requireConsent(ctx: StepContext): void {
  const c = ctx.config.consentConfirmed;
  if (!(c === true || ["true", "yes", "1", "opted_in"].includes(toText(c).toLowerCase()))) {
    throw new StepError("policy", "Recipient opt-in is not confirmed. Map 'Recipient has opted in' to your consent record (WhatsApp requires opt-in before business-initiated messages).");
  }
}

async function send(ctx: StepContext, payload: Record<string, unknown>) {
  const { token, phoneNumberId, version } = waCreds(ctx);
  const res = await apiCall<{ messages?: Array<{ id: string; message_status?: string }>; contacts?: Array<{ wa_id: string }> }>(ctx.app, {
    method: "POST",
    url: `${GRAPH}/${version}/${phoneNumberId}/messages`,
    headers: { authorization: `Bearer ${token}` },
    json: { messaging_product: "whatsapp", recipient_type: "individual", ...payload },
    signal: ctx.signal,
    provider: "WhatsApp",
  });
  return { messageId: res.data.messages?.[0]?.id, status: res.data.messages?.[0]?.message_status ?? "accepted", waId: res.data.contacts?.[0]?.wa_id };
}

const CONSENT_FIELD = { key: "consentConfirmed", label: "Recipient has opted in", type: "string" as const, required: true, placeholder: "{{ steps.lookup.output.first.data.whatsapp_opt_in }}", description: "Must evaluate to true. Sending is blocked otherwise." };

const sendTemplate: NodeImplementation = {
  type: "whatsapp.send_template",
  integration: "whatsapp",
  kind: "action",
  name: "WhatsApp: send template message",
  description: "Send an approved message template (required to start conversations outside the 24-hour window).",
  credentialType: "whatsapp_cloud",
  credentialRequired: true,
  sideEffects: "external",
  fields: [
    { key: "to", label: "To (phone, international format)", type: "string", required: true },
    { key: "templateName", label: "Template name", type: "string", required: true },
    { key: "languageCode", label: "Template language", type: "string", default: "en_US" },
    { key: "bodyParameters", label: "Body variables ({{1}}, {{2}}…)", type: "string_list" },
    CONSENT_FIELD,
  ],
  sampleOutput: { messageId: "wamid.HBg…", status: "accepted", waId: "15551234567" },
  mode: "live",
  async execute(ctx) {
    requireConsent(ctx);
    const params = (Array.isArray(ctx.config.bodyParameters) ? ctx.config.bodyParameters : []).map((p) => ({ type: "text", text: toText(p).slice(0, 1024) }));
    return {
      output: await send(ctx, {
        to: normalizePhone(ctx.config.to),
        type: "template",
        template: { name: toText(ctx.config.templateName), language: { code: toText(ctx.config.languageCode) || "en_US" }, ...(params.length ? { components: [{ type: "body", parameters: params }] } : {}) },
      }),
    };
  },
  async mock(ctx) {
    requireConsent(ctx);
    return { output: { messageId: `wamid.mock_${ctx.executionId}`, status: "simulated", waId: normalizePhone(ctx.config.to), _mock: true } };
  },
};

const sendText: NodeImplementation = {
  type: "whatsapp.send_text",
  integration: "whatsapp",
  kind: "action",
  name: "WhatsApp: send text reply",
  description: "Send free-form text. Only delivered within 24 hours of the customer's last message (customer service window).",
  credentialType: "whatsapp_cloud",
  credentialRequired: true,
  sideEffects: "external",
  fields: [
    { key: "to", label: "To (phone, international format)", type: "string", required: true, placeholder: "{{ trigger.from }}" },
    { key: "body", label: "Message", type: "text", required: true },
    { key: "replyToMessageId", label: "Reply to message ID (optional)", type: "string", placeholder: "{{ trigger.messageId }}" },
    CONSENT_FIELD,
  ],
  sampleOutput: { messageId: "wamid.HBg…", status: "accepted" },
  mode: "live",
  async execute(ctx) {
    requireConsent(ctx);
    const body = toText(ctx.config.body);
    if (!body || body.length > 4096) throw new StepError("config", "Message must be 1-4096 characters.");
    return {
      output: await send(ctx, {
        to: normalizePhone(ctx.config.to),
        type: "text",
        text: { body, preview_url: false },
        ...(ctx.config.replyToMessageId ? { context: { message_id: toText(ctx.config.replyToMessageId) } } : {}),
      }),
    };
  },
  async mock(ctx) {
    requireConsent(ctx);
    return { output: { messageId: `wamid.mock_${ctx.executionId}`, status: "simulated", _mock: true } };
  },
};

const incoming: NodeImplementation = {
  type: "trigger.whatsapp_message",
  integration: "whatsapp",
  kind: "trigger",
  name: "WhatsApp: incoming message",
  description: "Runs for messages (and optionally delivery status updates) received through the WhatsApp Cloud API webhook.",
  credentialType: "whatsapp_cloud",
  credentialRequired: true,
  fields: [{ key: "includeStatuses", label: "Also run for delivery status updates (sent/delivered/read/failed)", type: "boolean", default: false }],
  events: ["whatsapp.message", "whatsapp.status"],
  matchEvent: (config, type) => type === "whatsapp.message" || (type === "whatsapp.status" && config.includeStatuses === true),
  sampleOutput: { event: "whatsapp.message", messageId: "wamid.HBg…", from: "15551234567", profileName: "Ada", type: "text", text: "Hi, what are your prices?", timestamp: "2026-01-01T09:00:00.000Z" },
  mode: "live",
  execute: async (ctx) => ({ output: ctx.scope.trigger }),
};

export const whatsappIntegration: IntegrationModule = {
  definition: {
    id: "whatsapp",
    name: "WhatsApp Business Platform",
    description: "Receive messages and send template/text messages through the official WhatsApp Cloud API.",
    category: "Communication",
    version: "1.0.0",
    icon: "message-circle",
    credentialTypes: ["whatsapp_cloud"],
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    prerequisites: [
      "A Meta Business account, a Meta app with the WhatsApp product, and a verified business phone number.",
      "A permanent System User access token with whatsapp_business_messaging permission.",
      "Approved message templates for business-initiated messages; conversation-based or per-message pricing applies.",
      "A public HTTPS URL for the webhook: <PUBLIC_URL>/hooks/whatsapp/<connection id>.",
      "Recipients must have opted in to receive messages from your business.",
    ],
    availability: "live+mock",
    rateLimits: "Messaging limits depend on your phone number's quality rating and tier.",
  },
  nodes: [sendTemplate, sendText, incoming],
  credentialTypes: [
    {
      id: "whatsapp_cloud",
      name: "WhatsApp Cloud API",
      description: "Credentials for one WhatsApp business phone number.",
      fields: [
        { key: "accessToken", label: "Access token", type: "string", required: true, sensitive: true },
        { key: "phoneNumberId", label: "Phone number ID", type: "string", required: true },
        { key: "appSecret", label: "App secret (verifies webhook signatures)", type: "string", required: true, sensitive: true },
        { key: "verifyToken", label: "Webhook verify token", type: "string", required: true, sensitive: true, description: "Any random string; enter the same value in the Meta app's webhook settings." },
        { key: "apiVersion", label: "Graph API version", type: "string", default: "v23.0" },
      ],
      describe: (d) => ({ phoneNumberId: d.phoneNumberId }),
      async test(data, app) {
        const version = /^v\d+\.\d+$/.test(toText(data.apiVersion)) ? toText(data.apiVersion) : "v23.0";
        const res = await apiCall<{ display_phone_number?: string; verified_name?: string }>(app, {
          url: `${GRAPH}/${version}/${toText(data.phoneNumberId)}`,
          headers: { authorization: `Bearer ${toText(data.accessToken)}` },
          provider: "WhatsApp",
        });
        return { ok: true, message: `Connected to ${res.data.verified_name ?? "business"} (${res.data.display_phone_number ?? data.phoneNumberId}).` };
      },
    },
  ],
};

/** Flattens a Cloud API webhook payload into individual message/status events. */
export function parseWhatsAppWebhook(body: unknown): Array<{ type: "whatsapp.message" | "whatsapp.status"; key: string; payload: Record<string, unknown> }> {
  const out: Array<{ type: "whatsapp.message" | "whatsapp.status"; key: string; payload: Record<string, unknown> }> = [];
  const entries = (body as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries.slice(0, 50)) {
    for (const change of ((entry as { changes?: unknown[] }).changes ?? []).slice(0, 50)) {
      const value = (change as { value?: Record<string, unknown> }).value ?? {};
      const contacts = (value.contacts as Array<{ wa_id?: string; profile?: { name?: string } }>) ?? [];
      for (const m of ((value.messages as Array<Record<string, unknown>>) ?? []).slice(0, 100)) {
        const type = toText(m.type);
        const contact = contacts.find((c) => c.wa_id === m.from);
        const text =
          type === "text"
            ? toText((m.text as { body?: string })?.body)
            : type === "button"
              ? toText((m.button as { text?: string })?.text)
              : type === "interactive"
                ? toText((m.interactive as { button_reply?: { title?: string }; list_reply?: { title?: string } })?.button_reply?.title ?? (m.interactive as { list_reply?: { title?: string } })?.list_reply?.title)
                : "";
        out.push({
          type: "whatsapp.message",
          key: toText(m.id),
          payload: {
            messageId: m.id,
            from: m.from,
            profileName: contact?.profile?.name ?? null,
            type,
            text,
            timestamp: new Date(Number(m.timestamp) * 1000 || Date.now()).toISOString(),
            phoneNumberId: (value.metadata as { phone_number_id?: string })?.phone_number_id,
            raw: m,
          },
        });
      }
      for (const s of ((value.statuses as Array<Record<string, unknown>>) ?? []).slice(0, 100)) {
        out.push({
          type: "whatsapp.status",
          key: `${toText(s.id)}:${toText(s.status)}`,
          payload: { messageId: s.id, status: s.status, recipient: s.recipient_id, timestamp: new Date(Number(s.timestamp) * 1000 || Date.now()).toISOString(), errors: s.errors ?? null },
        });
      }
    }
  }
  return out;
}
