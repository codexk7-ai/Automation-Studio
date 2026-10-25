# Integrations: setup, prerequisites and costs

Nothing here is free by default unless marked **local**. Providers have their own terms, quotas and pricing, and you are responsible for complying with them. Every external step can be **simulated** in test runs ("Simulate external actions"), so you can build and test workflows without accounts.

## Local (no account needed)

Built-in triggers and logic, data tables, CSV, forms, HTTP requests to public URLs, the email outbox (messages are **not** delivered), the mock AI adapter, and the MCP server.

## Email (SMTP)

Add an **SMTP server** connection: host, port, username, password (often an app password), and a From address. Any SMTP provider works: Google Workspace or Gmail (app password), Microsoft 365, Amazon SES, SendGrid, Mailgun, Postmark, and others. Server-wide SMTP can also be set with `SMTP_*` in `.env`.

- Deliverability requires domain verification (SPF/DKIM/DMARC) at your provider.
- Marketing email needs recipient consent and an opt-out. The templates include an opt-out line.
- Local testing: run Mailpit (`localhost:1025`) and add `localhost:1025` to `OUTBOUND_ALLOWLIST`.
- Not included: inbound email (IMAP). Use your provider's inbound-parse webhook with the Webhook trigger (see the "Inbound email triage" template).

## AI models

Add an **AI model provider** connection.

- **Ollama (free, local):** install from ollama.com, run `ollama pull llama3.2`. Then use provider *OpenAI-compatible* with base URL `http://localhost:11434/v1` and model `llama3.2`. `localhost:11434` is allowlisted by default.
- **LM Studio, vLLM, llama.cpp server:** also OpenAI-compatible. Allowlist their host:port.
- **Anthropic:** provider *Anthropic*, an API key, and optionally a model (default `claude-opus-5-5`; `claude-sonnet-5-5` and `claude-haiku-5-5` are cheaper). Usage is billed per token. The adapter uses the official SDK, structured JSON output, and the server-side refusal fallback (`fallbacks: "default"`).
- **Hosted OpenAI-compatible APIs** (OpenAI, OpenRouter, Groq, …): base URL plus API key. Enter prices per 1M tokens if you want cost estimates.
- Set a **monthly token budget** in Settings → Workspace.

## Google: Sheets and YouTube

1. In Google Cloud Console, create a project and enable the **Google Sheets API** and/or the **YouTube Data API v3**.
2. Choose an auth method:
   - **OAuth** (needed for Sheets, YouTube updates and captions): create an OAuth client (type *Web application*) with redirect URI `<PUBLIC_URL>/api/oauth/google/callback`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env` and restart. Then go to Connections → Google account → *Sign in with Google*. Requested scopes: `spreadsheets` and `youtube.force-ssl`.
   - **API key:** public YouTube data only (video details, channel uploads, new-video trigger).
3. Limits:
   - Unverified OAuth apps only work for listed test users, and sensitive scopes may require Google's verification review.
   - YouTube quota is 10,000 units per day by default: list calls cost about 1 unit, metadata updates about 50. Raising it requires an audit.
   - Caption downloads only work for videos the connected account can edit.
   - **Video upload/publishing is not implemented.** Uploads from unverified API projects are forced to private.

## WhatsApp Business Platform (Cloud API)

1. Prerequisites: a Meta Business account, a Meta app with the WhatsApp product, and a verified business phone number. Create a permanent System User token with `whatsapp_business_messaging`.
2. Add a **WhatsApp Cloud API** connection with the access token, phone number ID, app secret, a verify token of your choice, and a Graph API version (use the version shown in your Meta app).
3. In the Meta app's webhook settings, set the callback URL to `<PUBLIC_URL>/hooks/whatsapp/<connection id>` (Connections → *Copy webhook URL*) and use the same verify token. Subscribe to `messages`. `PUBLIC_URL` must be publicly reachable over HTTPS: use your own domain or a tunnel such as `cloudflared` or `ngrok` for testing.
4. Rules enforced by Meta:
   - Business-initiated messages need **approved templates**.
   - Free-form replies only work within 24 hours of the customer's last message.
   - Recipients must have opted in. The send steps require a "Recipient has opted in" value.
   - Pricing is per conversation or message, depending on Meta's current model.

## HubSpot

Create a private app with the `crm.objects.contacts.read` and `crm.objects.contacts.write` scopes and add a **HubSpot private app** connection. Rate limits depend on your HubSpot plan.

## Slack

Create a Slack app with an **incoming webhook**, then add a **Slack incoming webhook** connection with its URL.

## External PostgreSQL

Add a **PostgreSQL connection** using a least-privilege database user. Private hosts must be added to `OUTBOUND_ALLOWLIST`. The query step is admin-only, takes one statement with `$1…` parameters, and runs read-only by default.

## HTTP / any REST API

Use the **HTTP request** step, with an **HTTP authentication** connection for bearer, basic, API-key header or query-parameter auth. Private and internal addresses are blocked unless allowlisted.

## Adding a connector

Create a module under `apps/server/src/integrations/` that exports an `IntegrationModule` (see ARCHITECTURE.md → Integration contract), register it in `integrations/index.ts`, implement `mock()` for test runs, and add tests that use a local mock server (`test/helpers.ts → mockServer`).
