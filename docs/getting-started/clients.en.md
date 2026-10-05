# Connecting Clients

AnchorMind is a standard MCP server (Streamable HTTP). Server URL: `http://localhost:57332/mcp`. Authentication: `Authorization: Bearer <access key>` header.

## Platforms

AnchorMind is a standard MCP (Model Context Protocol) server. It works with any AI platform that supports MCP — not just Claude Code.

| Platform | Config Location | Transport |
|----------|----------------|-----------|
| Claude Code | `claude mcp add` CLI (`~/.claude.json`) or `.mcp.json` | Streamable HTTP |
| Claude Desktop | claude_desktop_config.json | Streamable HTTP |
| Claude.ai Web | Settings > Integrations | OAuth (RFC 7591) |
| Cursor | .cursor/mcp.json | Streamable HTTP |
| Windsurf | ~/.codeium/windsurf/mcp_config.json | Streamable HTTP |
| GitHub Copilot | VS Code MCP Marketplace | Streamable HTTP |
| Codex CLI | ~/.codex/config.toml | Streamable HTTP |
| ChatGPT Desktop | Developer Mode > Apps | OAuth (RFC 7591) |
| Continue | config.json | Streamable HTTP |

Common setup: Server URL `http://localhost:57332/mcp`, Authorization header `Bearer YOUR_ACCESS_KEY`.

For Claude.ai Web and ChatGPT, AnchorMind uses OAuth. Enter your API key (`mmcp_xxx`) as the `client_id` -- no Dynamic Client Registration (RFC 7591) flow required. Redirect URIs from trusted domains (claude.ai, chatgpt.com) are auto-approved.

A client registered through `POST /register` with the API key in an `Authorization: Bearer` header (a key-bound client) always passes through the consent screen on authorization, and must present the same key as `client_secret` (or through Basic authentication) at token exchange. Without it, `POST /token` returns 401 `invalid_client`. `/register` accepts up to `MEMENTO_DCR_MAX_PER_HOUR` registrations per hour per process (default 100, 0 means no cap) and answers 429 (`Retry-After` is the seconds remaining in the current window) above that. Key-bound registrations are counted separately.

See [integration guides]() for platform-specific setup.

## Codex Desktop tool discovery

Some MCP clients such as Codex Desktop use deferred/lazy tool discovery. tool_search may expose only a subset of tools depending on the query and limit, so recall — which always exists in tools/list — can be missing from storage-biased queries with a low limit. If recall is not visible, retry with a broader query and limit 20 or above. Recommendation: seed this retry rule into the agent system prompt/instructions upfront to prevent the initial discovery loop.

- query: `memento context recall remember reflect batch_remember search_traces reconstruct_history`
- limit: 20 or above
