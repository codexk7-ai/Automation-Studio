# Feature matrix

Legend: **✅ Done** = implemented and covered by an automated test or verified in the running app · **🔌 Protocol-verified** = runs against a real protocol server (SMTP, PostgreSQL wire protocol) · **📜 Contract-verified** = the adapter's real request (URL, auth, body) is checked against the provider's documented API shape by a local stand-in; not yet run against the provider with a real account · **🟡 Partial** = implemented, with limitations noted · **❌ Missing**

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
| 14 | AI nodes with a provider or labelled test adapter | ✅ | Mock adapter tested; **Ollama (llama3.2:1b) verified live**: classify, extract, summarize (`npm run test:ai-live`). Anthropic verified against the API contract only (no key) |
| 15 | MCP server exposes authorized tools | ✅ | Official SDK client test with read-only vs read/write/execute tokens |
| 16 | External MCP tools registered and tested safely | ✅ | Test MCP server: discovery, disabled-by-default, schema-validated args, workflow step |
| 17 | Automated tests for critical behaviour | ✅ | Vitest suites (core, engine, API, MCP, tables, integrations, security, production) + live AI suite + Playwright E2E (3 browser journeys) |
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
| Modern UI: light/dark/system theme, command palette (Ctrl+K), collapsible sidebar, mobile drawer, responsive layouts | ✅ | Playwright-tested theme and sidebar persistence; checked at 375px with no horizontal scroll |
| Keyboard accessibility | 🟡 | Palette, forms, modals and shortcuts are keyboard-usable; connecting nodes still needs a pointer |
| Undo/redo in editor | ✅ | Buttons + Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y; drags and coalesced typing; browser-verified |
| Auto-layout ("Tidy up") | ✅ | Layered top-to-bottom layout, branch-ordered; unit-tested and browser-verified |
| Dashboard with real metrics | ✅ | |
| Executions list/detail, filters, pagination, cancel, retry (failed steps / from start) | ✅ | |
| Approvals (human-in-the-loop) | ✅ | Expire after a timeout |
| Data tables: typed columns, CRUD, search, filters, sort, pagination, unique, CSV import/export, retention, table-level roles | ✅ | |
| Per-record permissions | ✅ | Table option "members see only their own records"; admins see all and reassign owners (tested) |
| Forms (public, rate-limited, honeypot) → table + trigger | ✅ | No CAPTCHA |
| Templates (11) creating real tables/forms/drafts | ✅ | |
| Usage page, AI token budgets, cost estimates | ✅ | Cost only for models with known prices |
| Team: members, roles, API tokens with scopes/expiry | ✅ | No email invitations (temporary password shown once) |
| Audit log | ✅ | |
| Projects | 🟡 | Grouping only; permissions are per workspace |
| Two-factor authentication (TOTP) | ✅ | QR enrollment, recovery codes, replay protection, workspace-wide requirement (RFC test vectors + flow tests) |
| SSO (OpenID Connect) | ✅ | PKCE, JWKS signature verification, domain allowlist, auto-create policy; tested against a mock IdP with real RS256 signing. Not yet tried with a specific vendor IdP |

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
| Email via SMTP / local outbox | action | ✅ outbox · 🔌 SMTP (real SMTP server: auth, headers, attachment, bad-password rejection) |
| AI: generate, summarize, classify, extract, transform | action | ✅ mock · 🧪 Anthropic / OpenAI-compatible |
| AI agent with approved MCP tools (bounded) | action | 🧪 needs a real model with tool calling |
| MCP: call tool | action | ✅ |
| Google Sheets append/read | action | 📜 append (header mapping, RAW, bearer) · read implemented |
| YouTube: video details, channel uploads, update metadata, upload video, captions (own videos), new-video trigger | action/trigger | 📜 details (API key) and resumable upload · others implemented |
| WhatsApp Cloud API: template, text reply, incoming-message/status webhook | action/trigger | 📜 template send · ✅ signed inbound webhook → workflow · consent enforcement tested |
| HubSpot: upsert/find contact | action | 📜 search + create |
| Slack incoming webhook | action | 📜 (non-Slack URLs rejected) |
| External PostgreSQL: parameterized query, insert | action | 🔌 real wire protocol: parameters, injection-safe insert, read-only enforcement, single-statement rule |
| Inbound email (IMAP) | — | ❌ use your provider's inbound-parse webhook |
| Lead enrichment providers (Clearbit-style) | — | ❌ use the HTTP step with your provider's API |
| Additional SaaS connectors | — | ❌ add via the integration contract |

## Production operations

| Feature | Status | Notes |
|---|---|---|
| Docker Compose stack: PostgreSQL, API, scalable workers, Caddy auto-HTTPS, nightly backups, optional Ollama | 🟡 | Written and reviewed; **not run here** (Docker daemon unavailable on the build machine) |
| Fail-fast production config checks | ✅ | `production.test.ts` |
| Readiness (`/api/ready`) and Prometheus `/metrics` with bearer token | ✅ | Tested |
| PostgreSQL-backed rate limits (per route, shared across instances) | ✅ | Tested, including per-route isolation |
| `__Host-` session cookies in production | ✅ | Tested |
| Encryption-key rotation CLI | ✅ | Tested end to end through the real CLI |
| Server suite against real PostgreSQL wire protocol | ✅ | `npm run test:postgres` |
| CI (GitHub Actions): tests, Postgres suite, E2E, Docker build | 🟡 | Workflow written; not yet run on GitHub |
