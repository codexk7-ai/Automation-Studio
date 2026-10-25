# Feature matrix

Legend: **✅ Done** = implemented and covered by an automated test or verified in the running app · **🟡 Partial** = implemented, with limitations noted · **🧪 Untested-live** = implemented against the provider's official API but not exercised against the real service (no credentials in this environment) · **❌ Missing**

## The 20 acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Create and save a workflow | ✅ | `api.test.ts` "end-to-end workflow"; verified in the browser |
| 2 | Visual editor loads the saved workflow | ✅ | Verified in the browser (template workflow, 8 steps) |
| 3 | Workflow validation | ✅ | `validate.test.ts`; publish rejects invalid drafts (422) |
| 4 | A trigger starts an execution | ✅ | Signed webhook, form, manual, event and schedule paths (tests) |
| 5 | Multiple connected steps execute | ✅ | `engine.test.ts` |
| 6 | Outputs mapped into later steps | ✅ | `engine.test.ts`, `api.test.ts` |
| 7 | Conditions route execution | ✅ | Condition and switch branches (tests) |
| 8 | Execution state is persisted | ✅ | `execution_steps`, `step_attempts`; crash-recovery test |
| 9 | Failures visible in execution history | ✅ | Executions / Failed pages; API tests |
| 10 | Eligible steps retried safely | ✅ | "retries only failed steps without repeating succeeded side effects" |
| 11 | Activate and pause | ✅ | Publish / pause / resume test (paused webhook returns 409) |
| 12 | One complete end-to-end integration | ✅ | Form → AI (mock) → table → approval → email outbox, tested and run live; HTTP integration against a mock server |
| 13 | Missing credentials don't break local dev | ✅ | Mock adapters, local email outbox, test-run simulation |
| 14 | AI nodes with a provider or labelled test adapter | 🟡 | Mock adapter tested. Anthropic (official SDK) and OpenAI-compatible/Ollama adapters typecheck but were **not run against a live model here** |
| 15 | MCP server exposes authorized tools | ✅ | Official SDK client test with read-only vs read/write/execute tokens |
| 16 | External MCP tools registered and tested safely | ✅ | Test MCP server: discovery, disabled-by-default, schema-validated args, workflow step |
| 17 | Automated tests for critical behaviour | ✅ | 38 tests (core, engine, API, MCP, tables) |
| 18 | Tenant and credential access controls | ✅ | Cross-tenant read/reference tests, CSRF, roles, secret redaction |
| 19 | Start with documented commands | ✅ | `npm run setup && npm run dev` / `npm run build && npm start` (verified) |
| 20 | Unsupported capabilities documented | ✅ | This file, SECURITY.md, BUILD_STATUS.md |

## Platform features

| Feature | Status | Notes |
|---|---|---|
| Visual editor: drag/drop, connect, move, select, duplicate (Ctrl+D), delete, zoom/pan/fit, minimap | ✅ | React Flow |
| Node config forms from field schemas, expression highlighting, insert mapped values | ✅ | |
| Input/output samples, latest outputs, sensitive values redacted | ✅ | |
| Live validation, error badges, issue list | ✅ | |
| Save draft (Ctrl+S), optimistic-concurrency check | ✅ | API supports `expectedUpdatedAt` |
| Versions: publish, list, restore to draft | ✅ | |
| Test a single step with sample input | ✅ | Runs ancestors' sample outputs into the step |
| Test whole workflow with "simulate external actions" | ✅ | |
| Per-node execution status on the canvas | ✅ | |
| Import/export validated JSON | ✅ | Credentials stripped on export |
| Keyboard accessibility | 🟡 | Palette, forms, modals and shortcuts are keyboard-usable; connecting nodes still needs a pointer |
| Undo/redo in editor | ❌ | |
| Auto-layout | ❌ | Templates come pre-laid-out |
| Dashboard with real metrics | ✅ | |
| Executions list/detail, filters, pagination, cancel, retry (failed steps / from start) | ✅ | |
| Approvals (human-in-the-loop) | ✅ | Expire after a timeout |
| Data tables: typed columns, CRUD, search, filters, sort, pagination, unique, CSV import/export, retention, table-level roles | ✅ | Access control is per **table** (min read/write role), not per individual record |
| Forms (public, rate-limited, honeypot) → table + trigger | ✅ | No CAPTCHA |
| Templates (11) creating real tables/forms/drafts | ✅ | |
| Usage page, AI token budgets, cost estimates | ✅ | Cost only for models with known prices |
| Team: members, roles, API tokens with scopes/expiry | ✅ | No email invitations (temporary password shown once) |
| Audit log | ✅ | |
| Projects | 🟡 | Grouping only; permissions are per workspace |
| SSO / 2FA | ❌ | |

## Integrations

| Connector | Triggers / actions | Status |
|---|---|---|
| Manual, webhook (+HMAC/shared secret, dedupe, respond-to-webhook), schedule (cron/interval, TZ) | triggers | ✅ |
| Table record changed, form submitted, workflow failed | triggers | ✅ |
| JSON feed polling | trigger | 🟡 logic tested indirectly; no dedicated test |
| Condition, switch, filter, delay, loop, sub-workflow, stop, approval, respond-to-webhook | logic | ✅ |
| Set fields, map list, filter/sort/limit list, aggregate, text utilities | transform | ✅ (core paths) |
| HTTP request (SSRF-guarded) | action | ✅ |
| Data tables (create/update/upsert/find/delete/export) | action | ✅ |
| CSV parse/generate | action | ✅ |
| Email via SMTP / local outbox | action | ✅ outbox · 🧪 SMTP send |
| AI: generate, summarize, classify, extract, transform | action | ✅ mock · 🧪 Anthropic / OpenAI-compatible |
| AI agent with approved MCP tools (bounded) | action | 🧪 needs a real model with tool calling |
| MCP: call tool | action | ✅ |
| Google Sheets append/read | action | 🧪 |
| YouTube: video details, channel uploads, update metadata, captions (own videos), new-video trigger | action/trigger | 🧪 |
| WhatsApp Cloud API: template, text reply, incoming-message/status webhook | action/trigger | 🧪 (signature verification and parsing implemented) |
| HubSpot: upsert/find contact | action | 🧪 |
| Slack incoming webhook | action | 🧪 |
| External PostgreSQL: parameterized query, insert | action | 🧪 |
| YouTube video upload/publish | — | ❌ (large uploads and API audit for public visibility) |
| Inbound email (IMAP) | — | ❌ use your provider's inbound-parse webhook |
| Lead enrichment providers (Clearbit-style) | — | ❌ use the HTTP step with your provider's API |
| Additional SaaS connectors | — | ❌ add via the integration contract |
