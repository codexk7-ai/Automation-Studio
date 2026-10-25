# Implementation plan

Each phase lists its acceptance criteria and status. Status reflects automated tests (`npm test`) and checks in the running app.

| Phase | Scope | Acceptance criteria | Status |
|---|---|---|---|
| 1 Audit | Inspect repo, choose stack, write docs | Repo audited (only `rea` present → new monorepo); stack documented | ✅ |
| 2 Foundation | Monorepo, config, DB layer (PGlite/pg), migrations, crypto, SSRF client, logger | App boots with zero setup; migrations checksummed | ✅ |
| 3 Schema & validation | Versioned schema, expressions, graph, validator, redaction | 15 core tests pass (cycles, branches, references, credentials, roles, unsafe expressions) | ✅ |
| 4 Engine | Queue, runner, retries, timeouts, waits, cancellation, recovery, dedupe, loops, events | 13 engine tests pass, including crash recovery and safe retry | ✅ |
| 5 Editor & API | REST API, auth, RBAC, React Flow editor, test runs, versions, import/export | API tests pass; editor checked in the browser | ✅ |
| 6 Triggers & first connectors | Webhooks (HMAC), schedule, HTTP, tables, CSV, email outbox/SMTP | Signed-webhook end-to-end test; HTTP against a mock server | ✅ |
| 7 Integration SDK & connectors | Contract, registry; Google Sheets/YouTube, WhatsApp, HubSpot, Slack, PostgreSQL | Implemented on official APIs with mocks; **not run against live services** | 🟡 |
| 8 AI | Provider abstraction (Anthropic SDK, OpenAI-compatible/Ollama, mock), budgets, validated structured output, bounded agent | Mock path tested end to end; live providers untested here | 🟡 |
| 9 MCP | Server (`/mcp`, stdio), client, registry, policies, audit | Official-SDK client tests for scopes; external server discovery and calls | ✅ |
| 10 Business layer | 11 templates, tables, forms, dashboard, usage | Lead template run end to end in tests and in the browser | ✅ |
| 11 Hardening | CSP, rate limits, CSRF, tenancy tests, redaction tests, SSRF tests | See SECURITY.md | ✅ (with documented limitations) |
| 12 Docs | README, ARCHITECTURE, FEATURE_MATRIX, SECURITY, BUILD_STATUS, docs/* | Written | ✅ |

## Next phases (not started)

1. Browser E2E suite (Playwright) checked into CI. Manual browser verification exists, but there is no automated UI test yet.
2. Live-provider contract tests against sandbox accounts (Google, Meta, HubSpot, Anthropic, Ollama).
3. Editor: undo/redo, auto-layout, keyboard-only connections, inline expression autocomplete.
4. Record-level permissions and per-project roles; SSO (OIDC) and 2FA.
5. Key rotation command, KMS support, shared rate limiter for multi-instance deployments.
6. More connectors based on demand (Microsoft 365, Stripe, Notion, Airtable, Telegram, IMAP).
