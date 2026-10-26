# Build status

_Last updated: 2026-10-26_

## Current state

All 12 phases are implemented, plus a production-hardening pass and a redesigned UI. Verification is below. Run `npm run typecheck`, `npm test` and `npm run test:e2e` to reproduce it.

### Verified on this machine

- **Typecheck, unit/integration tests and build** pass. Run the suites with `npm test`; `npm run test:postgres` runs the server suite against the real PostgreSQL wire protocol.
- **Playwright E2E (Chromium, production build):**
  - register → command palette → create workflow → add/configure a step → undo/redo → save → test run → publish → execution output
  - template → public form → approval → email outbox
  - theme and sidebar persistence
- **Live AI:** Ollama 0.40 with `llama3.2:1b`; classify, extract and summarize all returned correct, schema-valid output (`npm run test:ai-live`).
- **SMTP:** delivery to a real SMTP server (auth, headers, attachment).
- **External PostgreSQL:** a real wire-protocol server.
- **Security:** TOTP RFC vectors, the 2FA flow, lockout across password and 2FA attempts, workspace 2FA requirement, per-record permissions, and OIDC SSO with a mock IdP (real RS256).
- **Production:** fail-fast config, `/api/ready`, `/metrics` auth, `__Host-` cookie, per-route PostgreSQL rate limits, and key rotation through the real CLI.
- **Docker production stack** (`DOMAIN=localhost`):
  - Caddy HTTPS with an HTTP→HTTPS redirect, security headers and a `__Host-` Secure cookie; `/metrics` returns 404 publicly and requires the token internally
  - Playwright E2E 3/3 over HTTPS against the containers
  - 40 webhook runs across 3 workers, all succeeded with no duplicate executions
  - backup restore drill matched the live database row for row
- **Server suite on PostgreSQL 17** (Docker container): 40/40.
- **UI redesign:** checked in a browser in light and dark themes, the editor, the command palette and the mobile drawer at 375px (no horizontal scroll).

### Not verified / known gaps

- **A real-domain Let's Encrypt certificate** was not issued. Only Caddy's internal CA for `localhost` was used.
- **The CI workflow** has not run on GitHub yet.
- **Vendor services with real accounts were not exercised:** Anthropic, Google Sheets/YouTube, WhatsApp, HubSpot, Slack and a vendor OIDC IdP. They are tested against their documented API contracts with mock servers.
- **No independent security review or penetration test.** See SECURITY.md for the limitations.

See FEATURE_MATRIX.md for the per-feature status.

## Layout

```
automation-studio/
  packages/core/        schema, expressions, validation, graph, redaction (+ tests)
  apps/server/          API, engine, integrations, AI, MCP, CLI (+ tests)
  apps/web/             React UI + React Flow editor
  e2e/                  Playwright browser tests
  deploy/               Caddyfile, backup script
  docs/                 deployment, integrations, MCP, operations
  Dockerfile, docker-compose.yml, .env.example, .github/workflows/ci.yml
```

## Next steps (in priority order)

1. Deploy with `docker compose` on a server with a real domain (docs/DEPLOYMENT.md) and repeat the restore drill there.
2. Push to GitHub so CI runs.
3. Connect real vendor sandbox accounts (Google, WhatsApp, HubSpot, Slack, Anthropic, your OIDC IdP) and run each connector once.
4. Commission an independent security review before handling sensitive customer data.
