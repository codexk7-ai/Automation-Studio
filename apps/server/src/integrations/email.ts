import { lookup } from "node:dns/promises";
import { toText } from "@automation-studio/core";
import nodemailer from "nodemailer";
import type { AppContext } from "../context.ts";
import { StepError } from "../errors.ts";
import { randomId } from "../security/crypto.ts";
import { isPublicAddress } from "../security/ssrf.ts";
import type { IntegrationModule, LoadedCredential, NodeImplementation, StepContext } from "./types.ts";

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function parseAddressList(value: unknown, label: string, required = false): string[] {
  const list = (Array.isArray(value) ? value.map(toText) : toText(value).split(/[,;]/))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /<([^>]+)>/.exec(s);
      return (m ? m[1]! : s).trim();
    });
  if (required && list.length === 0) throw new StepError("config", `${label} is required.`);
  for (const a of list) if (!EMAIL_RE.test(a)) throw new StepError("config", `${label}: '${a}' is not a valid email address.`);
  if (list.length > 50) throw new StepError("config", `${label}: at most 50 recipients per message.`);
  return list;
}

interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

async function assertSmtpHostAllowed(app: AppContext, host: string, port: number): Promise<void> {
  if (app.config.outboundAllowlist.includes(`${host.toLowerCase()}:${port}`) || app.policy.allowPrivate) return;
  const addrs = await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) {
    throw new StepError("policy", `SMTP host ${host} resolves to a private address. Ask an administrator to add ${host}:${port} to OUTBOUND_ALLOWLIST.`);
  }
}

function smtpFromCredential(c?: LoadedCredential): SmtpSettings | null {
  if (!c) return null;
  return {
    host: toText(c.data.host),
    port: Number(c.data.port) || 587,
    secure: c.data.secure === true,
    user: toText(c.data.username),
    pass: toText(c.data.password),
    from: toText(c.data.from),
  };
}

export interface OutgoingEmail {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  from?: string;
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
}

/**
 * Sends through the node's SMTP connection, else the server-level SMTP
 * settings, else captures the message in the local outbox (development
 * adapter: nothing leaves the machine and the UI labels it "not delivered").
 */
