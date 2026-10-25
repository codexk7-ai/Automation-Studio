import type { WorkflowDefinitionInput } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { notFound } from "../errors.ts";
import type { Principal } from "../auth/principal.ts";
import { authorize } from "../auth/principal.ts";
import { createForm } from "./forms.ts";
import { createTable, type ColumnDef } from "./tables.ts";
import { createWorkflow } from "./workflows.ts";

/**
 * Editable business templates. Instantiating a template creates real, fully
 * editable resources (tables, forms, a draft workflow) — nothing is hidden or
 * hard-coded at runtime. External connections must be selected before publishing.
 */
interface TemplateResources {
  tables: Record<string, string>;
  forms: Record<string, string>;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  category: "Lead generation" | "Email" | "WhatsApp" | "YouTube" | "Operations" | "AI";
  description: string;
  integrations: string[];
  /** Setup steps shown after creation. */
  setup: string[];
  tables?: Array<{ key: string; name: string; columns: Array<Partial<ColumnDef> & { name: string }> }>;
  forms?: Array<{ key: string; name: string; tableKey: string; fields: Array<{ key: string; label: string; type: string; required?: boolean; options?: string[] }> }>;
  build(r: TemplateResources): WorkflowDefinitionInput;
}

const LEAD_COLUMNS = [
  { key: "name", name: "Name", type: "text" as const, required: true },
  { key: "email", name: "Email", type: "email" as const, required: true, unique: true },
  { key: "company", name: "Company", type: "text" as const },
  { key: "message", name: "Message", type: "long_text" as const },
  { key: "source", name: "Source", type: "text" as const },
  { key: "score", name: "Score", type: "select" as const, options: ["hot", "warm", "cold"] },
  { key: "score_reason", name: "Score reason", type: "long_text" as const },
  { key: "status", name: "Status", type: "select" as const, options: ["new", "contacted", "qualified", "unsubscribed"] },
  { key: "opted_out", name: "Opted out", type: "boolean" as const },
];


