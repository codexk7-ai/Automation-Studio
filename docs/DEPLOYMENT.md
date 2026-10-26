# Deploying to production

The production stack in `docker-compose.yml` runs:

| Service | Role |
|---|---|
| `postgres` | PostgreSQL 17, data in the `pgdata` volume |
| `api` | Control plane: UI, REST API, webhooks, `/mcp` (`WORKER_MODE=off`) |
| `worker` | Execution plane; scale horizontally |
| `caddy` | Reverse proxy with automatic HTTPS (Let's Encrypt) |
| `backup` | Nightly `pg_dump` into `./backups` with retention |
| `ollama` | Optional local AI runtime (`--profile ai`) |

## 1. Prerequisites

- A Linux server with Docker Engine and the Compose plugin.
- A DNS name (e.g. `automate.example.com`) whose A/AAAA records point at the server.
- Ports 80 and 443 open (Caddy needs 80 for the ACME challenge).

## 2. Configure

```bash
npm run setup            # or copy .env.example to .env and generate ENCRYPTION_KEY
```

Add these values to `.env`:

| Variable | Value |
|---|---|
| `DOMAIN` | Your DNS name. `PUBLIC_URL` becomes `https://$DOMAIN` |
| `POSTGRES_PASSWORD` | A long random password |
| `ACME_EMAIL` | Contact address for certificate expiry notices (required; any address for a `localhost` trial) |
| `METRICS_TOKEN` | Random string; enables `/metrics` for Prometheus |
| `ALLOW_REGISTRATION` | `false` once your own account exists (or use SSO) |
| `SMTP_*` | Optional, for real email delivery (otherwise mail stays in the outbox) |
| `OIDC_*` | Optional single sign-on (see docs/OPERATIONS.md) |

Generate random values with `openssl rand -hex 32`.

Compose sets `NODE_ENV=production`, `SECURE_COOKIES=true`, `TRUST_PROXY=true` and `DATABASE_URL`. At startup the server **refuses to start** when production settings are unsafe: a non-https `PUBLIC_URL`, insecure cookies, no `DATABASE_URL` or no `ENCRYPTION_KEY`. Weaker settings (open registration, no `METRICS_TOKEN`) are logged as warnings. `ALLOW_UNSAFE_PRODUCTION_CONFIG=true` turns the errors into warnings; use it only for a short staging test.

**Store `ENCRYPTION_KEY` in a password manager.** Without it, stored connections cannot be decrypted, even from a backup.

## 3. Start

```bash
docker compose up -d --build
docker compose ps                      # api should become "healthy"
docker compose logs -f api
```

Open `https://$DOMAIN`, create the owner account, then set `ALLOW_REGISTRATION=false` and run `docker compose up -d` again.

For a local trial without a domain, use `DOMAIN=localhost`. Caddy then serves a certificate from its internal CA, which your browser will warn about.

## 4. Scale

```bash
docker compose up -d --scale worker=3
```

Workers claim jobs with `FOR UPDATE SKIP LOCKED` and hold execution leases, so you can add or remove them at any time. Rate limits are stored in PostgreSQL, so they hold across API instances. Run more `api` replicas behind your own load balancer if needed.

## 5. Health and monitoring

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness (process up) |
| `GET /api/ready` | Readiness: database reachable and migrations applied |
| `GET /metrics` | Prometheus text format; requires `Authorization: Bearer $METRICS_TOKEN`; returns 404 when the token is unset |

Caddy blocks `/metrics` from the internet. Scrape it from inside the Docker network (`http://api:8787/metrics`) or from the host. The metrics cover:

- executions by status and job queue depth/lag
- pending approvals, AI tokens and active workflows
- HTTP request counts and durations
- process memory and uptime

Each request is logged as structured JSON (method, route, status, duration), with secrets redacted.

## 6. Backups and restore

The `backup` service writes `./backups/automation-<timestamp>.dump` every 24 hours and deletes dumps older than `BACKUP_KEEP_DAYS` (default 14). Copy `./backups` off the server, for example with restic or rclone.

To restore:

```bash
docker compose stop api worker
docker compose exec -T postgres pg_restore -U automation -d automation --clean --if-exists < backups/automation-<timestamp>.dump
docker compose start api worker
```

Restore drills are your responsibility. Test one before you rely on the backups.

## 7. Rotating the encryption key

`rotate-key` re-encrypts every stored credential and 2FA secret from `ENCRYPTION_KEY` to `NEW_ENCRYPTION_KEY` in one transaction, then verifies that each one decrypts.

```bash
docker compose stop api worker
docker compose run --rm -e NEW_ENCRYPTION_KEY=<64 hex chars> api node dist/rotate-key.js
# put the new key in .env as ENCRYPTION_KEY, then:
docker compose up -d
```

Outside Docker: `NEW_ENCRYPTION_KEY=… npm run rotate-key`.

## 8. Upgrades

```bash
git pull
docker compose up -d --build
```

Migrations run automatically at startup. They are checksummed and applied once. Take a backup first.

## 9. Security checklist

- [ ] HTTPS works and `PUBLIC_URL` is `https://…`
- [ ] `ALLOW_REGISTRATION=false`, or SSO with `OIDC_ALLOWED_DOMAINS`
- [ ] 2FA required for the workspace (Settings → Workspace)
- [ ] `ENCRYPTION_KEY` and `POSTGRES_PASSWORD` stored outside the server
- [ ] Backups copied off-site, and a restore tested
- [ ] `/metrics` scraped internally only
- [ ] Docker host patched; only ports 80/443 (and SSH) exposed

Read the known limitations in [SECURITY.md](../SECURITY.md) before you go live.

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

1. Typecheck, unit/integration tests, build, and Playwright E2E.
2. The server suite against a real PostgreSQL 17 service (`npm run test:postgres`).
3. A Docker image build.
