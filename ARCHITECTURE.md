# Architecture

## Repository audit (Phase 1)

The target folder contained only a clone of `rea`, a reverse-engineering CLI and MCP server. It is not an application to extend, so there was no existing frontend, backend, database, auth or workflow code to preserve. Automation Studio was built as a new monorepo in `automation-studio/`, next to `rea/`, which was left untouched.

On using rea for this build: rea was used only as a reference for the official MCP SDK v2 API. Zapier's proprietary bundles were deliberately **not** reverse-engineered. The product brief forbids copying private implementation, and doing so would raise terms-of-service and copyright issues. All code, schemas and UI here are original. Feature categories follow publicly known automation-platform behaviour.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | Shared types between editor, API and engine |
| Shared core | `packages/core` | Workflow schema (zod), safe expression language, graph planning, validation, redaction |
| API | Fastify 5 | Fast, small, good hook model for auth, CSRF and rate limits |
| Database | PostgreSQL; PGlite (embedded) by default | Zero-setup local runs; the same SQL works on a real server |
| Queue | Postgres table with `FOR UPDATE SKIP LOCKED` | Durable with no Redis to run; at-least-once delivery |
| Scheduling | croner | Cron with time zones, no native deps |
| Editor | React 19 + React Flow (`@xyflow/react`) + Vite | Mature node-graph UI |
| MCP | Official `@modelcontextprotocol/server` and `/client` v2 | Spec-compliant Streamable HTTP and stdio |
| AI | Official `@anthropic-ai/sdk`; OpenAI-compatible HTTP for Ollama and others; mock adapter | Local-first with optional hosted models |

Every dependency is MIT, ISC, Apache-2.0 or similarly permissive. Ollama is optional and installed separately.

## Components

```
apps/web  (React SPA) ──HTTP──► apps/server: API / control plane (Fastify)
                                   │  auth (session+CSRF | bearer token), RBAC, tenancy
                                   │  workflows, versions, credentials, tables, forms
                                   │  webhooks (/hooks/*), MCP endpoint (/mcp), OAuth
                                   ▼
                              PostgreSQL / PGlite  ◄── jobs table (durable queue)
                                   ▲
                    execution plane: Worker(s)
                      runner (DAG engine) · scheduler (cron) · pollers · maintenance
                      integrations registry → HTTP (SSRF-guarded), SMTP, AI, MCP client, SaaS APIs
```

- The **control plane never waits for a workflow to finish.** Starting an execution writes the execution, its step rows and a job in one transaction, then returns. The one exception is a webhook explicitly configured to wait for a "Respond to webhook" step, which waits at most 30 seconds.
- **Workers** run embedded in the API process (the default, required for PGlite) or as separate processes (`npm run worker`, PostgreSQL only).

## Workflow data model (`packages/core/src/schema.ts`)

`WorkflowDefinition { schemaVersion: 1, nodes[], edges[], settings }`

- `node`: `id` (stable, used in expressions), `type`, `name`, `config`, `credentialId`, `retry {maxAttempts, backoffMs, backoffMultiplier}`, `timeoutMs`, `onError: fail|continue`, `disabled`, `notes`, `position`.
- `edge`: `id`, `source`, `target`, `branch` (a named output such as `true`, `false`, `approved`, or switch cases).
- `settings`: `timeoutMs`, `maxStepExecutions`, `dedupeWindowSeconds`.
- **Execution order comes only from edges.** `position` is editor metadata and has no effect on execution.
- Drafts are mutable (`workflows.draft_definition`). Publishing snapshots an immutable `workflow_versions` row. Every execution stores the exact definition it runs.

## Validation (`packages/core/src/validate.ts`)

Validation rejects: schema violations, unknown node types, missing or invalid required fields, invalid select values, duplicate IDs, dangling edges, self-loops, edges into triggers, missing or unknown branches, cycles (iteration uses the bounded Loop node instead), references to steps that do not run earlier, unparseable expressions, nodes the user's role may not use, and credentials that are missing, belong to another tenant, or have the wrong type. Activation also requires required credentials, and the server additionally validates cron expressions and webhook verification setup.

## Expression language (`packages/core/src/expression.ts`)

