# Deploying to Vercel

Automation Studio runs on Vercel as:

| Part | Where it runs |
|---|---|
| Web app (React) | Vercel CDN (static files) |
| API, webhooks (`/hooks`), MCP (`/mcp`), `/metrics` | One Node.js Vercel Function (`api`) |
| Database | Neon PostgreSQL (Vercel Marketplace) |
| Background work | Drained right after the request that queued it, plus `/api/internal/tick` every 5 minutes |

`npm run build:vercel` writes the complete deployment to `.vercel/output` ([Build Output API](https://vercel.com/docs/build-output-api)). Vercel deploys that output as-is, and you can run the same artifact locally (see [Test the deployment locally](#test-the-deployment-locally)).

## How background work runs without a server

Vercel functions stop when they are idle, so there is no always-on worker:

1. **Right after a trigger.** When a webhook, form, manual run or approval queues work, the same function keeps running in the background (`waitUntil`) and processes the queue for up to 25 seconds. Short delays and quick retries inside that window are waited for.
2. **Every 5 minutes**, the scheduled GitHub Action `.github/workflows/queue-tick.yml` calls `GET /api/internal/tick` with `CRON_SECRET`. The tick fires due schedules and polling triggers, resumes longer delays and retries, expires approvals and runs retention.
3. **Once a day**, Vercel Cron calls the same endpoint as a fallback. Hobby plans allow one cron run per day.

On Vercel, this means:

- A schedule set to "every minute" runs at most every ~5 minutes, and GitHub can delay scheduled Actions when it is busy.
- A long delay step resumes on the first tick after it is due.
- On a Pro plan you can delete the GitHub Action and change the cron in `scripts/vercel-build.mjs` to `*/1 * * * *`.

If you need exact timing or long-running steps, use the Docker deployment instead ([DEPLOYMENT.md](DEPLOYMENT.md)).

## Step by step

### 1. Push the code to GitHub

```bash
gh auth login
gh repo create automation-studio --private --source . --push
```

### 2. Create the Vercel project

1. In the Vercel dashboard, choose **Add New → Project**, then import the GitHub repository. Leave the framework preset as **Other**. `vercel.json` already sets the install and build commands.
2. Before deploying, open the project's **Storage** tab and choose **Create Database → Neon**, then connect it to the project. This sets `DATABASE_URL` for all environments.
3. Under **Settings → Environment Variables**, add the variables below for **Production**. Add them to **Preview** too if you use preview deployments.

| Variable | Value |
|---|---|
| `ENCRYPTION_KEY` | `openssl rand -hex 32`. **Store a copy in a password manager.** Losing it makes saved connections unreadable |
| `CRON_SECRET` | `openssl rand -hex 32`. Vercel Cron sends it automatically; GitHub needs it too (step 5) |
| `ALLOW_REGISTRATION` | `true` until your account exists, then `false` |
| `METRICS_TOKEN` | Optional. Enables `/metrics` for Prometheus |
| `PUBLIC_URL` | Only for a custom domain, e.g. `https://automate.example.com`. Defaults to the project's production domain |
| `SMTP_*`, `EMAIL_FROM` | Optional, for real email delivery |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional (Sheets, YouTube). Redirect URI: `<PUBLIC_URL>/api/oauth/google/callback` |
| `OIDC_*` | Optional single sign-on (see OPERATIONS.md) |

### 3. Deploy

Click **Deploy**. Migrations run automatically on the first request. They are safe when several instances start at once.

### 4. Create your account

Open the deployment URL, create the owner account, then set `ALLOW_REGISTRATION=false` and redeploy. Consider requiring 2FA under **Settings → Workspace**.

### 5. Turn on the 5-minute tick

In GitHub, open **Settings → Secrets and variables → Actions** for the repository and add:

- `APP_URL`: your production URL, e.g. `https://automation-studio.vercel.app`
- `CRON_SECRET`: the same value as in Vercel

Then open **Actions → Queue tick → Run workflow** once to check it. The run log should show `{"ok":true,...}`.

Every push to the default branch now deploys to production, and pull requests get preview deployments.

## Limits on Vercel

| Limit | Effect |
|---|---|
| 4.5 MB request body | Larger webhook payloads and CSV imports are rejected by Vercel. Use Docker for bigger uploads |
| 60 s per invocation (`maxDuration`) | A single step (e.g. a slow AI call) must finish within it; the queue lease then retries it |
| No local services | Ollama on `localhost` is unreachable. Use a hosted AI provider, or an Ollama server reachable over HTTPS |
| Preview deployments | Share the production database unless you enable Neon branching for previews in the Neon integration |
| `/metrics` | Reachable on the internet but requires `METRICS_TOKEN`. Leave the token unset to disable it |

## Operations

- **Logs:** in the Vercel dashboard (**Logs**), as JSON lines with secrets redacted.
- **Backups:** Neon keeps point-in-time history, so you can restore from the Neon console. For your own copies, run `pg_dump "$DATABASE_URL_UNPOOLED" -Fc -f backup.dump` from any machine.
- **Key rotation:** stop traffic (or accept a short window of errors), then run locally:

  ```bash
  DATABASE_URL=<neon url> ENCRYPTION_KEY=<old> NEW_ENCRYPTION_KEY=<new> npm run rotate-key
  ```

  Then update `ENCRYPTION_KEY` in Vercel and redeploy.
- **Health:** `/api/health` (liveness) and `/api/ready` (database and migrations).

## Test the deployment locally

```bash
npm run build:vercel
DATABASE_URL=postgres://… ENCRYPTION_KEY=<64 hex> CRON_SECRET=test \
  SECURE_COOKIES=false ALLOW_UNSAFE_PRODUCTION_CONFIG=true \
  node scripts/vercel-preview.mjs           # http://127.0.0.1:3100
E2E_BASE_URL=http://127.0.0.1:3100 npm run test:e2e
```

`vercel-preview.mjs` follows the generated `config.json` routes and runs the bundled function. The two `SECURE_COOKIES`/`ALLOW_UNSAFE…` settings are needed only because the local preview uses plain HTTP.

## Deploying from your machine instead of Git

```bash
npm run build:vercel
vercel deploy --prebuilt --prod
```