export async function sendEmail(app: AppContext, workspaceId: string, executionId: string | null, msg: OutgoingEmail, credential?: LoadedCredential, simulate = false) {
  const smtp = smtpFromCredential(credential) ?? (app.config.smtp ? { ...app.config.smtp, user: app.config.smtp.user, pass: app.config.smtp.pass } : null);
  const id = randomId("eml");
  const provider = simulate ? "simulated" : smtp ? "smtp" : "local_outbox";
  const record = async (status: string, providerMessageId: string | null, error: string | null) => {
    await app.db.query(
      `INSERT INTO email_outbox (id, workspace_id, execution_id, provider, status, to_addresses, subject, body_text, body_html, provider_message_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, workspaceId, executionId, provider, status, [...msg.to, ...msg.cc].join(", "), msg.subject, msg.text ?? null, msg.html ?? null, providerMessageId, error],
    );
  };
  if (!smtp || simulate) {
    await record(simulate ? "simulated" : "captured", null, null);
    return { id, provider, delivered: false, status: simulate ? "simulated" : "captured", note: simulate ? "Test run: email not sent." : "No SMTP configured: email captured in the local outbox and NOT delivered." };
  }
  if (!smtp.host) throw new StepError("config", "SMTP host is missing.");
  await assertSmtpHostAllowed(app, smtp.host, smtp.port);
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    const info = await transport.sendMail({
      from: msg.from || smtp.from || app.config.defaultEmailFrom,
      to: msg.to,
      cc: msg.cc.length ? msg.cc : undefined,
      bcc: msg.bcc.length ? msg.bcc : undefined,
      replyTo: msg.replyTo || undefined,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    await record("sent", info.messageId ?? null, null);
    return { id, provider, delivered: true, status: "sent", messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } catch (err) {
    const e = err as { responseCode?: number; code?: string; message: string };
    await record("failed", null, e.message.slice(0, 1000));
    const transient = (e.responseCode !== undefined && e.responseCode >= 400 && e.responseCode < 500) || ["ECONNECTION", "ETIMEDOUT", "ESOCKET"].includes(String(e.code));
    throw new StepError(e.code === "EAUTH" ? "auth" : transient ? "transient" : "permanent", `SMTP: ${e.message}`);
  } finally {
    transport.close();
  }
}

function buildMessage(ctx: StepContext): OutgoingEmail {
  const subject = toText(ctx.config.subject).replace(/[\r\n]+/g, " ").slice(0, 998);
  if (!subject) throw new StepError("config", "Subject is required.");
  const attachments = [];
  if (ctx.config.attachmentContent) {
    attachments.push({ filename: toText(ctx.config.attachmentName) || "attachment.txt", content: toText(ctx.config.attachmentContent), contentType: toText(ctx.config.attachmentType) || undefined });
  }
  return {
    to: parseAddressList(ctx.config.to, "To", true),
    cc: parseAddressList(ctx.config.cc, "Cc"),
    bcc: parseAddressList(ctx.config.bcc, "Bcc"),
    replyTo: ctx.config.replyTo ? parseAddressList(ctx.config.replyTo, "Reply-To")[0] : undefined,
    from: toText(ctx.config.from) || undefined,
    subject,
    text: ctx.config.format === "html" ? undefined : toText(ctx.config.body),
    html: ctx.config.format === "html" ? toText(ctx.config.body) : undefined,
    attachments,
  };
}

const sendNode: NodeImplementation = {
  type: "email.send",
  integration: "email",
  kind: "action",
  name: "Send email",
  description: "Send an email via SMTP. Without SMTP configured, messages are captured in the local outbox (not delivered).",
  credentialType: "smtp",
  credentialRequired: false,
  sideEffects: "external",
  fields: [
    { key: "to", label: "To", type: "string", required: true, placeholder: "{{ trigger.body.email }}" },
    { key: "cc", label: "Cc", type: "string" },
    { key: "bcc", label: "Bcc", type: "string" },
    { key: "from", label: "From (optional)", type: "string", placeholder: "Team <team@example.com>" },
    { key: "replyTo", label: "Reply-To", type: "string" },
    { key: "subject", label: "Subject", type: "string", required: true },
    {
      key: "format",
      label: "Format",
      type: "select",
      default: "text",
      options: [
        { value: "text", label: "Plain text" },
        { value: "html", label: "HTML" },
      ],
    },
    { key: "body", label: "Body", type: "text", required: true },
    { key: "attachmentName", label: "Attachment file name", type: "string", placeholder: "export.csv" },
    { key: "attachmentContent", label: "Attachment content", type: "text", placeholder: "{{ steps.export.output.csv }}" },
    { key: "attachmentType", label: "Attachment content type", type: "string", placeholder: "text/csv" },
  ],
  sampleOutput: { id: "eml_123", provider: "smtp", delivered: true, status: "sent", messageId: "<abc@example.com>" },
  mode: "live",
  async execute(ctx) {
    return { output: await sendEmail(ctx.app, ctx.workspaceId, ctx.executionId, buildMessage(ctx), ctx.credential) };
  },
  async mock(ctx) {
    return { output: { ...(await sendEmail(ctx.app, ctx.workspaceId, ctx.executionId, buildMessage(ctx), undefined, true)), _mock: true } };
  },
};

export const emailIntegration: IntegrationModule = {
  definition: {
    id: "email",
    name: "Email (SMTP)",
    description: "Send transactional and follow-up emails through any SMTP provider (Gmail/Workspace, Microsoft 365, SES, SendGrid, Mailgun, Postmark…).",
    category: "Communication",
    version: "1.0.0",
    icon: "mail",
    credentialTypes: ["smtp"],
    prerequisites: [
      "An SMTP account. Many providers require domain verification (SPF/DKIM) and have sending quotas or fees.",
      "Recipients must have consented to marketing email where the law requires it (e.g. CAN-SPAM, GDPR).",
    ],
    availability: "live+mock",
    rateLimits: "Determined by your SMTP provider.",
  },
  nodes: [sendNode],
  credentialTypes: [
    {
      id: "smtp",
      name: "SMTP server",
      description: "SMTP credentials for sending email.",
      fields: [
        { key: "host", label: "Host", type: "string", required: true, placeholder: "smtp.example.com" },
        { key: "port", label: "Port", type: "number", required: true, default: 587 },
        { key: "secure", label: "Use TLS from the start (port 465)", type: "boolean", default: false },
        { key: "username", label: "Username", type: "string" },
        { key: "password", label: "Password / app password", type: "string", sensitive: true },
        { key: "from", label: "Default From address", type: "string", placeholder: "Team <team@example.com>" },
      ],
      describe: (d) => ({ account: `${toText(d.username) || "anonymous"}@${toText(d.host)}` }),
      async test(data, app) {
        const host = toText(data.host);
        const port = Number(data.port) || 587;
        await assertSmtpHostAllowed(app, host, port);
        const t = nodemailer.createTransport({ host, port, secure: data.secure === true, auth: data.username ? { user: toText(data.username), pass: toText(data.password) } : undefined, connectionTimeout: 10_000 });
        try {
          await t.verify();
          return { ok: true, message: `Connected to ${host}:${port}.` };
        } finally {
          t.close();
        }
      },
    },
  ],
};