/** Templates are authored left-to-right; the editor flows top-to-bottom, so rotate. */
const at = (x: number, y = 160) => ({ x: Math.round(300 + (y - 160) * 1.7), y: Math.round(40 + (x - 40) * 0.58) });

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: "lead-intake-qualification",
    name: "Lead intake, AI qualification & approved outreach",
    category: "Lead generation",
    description: "Captures leads from a public form, normalizes and de-duplicates them in a Leads table, scores them with AI, drafts a personalized email, and sends it only after a human approves (respecting opt-outs).",
    integrations: ["core", "tables", "ai", "email"],
    setup: [
      "Optional: connect an AI provider (Ollama locally, or Anthropic) on the AI steps — otherwise the mock adapter is used.",
      "Optional: connect SMTP on 'Send email' — otherwise emails go to the local outbox only.",
      "Publish the workflow, then share the form link from Forms.",
    ],
    tables: [{ key: "leads", name: "Leads", columns: LEAD_COLUMNS }],
    forms: [
      {
        key: "contact",
        name: "Contact us",
        tableKey: "leads",
        fields: [
          { key: "name", label: "Your name", type: "text", required: true },
          { key: "email", label: "Work email", type: "email", required: true },
          { key: "company", label: "Company", type: "text" },
          { key: "message", label: "How can we help?", type: "long_text" },
        ],
      },
    ],
    build: (r) => ({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.form_submission", name: "Contact form submitted", config: { formId: r.forms.contact }, position: at(40) },
        { id: "qualify", type: "ai.classify", name: "Score lead", config: { text: "Company: {{ trigger.submission.company }}\nMessage: {{ trigger.submission.message }}", categories: ["hot", "warm", "cold"], instructions: "hot = clear need, budget or timeline; warm = relevant interest; cold = unclear or irrelevant.", effort: "low" }, position: at(300) },
        { id: "save", type: "tables.update_row", name: "Save score", config: { tableId: r.tables.leads, rowId: "{{ trigger.rowId }}", data: { score: "{{ steps.qualify.output.label }}", score_reason: "{{ steps.qualify.output.reasoning }}", status: "new", source: "contact form" } }, position: at(560) },
        { id: "isHot", type: "logic.condition", name: "Hot or warm?", config: { rules: [{ left: "{{ steps.qualify.output.label }}", operator: "not_equals", right: "cold" }] }, position: at(820) },
        { id: "draft", type: "ai.generate", name: "Draft reply", config: { system: "You write short, friendly, specific first replies to inbound sales leads. No false claims, no pricing promises. Sign as 'The team'.", prompt: "Write a reply email body (max 120 words) to {{ trigger.submission.name }} from {{ default(trigger.submission.company, \"their company\") }} who wrote:\n<input>{{ trigger.submission.message }}</input>", effort: "low" }, position: at(1080, 80) },
        { id: "approve", type: "human.approval", name: "Approve outreach", config: { title: "Send reply to {{ trigger.submission.email }}?", message: "Lead scored {{ steps.qualify.output.label }}: {{ steps.qualify.output.reasoning }}", data: { to: "{{ trigger.submission.email }}", body: "{{ steps.draft.output.text }}" }, timeoutHours: 72 }, position: at(1340, 80) },
        { id: "send", type: "email.send", name: "Send email", config: { to: "{{ trigger.submission.email }}", subject: "Re: your message", body: "{{ steps.draft.output.text }}\n\n—\nReply STOP to opt out of further emails." }, position: at(1600, 40) },
        { id: "mark", type: "tables.update_row", name: "Mark contacted", config: { tableId: r.tables.leads, rowId: "{{ trigger.rowId }}", data: { status: "contacted" } }, position: at(1860, 40) },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "qualify" },
        { id: "e2", source: "qualify", target: "save" },
        { id: "e3", source: "save", target: "isHot" },
        { id: "e4", source: "isHot", target: "draft", branch: "true" },
        { id: "e5", source: "draft", target: "approve" },
        { id: "e6", source: "approve", target: "send", branch: "approved" },
        { id: "e7", source: "send", target: "mark" },
      ],
    }),
  },
  {
    id: "webhook-lead-capture",
    name: "Webhook lead capture with de-duplication",
    category: "Lead generation",
    description: "Receives leads from your website or ad platform webhook, validates and normalizes the email, skips opted-out contacts, and upserts into the Leads table.",
    integrations: ["core", "tables"],
    setup: ["Publish, then send POST requests with JSON { name, email, company, source } to the webhook URL shown in the editor.", "Recommended: enable request verification with a webhook secret."],
    tables: [{ key: "leads", name: "Leads", columns: LEAD_COLUMNS }],
    build: (r) => ({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.webhook", name: "Lead webhook", config: { method: "POST", dedupeKey: "{{ lower(trigger.body.email) }}" }, position: at(40) },
        { id: "valid", type: "logic.filter", name: "Valid email?", config: { rules: [{ left: "{{ trigger.body.email }}", operator: "is_email" }] }, position: at(300) },
        { id: "existing", type: "tables.find_rows", name: "Find existing", config: { tableId: r.tables.leads, filters: [{ column: "email", op: "eq", value: "{{ lower(trim(trigger.body.email)) }}" }], limit: 1 }, position: at(560) },
        { id: "optedOut", type: "logic.condition", name: "Opted out?", config: { rules: [{ left: "{{ steps.existing.output.first.data.opted_out }}", operator: "is_true" }] }, position: at(820) },
        { id: "upsert", type: "tables.upsert_row", name: "Save lead", config: { tableId: r.tables.leads, matchColumn: "email", data: { name: "{{ trim(trigger.body.name) }}", email: "{{ lower(trim(trigger.body.email)) }}", company: "{{ trigger.body.company }}", source: "{{ default(trigger.body.source, \"webhook\") }}", status: "new" } }, position: at(1080) },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "valid" },
        { id: "e2", source: "valid", target: "existing" },
        { id: "e3", source: "existing", target: "optedOut" },
        { id: "e4", source: "optedOut", target: "upsert", branch: "false" },
      ],
    }),
  },
  {
    id: "email-triage",
    name: "Inbound email triage & thread summary",
    category: "Email",
    description: "Receives inbound emails via your provider's inbound-parse webhook, classifies them, summarizes the thread, creates a follow-up task record, and notifies the team.",
    integrations: ["core", "ai", "tables", "email"],
    setup: ["Point your email provider's inbound webhook (e.g. SendGrid Inbound Parse, Mailgun Routes, Postmark Inbound) at the webhook URL.", "Map the subject/text fields if your provider uses different names."],
    tables: [
      {
        key: "tasks",
        name: "Follow-up tasks",
        columns: [
          { key: "title", name: "Title", type: "text", required: true },
          { key: "category", name: "Category", type: "select", options: ["sales", "support", "billing", "spam", "other"] },
          { key: "summary", name: "Summary", type: "long_text" },
          { key: "from_email", name: "From", type: "text" },
          { key: "done", name: "Done", type: "boolean" },
        ],
      },
    ],
    build: (r) => ({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.webhook", name: "Inbound email", config: { method: "POST" }, position: at(40) },
        { id: "classify", type: "ai.classify", name: "Classify email", config: { text: "Subject: {{ trigger.body.subject }}\n\n{{ trigger.body.text }}", categories: ["sales", "support", "billing", "spam", "other"], effort: "low" }, position: at(300) },
        { id: "notSpam", type: "logic.filter", name: "Not spam", config: { rules: [{ left: "{{ steps.classify.output.label }}", operator: "not_equals", right: "spam" }] }, position: at(560) },
        { id: "summary", type: "ai.summarize", name: "Summarize thread", config: { text: "{{ trigger.body.text }}", style: "action_items" }, position: at(820) },
        { id: "task", type: "tables.insert_row", name: "Create follow-up task", config: { tableId: r.tables.tasks, data: { title: "{{ truncate(trigger.body.subject, 120) }}", category: "{{ steps.classify.output.label }}", summary: "{{ steps.summary.output.summary }}", from_email: "{{ trigger.body.from }}", done: false } }, position: at(1080) },
        { id: "notify", type: "email.send", name: "Notify team", config: { to: "team@example.com", subject: "[{{ steps.classify.output.label }}] {{ trigger.body.subject }}", body: "From: {{ trigger.body.from }}\n\n{{ steps.summary.output.summary }}" }, position: at(1340) },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "classify" },
        { id: "e2", source: "classify", target: "notSpam" },
        { id: "e3", source: "notSpam", target: "summary" },
        { id: "e4", source: "summary", target: "task" },
        { id: "e5", source: "task", target: "notify" },
      ],
    }),
  },
  {
    id: "whatsapp-support",
    name: "WhatsApp inquiry routing with AI draft replies",
    category: "WhatsApp",
    description: "Classifies incoming WhatsApp messages, logs conversations and consent, drafts a reply with AI, and sends it after approval (within the 24-hour customer service window).",
    integrations: ["whatsapp", "ai", "tables", "core"],
    setup: [
      "Create a WhatsApp Cloud API connection and set the Meta webhook URL to <PUBLIC_URL>/hooks/whatsapp/<connection id> with your verify token.",
      "Select the connection on the trigger and the send step.",
      "Customers who message you first have opted in to replies within 24 hours; record other consent in the Contacts table.",
    ],
    tables: [
      {
        key: "conversations",
        name: "WhatsApp conversations",
        columns: [
          { key: "wa_id", name: "WhatsApp ID", type: "text", required: true },
          { key: "name", name: "Name", type: "text" },
          { key: "message", name: "Message", type: "long_text" },
          { key: "category", name: "Category", type: "select", options: ["sales", "support", "order_status", "other"] },
          { key: "reply_status", name: "Reply status", type: "text" },
        ],
      },
    ],
    build: (r) => ({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.whatsapp_message", name: "Incoming WhatsApp message", config: { includeStatuses: false }, position: at(40) },
        { id: "classify", type: "ai.classify", name: "Classify inquiry", config: { text: "{{ trigger.text }}", categories: ["sales", "support", "order_status", "other"], effort: "low" }, position: at(300) },
        { id: "log", type: "tables.insert_row", name: "Log conversation", config: { tableId: r.tables.conversations, data: { wa_id: "{{ trigger.from }}", name: "{{ trigger.profileName }}", message: "{{ trigger.text }}", category: "{{ steps.classify.output.label }}", reply_status: "pending" } }, position: at(560) },
        { id: "draft", type: "ai.generate", name: "Draft reply", config: { system: "You are a polite customer support agent. Reply in the customer's language, max 3 sentences. Never promise refunds or prices.", prompt: "Category: {{ steps.classify.output.label }}\nCustomer message:\n<input>{{ trigger.text }}</input>", effort: "low" }, position: at(820) },
        { id: "approve", type: "human.approval", name: "Approve reply", config: { title: "Reply to {{ trigger.profileName }} on WhatsApp?", data: { message: "{{ trigger.text }}", reply: "{{ steps.draft.output.text }}" }, timeoutHours: 20 }, position: at(1080) },
        { id: "send", type: "whatsapp.send_text", name: "Send reply", config: { to: "{{ trigger.from }}", body: "{{ steps.draft.output.text }}", replyToMessageId: "{{ trigger.messageId }}", consentConfirmed: "true" }, position: at(1340) },
        { id: "mark", type: "tables.update_row", name: "Record reply", config: { tableId: r.tables.conversations, rowId: "{{ steps.log.output.id }}", data: { reply_status: "{{ steps.send.output.status }}" } }, position: at(1600) },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "classify" },
        { id: "e2", source: "classify", target: "log" },
        { id: "e3", source: "log", target: "draft" },
        { id: "e4", source: "draft", target: "approve" },
        { id: "e5", source: "approve", target: "send", branch: "approved" },
        { id: "e6", source: "send", target: "mark" },
      ],
    }),
  },
  {
    id: "youtube-content",
    name: "YouTube new video → summary, SEO drafts & content calendar",
    category: "YouTube",
    description: "When your channel publishes a video, fetches its details, summarizes the description (or your own captions), drafts improved titles/descriptions for review, and adds it to a content calendar table. Nothing is published without approval.",
    integrations: ["google", "ai", "tables", "core"],
    setup: ["Create a Google connection (API key for public data; OAuth to update videos or read captions).", "Set your channel ID (UC…) on the trigger.", "Add a 'YouTube: update title/description/tags' step after the approval if you want approved drafts applied."],
    tables: [
      {
        key: "calendar",
        name: "Content calendar",
        columns: [
          { key: "video_id", name: "Video ID", type: "text", required: true, unique: true },
          { key: "title", name: "Title", type: "text" },
          { key: "summary", name: "Summary", type: "long_text" },
          { key: "title_ideas", name: "Title ideas", type: "long_text" },
          { key: "repurpose_on", name: "Repurpose on", type: "date" },
          { key: "status", name: "Status", type: "select", options: ["idea", "drafted", "approved", "published"] },
        ],
      },
    ],
    build: (r) => ({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.youtube_new_video", name: "New video on channel", config: { channelId: "UC_your_channel_id", pollMinutes: 60 }, position: at(40) },
        { id: "details", type: "youtube.get_video", name: "Get video details", config: { videoId: "{{ trigger.videoId }}" }, position: at(300) },
        { id: "summary", type: "ai.summarize", name: "Summarize", config: { text: "Title: {{ steps.details.output.title }}\n\n{{ steps.details.output.description }}", style: "bullets" }, position: at(560) },
        { id: "ideas", type: "ai.generate", name: "Draft titles & description", config: { prompt: "Suggest 3 alternative titles (max 70 chars each) and a 2-sentence description for this video. Be accurate; do not invent claims.\n<input>{{ steps.summary.output.summary }}</input>", effort: "low" }, position: at(820) },
        { id: "calendar", type: "tables.upsert_row", name: "Add to content calendar", config: { tableId: r.tables.calendar, matchColumn: "video_id", data: { video_id: "{{ trigger.videoId }}", title: "{{ steps.details.output.title }}", summary: "{{ steps.summary.output.summary }}", title_ideas: "{{ steps.ideas.output.text }}", repurpose_on: "{{ addDays(now(), 7) }}", status: "drafted" } }, position: at(1080) },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "details" },
        { id: "e2", source: "details", target: "summary" },
        { id: "e3", source: "summary", target: "ideas" },
        { id: "e4", source: "ideas", target: "calendar" },
      ],
    }),
  },
  {
    id: "daily-report",
    name: "Daily activity report",
    category: "Operations",
    description: "Every weekday morning, counts new leads and open tasks from your tables and emails a summary to the team.",
    integrations: ["core", "tables", "email"],
    setup: ["Pick the tables to report on and set the recipient address."],
    tables: [{ key: "leads", name: "Leads", columns: LEAD_COLUMNS }],
    build: (r) => ({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.schedule", name: "Weekdays 08:00", config: { mode: "cron", cron: "0 8 * * 1-5", timezone: "UTC" }, position: at(40) },
        { id: "leads", type: "tables.find_rows", name: "Recent leads", config: { tableId: r.tables.leads, filters: [], limit: 1000 }, position: at(300) },
        { id: "byScore", type: "transform.aggregate", name: "Count by score", config: { items: "{{ pluck(steps.leads.output.rows, \"data\") }}", operation: "group_count", field: "score" }, position: at(560) },
        { id: "email", type: "email.send", name: "Email report", config: { to: "team@example.com", subject: "Daily report {{ today() }}", body: "Leads in table: {{ steps.leads.output.total }}\nBy score: {{ json(steps.byScore.output.result) }}" }, position: at(820) },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "leads" },
        { id: "e2", source: "leads", target: "byScore" },
        { id: "e3", source: "byScore", target: "email" },
      ],
    }),
  },
  {
    id: "scheduled-export",
    name: "Weekly CSV export by email",
    category: "Operations",
    description: "Exports a table to CSV every Monday and emails it as an attachment.",
    integrations: ["core", "tables", "email"],
    setup: ["Choose the table and recipient."],
    tables: [{ key: "leads", name: "Leads", columns: LEAD_COLUMNS }],
    build: (r) => ({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.schedule", name: "Mondays 07:00", config: { mode: "cron", cron: "0 7 * * 1", timezone: "UTC" }, position: at(40) },
        { id: "export", type: "tables.export_csv", name: "Export table", config: { tableId: r.tables.leads }, position: at(300) },
        { id: "email", type: "email.send", name: "Email CSV", config: { to: "ops@example.com", subject: "Weekly export ({{ steps.export.output.count }} rows)", body: "Attached.", attachmentName: "{{ steps.export.output.filename }}", attachmentContent: "{{ steps.export.output.csv }}", attachmentType: "text/csv" }, position: at(560) },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "export" },
        { id: "e2", source: "export", target: "email" },
      ],
    }),
  },
  {
    id: "failure-alerts",
    name: "Workflow failure alerts",
    category: "Operations",
    description: "Sends an email (and optionally Slack) whenever any workflow in this workspace fails.",
    integrations: ["core", "email", "slack"],
    setup: ["Set the alert recipient. Add a Slack step with an incoming-webhook connection if you use Slack."],
    build: () => ({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.execution_failed", name: "Any workflow failed", config: {}, position: at(40) },
        { id: "email", type: "email.send", name: "Email alert", config: { to: "ops@example.com", subject: "Workflow failed: {{ trigger.workflowName }}", body: "Execution {{ trigger.executionId }} failed.\nError: {{ trigger.error.message }}\n{{ trigger.url }}" }, position: at(300) },
      ],
      edges: [{ id: "e1", source: "trigger", target: "email" }],
    }),
  },
  {
    id: "support-routing",
    name: "Support ticket routing",
    category: "Operations",
    description: "Classifies support tickets submitted via a form, routes them by category with a Switch, and stores them in a Tickets table with priority.",
    integrations: ["core", "ai", "tables"],
    setup: ["Adjust categories and the routing branches to match your team."],
    tables: [
      {
        key: "tickets",
        name: "Tickets",
        columns: [
          { key: "email", name: "Email", type: "email", required: true },
          { key: "subject", name: "Subject", type: "text", required: true },
          { key: "details", name: "Details", type: "long_text" },
          { key: "category", name: "Category", type: "select", options: ["bug", "billing", "how_to", "feature_request"] },
          { key: "priority", name: "Priority", type: "select", options: ["high", "normal"] },
          { key: "team", name: "Team", type: "text" },
        ],
      },
    ],
    forms: [
      {
        key: "support",
        name: "Support request",
        tableKey: "tickets",
        fields: [
          { key: "email", label: "Email", type: "email", required: true },
          { key: "subject", label: "Subject", type: "text", required: true },
          { key: "details", label: "Details", type: "long_text" },
        ],
      },
    ],
    build: (r) => ({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.form_submission", name: "Support form", config: { formId: r.forms.support }, position: at(40) },
        { id: "classify", type: "ai.classify", name: "Categorize", config: { text: "{{ trigger.submission.subject }}\n{{ trigger.submission.details }}", categories: ["bug", "billing", "how_to", "feature_request"], effort: "low" }, position: at(300) },
        { id: "route", type: "logic.switch", name: "Route by category", config: { value: "{{ steps.classify.output.label }}", cases: [{ branch: "bug", equals: "bug" }, { branch: "billing", equals: "billing" }] }, position: at(560) },
        { id: "eng", type: "tables.update_row", name: "Assign engineering (high)", config: { tableId: r.tables.tickets, rowId: "{{ trigger.rowId }}", data: { category: "{{ steps.classify.output.label }}", team: "engineering", priority: "high" } }, position: at(820, 40) },
        { id: "fin", type: "tables.update_row", name: "Assign finance", config: { tableId: r.tables.tickets, rowId: "{{ trigger.rowId }}", data: { category: "billing", team: "finance", priority: "normal" } }, position: at(820, 180) },
        { id: "gen", type: "tables.update_row", name: "Assign support", config: { tableId: r.tables.tickets, rowId: "{{ trigger.rowId }}", data: { category: "{{ steps.classify.output.label }}", team: "support", priority: "normal" } }, position: at(820, 320) },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "classify" },
        { id: "e2", source: "classify", target: "route" },
        { id: "e3", source: "route", target: "eng", branch: "bug" },
        { id: "e4", source: "route", target: "fin", branch: "billing" },
        { id: "e5", source: "route", target: "gen", branch: "default" },
      ],
    }),
  },
  {
    id: "customer-onboarding",
    name: "Customer onboarding sequence",
    category: "Email",
    description: "When a customer is added to the Customers table, sends a welcome email, waits 3 days, and sends a check-in email unless they were marked as onboarded.",
    integrations: ["core", "tables", "email"],
    setup: ["Add customers to the Customers table (manually, by CSV import, or from another workflow)."],
    tables: [
      {
        key: "customers",
        name: "Customers",
        columns: [
          { key: "name", name: "Name", type: "text", required: true },
          { key: "email", name: "Email", type: "email", required: true, unique: true },
          { key: "plan", name: "Plan", type: "text" },
          { key: "onboarded", name: "Onboarded", type: "boolean" },
        ],
      },
    ],
    build: (r) => ({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.table_record", name: "Customer added", config: { tableId: r.tables.customers, on: "created" }, position: at(40) },
        { id: "welcome", type: "email.send", name: "Welcome email", config: { to: "{{ trigger.row.data.email }}", subject: "Welcome aboard, {{ trigger.row.data.name }}!", body: "Hi {{ trigger.row.data.name }},\n\nThanks for choosing us. Reply to this email if you need anything." }, position: at(300) },
        { id: "wait", type: "logic.delay", name: "Wait 3 days", config: { mode: "duration", amount: 3, unit: "days" }, position: at(560) },
        { id: "check", type: "tables.find_rows", name: "Reload customer", config: { tableId: r.tables.customers, filters: [{ column: "email", op: "eq", value: "{{ trigger.row.data.email }}" }], limit: 1 }, position: at(820) },
        { id: "notDone", type: "logic.filter", name: "Not onboarded yet", config: { rules: [{ left: "{{ steps.check.output.first.data.onboarded }}", operator: "is_false" }] }, position: at(1080) },
        { id: "checkin", type: "email.send", name: "Check-in email", config: { to: "{{ trigger.row.data.email }}", subject: "How is it going?", body: "Hi {{ trigger.row.data.name }}, any questions so far? Just reply." }, position: at(1340) },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "welcome" },
        { id: "e2", source: "welcome", target: "wait" },
        { id: "e3", source: "wait", target: "check" },
        { id: "e4", source: "check", target: "notDone" },
        { id: "e5", source: "notDone", target: "checkin" },
      ],
    }),
  },
  {
    id: "crm-sync",
    name: "CRM sync: new leads to HubSpot",
    category: "Lead generation",
    description: "Pushes qualified leads from the Leads table to HubSpot as contacts.",
    integrations: ["core", "tables", "hubspot"],
    setup: ["Create a HubSpot private-app connection and select it on the HubSpot step."],
    tables: [{ key: "leads", name: "Leads", columns: LEAD_COLUMNS }],
    build: (r) => ({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger.table_record", name: "Lead updated", config: { tableId: r.tables.leads, on: "updated" }, position: at(40) },
        { id: "qualified", type: "logic.filter", name: "Hot leads only", config: { rules: [{ left: "{{ trigger.row.data.score }}", operator: "equals", right: "hot" }] }, position: at(300) },
        { id: "hubspot", type: "hubspot.upsert_contact", name: "Upsert HubSpot contact", config: { email: "{{ trigger.row.data.email }}", properties: { firstname: "{{ first(split(trigger.row.data.name, \" \")) }}", company: "{{ trigger.row.data.company }}", hs_lead_status: "NEW" } }, position: at(560) },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "qualified" },
        { id: "e2", source: "qualified", target: "hubspot" },
      ],
    }),
  },
];

