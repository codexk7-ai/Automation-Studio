# Build status

_Last updated: 2026-10-25_

## Current state

All 12 phases are implemented. The application builds, starts with documented commands, and runs complete workflows end to end.

### Verification performed

- `npm run typecheck`: all three packages (core, server, web) pass.
- `npm test`: **38/38 tests pass** across 4 files: core expressions/validation (15), engine (13), API/MCP/tables (10).
- `npm run build && npm start`: verified in a browser:
  - sign-in, dashboard with real data, workflow editor (load, select, inspector, test run)
  - public form → AI scoring (mock adapter) → table update → condition → draft → approval → email outbox → table update
  - integrations, MCP, tables, executions, usage and settings pages render
- Bugs found and fixed during verification:
  - the `/mcp` UI route collided with the MCP API endpoint; the page moved to `/mcp-servers` and API path matching is now exact
  - the horizontal layout made large workflows unreadable; the editor now flows top-to-bottom
  - MCP tool policy errors surfaced as HTTP 500; they now return 403/422
  - external MCP tool schemas (JSON Schema 2020-12) failed to compile; switched to Ajv 2020
  - editing a connection could overwrite stored values with field defaults; edits now send only changed fields

### Not verified / known gaps

- Live third-party services (SMTP delivery, Anthropic, Ollama, Google, WhatsApp, HubSpot, Slack, external PostgreSQL) were **not** exercised: no accounts or local runtimes were available (Ollama is not installed and Docker was not running). These adapters are written against the official APIs and pass typechecking.
- `docker compose` was not run (Docker daemon not running).
- No automated browser (Playwright) suite yet. Browser checks were manual.
- In the sample test run of the lead template, the form trigger's sample data references a record ID (`row_1`) that doesn't exist, so the "Save score" step fails with "Record not found". This is expected with sample data. Run the workflow from the real form instead, or edit the test payload.

See FEATURE_MATRIX.md for the per-feature status and SECURITY.md for security limitations.

## Layout

```
automation-studio/
  packages/core/        schema, expressions, validation, graph, redaction (+ tests)
  apps/server/          API, engine, integrations, AI, MCP, CLI (+ tests)
  apps/web/             React UI + React Flow editor
  docs/                 integrations, MCP, operations
  Dockerfile, docker-compose.yml, .env.example
```

## Next steps (in priority order)

1. Add a Playwright E2E test for create → edit → test-run → publish → webhook.
2. Run the live adapters against sandbox accounts and fix discrepancies.
3. Install Ollama, connect it, and verify the AI steps against a real local model.
4. Editor improvements: undo/redo and auto-layout.
5. Record-level permissions, SSO/2FA, key rotation.
