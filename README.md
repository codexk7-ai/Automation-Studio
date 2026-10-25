# Automation Studio

A local-first, extensible workflow automation platform: visual workflow editor, durable execution engine, integrations, AI steps, MCP server and client, data tables and forms, with tenant isolation, RBAC and encrypted credentials.

"Automation Studio" is a placeholder brand. Set `BRAND_NAME` in `.env` to rename the UI and MCP server.

## Quick start (no Docker, no cloud accounts)

Requirements: Node.js 22.12 or later, and npm.

```bash
npm install
npm run setup      # creates .env with a generated ENCRYPTION_KEY
npm run seed       # optional demo workspace: demo@automation.local / demo-password-123
npm run dev        # web on http://localhost:5173, API on http://localhost:8787
```

Production-style single process:

```bash
npm run build
npm start          # serves the UI and API on http://localhost:8787
```

The default database is **PGlite**, a real PostgreSQL engine embedded in Node. Its data lives in `apps/server/.data/pglite`. To use a PostgreSQL server instead, set `DATABASE_URL`. With PostgreSQL you can run the API and any number of workers as separate processes (`WORKER_MODE=off` on the API, plus `npm run worker`).

### Docker (PostgreSQL + API + worker)

```bash
npm run setup                      # then add POSTGRES_PASSWORD=... to .env
docker compose up -d --build
docker compose --profile ai up -d  # optional local Ollama
```

## What works locally without accounts

| Area | Status |
|---|---|
| Visual editor, validation, versions, import/export | Works |
| Manual, webhook, schedule, table, form and failure triggers | Works |
| Logic: condition, switch, filter, delay, loop, sub-workflow, approval | Works |
| Data: tables, CSV, transforms | Works |
| Generic HTTP requests (public URLs; private networks blocked) | Works |
| Email | Captured in a local outbox, **not delivered**, until SMTP is configured |
| AI steps | Mock test adapter (labelled `_mock: true`) until you connect Ollama (free, local) or a hosted provider |
| MCP server (`/mcp`) and external MCP client | Works |
| Google Sheets / YouTube, WhatsApp, HubSpot, Slack, external PostgreSQL | Need your own accounts; simulated in test runs |

See [FEATURE_MATRIX.md](FEATURE_MATRIX.md) for the full, honest status.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | API (with embedded worker) + Vite dev server |
| `npm run build` / `npm start` | Production build / start |
| `npm run worker` | Standalone worker (PostgreSQL only) |
| `npm run migrate` | Apply database migrations (also run automatically at startup) |
| `npm run seed` | Demo data (refuses to run in production) |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run typecheck` | TypeScript checks for all packages |
| `npm run mcp:stdio` | MCP over stdio (`AUTOMATION_STUDIO_TOKEN` required) |

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): components, data model, execution model, expression language
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md): phases and acceptance criteria
- [FEATURE_MATRIX.md](FEATURE_MATRIX.md): what is implemented, tested, partial or missing
- [SECURITY.md](SECURITY.md): controls and known limitations
- [BUILD_STATUS.md](BUILD_STATUS.md): current state, test results, next steps
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): connector setup, prerequisites and costs
- [docs/MCP.md](docs/MCP.md): connecting MCP clients and external servers
- [docs/OPERATIONS.md](docs/OPERATIONS.md): configuration, backup/restore, troubleshooting