export function listTemplates() {
  return TEMPLATES.map(({ build: _b, ...t }) => t);
}

export async function instantiateTemplate(app: AppContext, p: Principal, templateId: string, opts: { name?: string; projectId?: string } = {}) {
  authorize(p, "editor", "write");
  const tpl = TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) throw notFound("Template");
  const resources: TemplateResources = { tables: {}, forms: {} };
  const created: { tables: Array<{ id: string; name: string }>; forms: Array<{ id: string; name: string; slug: string }> } = { tables: [], forms: [] };
  for (const t of tpl.tables ?? []) {
    const existing = await app.db.one<{ id: string }>("SELECT id FROM data_tables WHERE workspace_id = $1 AND lower(name) = lower($2)", [p.workspaceId, t.name]);
    if (existing) resources.tables[t.key] = existing.id;
    else {
      const table = await createTable(app, p, { name: t.name, columns: t.columns, projectId: opts.projectId });
      resources.tables[t.key] = table.id;
      created.tables.push({ id: table.id, name: table.name });
    }
  }
  for (const f of tpl.forms ?? []) {
    const form = await createForm(app, p, { name: f.name, fields: f.fields, tableId: resources.tables[f.tableKey], isPublic: true });
    resources.forms[f.key] = form.id;
    created.forms.push({ id: form.id, name: form.name, slug: form.slug });
  }
  const workflow = await createWorkflow(app, p, { name: opts.name || tpl.name, description: tpl.description, definition: tpl.build(resources), projectId: opts.projectId, templateId: tpl.id });
  return { workflow, created, setup: tpl.setup };
}
