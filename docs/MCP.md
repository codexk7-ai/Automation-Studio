# MCP

## This platform as an MCP server

- Endpoint: `<PUBLIC_URL>/mcp` (Streamable HTTP, official MCP TypeScript SDK v2; serves both the current and 2025-era protocol).
- Authentication: an API token from **Team & API**. The token's scopes and its owner's current role decide which tools succeed. Every call is recorded in the MCP audit trail.

| Tool | Scope | Min role |
|---|---|---|
| list_workflows, get_workflow, search_integrations, get_action_schema, validate_workflow, get_execution_status, get_execution_history, list_available_tools | read | viewer |
| create_workflow_draft, update_workflow_draft | write | editor |
| test_workflow (simulates external actions unless `simulateExternal: false`), retry_execution | execute | editor |

AI clients can draft and test workflows, but they **cannot publish or activate** them. Publishing remains a human action in the UI or REST API.

### Claude Code

```bash
claude mcp add --transport http automation-studio http://localhost:8787/mcp --header "Authorization: Bearer as_your_token"
```

### Generic JSON configuration

```json
{ "mcpServers": { "automation-studio": { "type": "http", "url": "http://localhost:8787/mcp", "headers": { "Authorization": "Bearer as_your_token" } } } }
```

### stdio

```bash
AUTOMATION_STUDIO_TOKEN=as_your_token npm run mcp:stdio
```

stdio opens the database directly. With the embedded database (PGlite), stop the API server first, or use HTTP instead. With PostgreSQL both can run at the same time.

## External MCP servers (client)

1. **MCP servers → Register server:** a Streamable HTTP URL, plus an optional *HTTP authentication* connection for bearer or API-key auth. Private addresses must be allowlisted.
2. The platform connects and discovers tools. **All tools start disabled.**
3. An admin enables individual tools, and separately marks them "AI agents may call".
4. Use them through the **Call MCP tool** step (enabled tools) or the **AI agent** step (AI-allowed tools only, at most 10 calls per run).
5. Arguments are validated against each tool's JSON schema before every call. Results are size-capped and treated as untrusted data.
