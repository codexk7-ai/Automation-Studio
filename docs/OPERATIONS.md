# Operations

## Configuration

All settings are environment variables. See `.env.example`, which documents each one. Required: `ENCRYPTION_KEY`, a 64-character hex string that `npm run setup` generates. In production you also need `NODE_ENV=production`, `PUBLIC_URL` (https), `SECURE_COOKIES=true`, `ALLOW_REGISTRATION=false` once accounts exist, and PostgreSQL through `DATABASE_URL`.

## Health and monitoring

- `GET /api/health`: database connectivity, driver and worker mode. Returns 503 when the database is unreachable. Used by the Docker HEALTHCHECK.
- Logs are structured JSON on stdout/stderr with secrets redacted. Set `LOG_LEVEL` to debug, info, warn or error.
- Metrics: the Usage page and `GET /api/usage` (runs, failures, steps, AI tokens and cost, MCP calls, queue depth), plus `GET /api/dashboard`.

## Scaling

- With PGlite, run a single process (`WORKER_MODE=embedded`).
- With PostgreSQL, run one or more API instances with `WORKER_MODE=off` and any number of `npm run worker` processes. Jobs are claimed with `FOR UPDATE SKIP LOCKED` and executions are leased, so workers never double-run a step. Rate limits are in-memory per API instance.

## Backup and restore

**Always back up `ENCRYPTION_KEY` separately.** Without it, stored connections cannot be decrypted.

PostgreSQL:

```bash
pg_dump --format=custom --file=automation-$(date +%F).dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" automation-YYYY-MM-DD.dump
```

With Docker Compose:

```bash
docker compose exec postgres pg_dump -U automation -Fc automation > backup.dump
```

Embedded PGlite: stop the server, then copy the data directory (default `apps/server/.data/pglite`) somewhere safe. To restore, stop the server and copy the directory back. For portability, move to PostgreSQL with a logical dump. PGlite can export one with its `dumpDataDir` API, or you can switch to `DATABASE_URL` from the start.

## Migrations

Migrations run automatically at startup, or manually with `npm run migrate`. They are checksummed: never edit an applied migration; add a new file such as `002_*.sql`.

## Data retention

- Execution history: workspace setting, 90 days by default.
- Table rows: optional per-table retention.
- Done jobs: 1 day. Expired sessions and OAuth states: purged. Dedupe keys: 30 days.

Maintenance runs every 10 minutes inside the worker.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "ENCRYPTION_KEY is not set: using a temporary key" | Run `npm run setup` (creates `.env`), then restart |
| Connections fail to decrypt after a restart | `ENCRYPTION_KEY` changed. Restore the original key |
| Executions stay "queued" | The worker isn't running: use `WORKER_MODE=embedded`, or start `npm run worker` (PostgreSQL) |
| "resolves to a private or reserved address" | Expected SSRF protection. Add `host:port` to `OUTBOUND_ALLOWLIST` if the target is trusted |
| AI step output has `_mock: true` | No AI connection is selected on the step. Add one (see INTEGRATIONS.md) |
| Emails show "captured" | No SMTP configured. Add an SMTP connection or `SMTP_*` settings |
| Webhook returns 409 | Workflow is paused: resume it |
| Webhook returns 401 | Signature or secret mismatch. Check the header name, secret and HMAC over the raw body |
| Google "OAuth is not configured" | Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then restart |
| Too many login attempts | Wait 1 minute (IP limit) or 15 minutes (account lockout) |
| `mcp:stdio` fails with a locked database | PGlite is single-process: stop the API, or use the HTTP endpoint |