`{{ … }}` templates are parsed into an AST and interpreted. **There is no `eval` or `Function`.**

- Roots: `trigger`, `steps.<id>.output`, `item` and `index` (inside loops and maps), `execution`, `workflow`, `vars`.
- Operators: `== != === !== < > <= >= && || ?? ! + - * / %`, ternary `?:`, optional chaining `?.`, and array literals.
- About 60 pure, whitelisted functions (`lower`, `default`, `join`, `formatDate`, `addDays`, `pluck`, `sum`, `emailDomain`, …). Method calls are not allowed.
- Property access reads own data properties only; getters are never invoked. `__proto__`, `constructor` and `prototype` are blocked.
- Limits: source length, AST depth and a step budget.
- A template that is exactly one expression returns a typed value; anything else is interpolated as text.

## Execution engine (`apps/server/src/engine`)

- `startExecution`: optional dedupe (`trigger_events`), then the execution row, one step row per node (the trigger pre-completed), and an `execution.run` job.
- `runExecution`: takes an **execution lease**, so one runner advances an execution at a time. It loops: cancellation check → workflow timeout check → pick the first node in topological order whose parents are all resolved.
  - A node runs if at least one incoming edge is *active*: the source succeeded (or failed with `onError: continue`), the source was not halted by a Filter, and the edge's branch matches.
  - Nodes with no active incoming edge are marked `skipped`.
  - Each attempt is recorded in `step_attempts`. Step timeouts use an AbortController.
  - Only `transient`, `rate_limit` and `timeout` errors are retried, with exponential backoff or `Retry-After`. `permanent`, `config`, `auth` and `policy` errors fail immediately.
  - Nodes can return `wait` (delay or approval). The step is persisted as `waiting` and the job is rescheduled for the wake time; approvals re-enqueue on decision.
- **Recovery:** jobs and execution leases expire. A crashed worker's step is re-run as a new attempt, which is at-least-once delivery. Steps that succeeded are never re-run. "Retry failed steps" resets only failed and skipped steps.
- **Sub-workflows and loops** run inline as child executions (maximum depth 3, maximum 1000 iterations). Children cannot wait.
- **Duplicate protection:** per-workflow dedupe keys from webhook config, polling item IDs, schedule timestamps, WhatsApp message IDs and table row IDs.
- **Events:** table row created/updated/deleted, form submitted, execution failed and WhatsApp messages are dispatched to active workflows whose published trigger matches. A workflow never triggers itself, and failure-alert workflows never trigger on their own failures.

## Integration contract (`apps/server/src/integrations/types.ts`)

An `IntegrationModule` = `IntegrationDefinition` (id, name, version, category, prerequisites, scopes, rate limits, availability) + `NodeImplementation[]` + `CredentialTypeImplementation[]`.

A node declares `fields: FieldSpec[]`, which both the editor form and validation use. It also declares `branches` or `dynamicBranches`, `sampleOutput`, `credentialType`, `sideEffects`, `minRole`, and implements `execute`, plus optionally `resume`, `mock`, `poll` and `matchEvent`. Credential types define `fields`, optional `oauth2`, and optional `test`, `refresh` and `describe`. Shared helpers: `apiCall` (SSRF-guarded JSON client with normalized errors and `Retry-After`) and `safeRequest`.

## Tenancy and authorization

A workspace is the tenant boundary. Every tenant table carries `workspace_id`, and every query filters on it. Roles are viewer < editor < admin < owner. Sessions are HttpOnly cookies with a CSRF token; API tokens are hashed bearer tokens with scopes (`read`, `write`, `execute`, `admin`) and act with the creator's *current* role. Credential ciphertext is bound to `workspace:id` through AES-GCM additional authenticated data (AAD).

## Database

Schema and migrations are in `apps/server/src/db/migrations`. Migrations are checksummed: editing an applied migration aborts startup. The tables are users, workspaces, workspace_members, projects, sessions, api_tokens, workflows, workflow_versions, credentials, executions, execution_steps, step_attempts, trigger_events, trigger_state, workflow_schedules, jobs, approvals, data_tables, data_rows, forms, mcp_servers, mcp_tool_calls, ai_usage, oauth_states, email_outbox and audit_logs.
