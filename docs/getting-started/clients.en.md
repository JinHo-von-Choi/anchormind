# Connecting Clients

AnchorMind is a standard MCP server (Streamable HTTP). Server URL: `http://localhost:57332/mcp`. Authentication uses the `Authorization: Bearer <access key>` header.

## Platforms

AnchorMind is a standard MCP (Model Context Protocol) server. It works with any AI platform that supports MCP, not only Claude Code, as long as the client supports the required transport.

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

Common setup: use Server URL `http://localhost:57332/mcp` and the Authorization header `Bearer YOUR_ACCESS_KEY`.

For Claude.ai Web and ChatGPT, AnchorMind uses OAuth. Enter your API key (`mmcp_xxx`) as the `client_id`; no Dynamic Client Registration (RFC 7591) flow is required. Redirect URIs from trusted domains, including claude.ai and chatgpt.com, are auto-approved.

A client registered through `POST /register` with the API key in an `Authorization: Bearer` header is a key-bound client and always goes through the consent screen during authorization. At token exchange, it must present the same key as `client_secret` or through Basic authentication; otherwise, `POST /token` returns 401 `invalid_client`. `/register` accepts up to `MEMENTO_DCR_MAX_PER_HOUR` registrations per hour per process (default 100; 0 means no cap) and returns 429 above that, with `Retry-After` set to the seconds remaining in the current window. Key-bound registrations are counted separately.

See [integration guides]() for platform-specific setup.

## Codex Desktop tool discovery

Some MCP clients, including Codex Desktop, use deferred/lazy tool discovery. Depending on the query and limit, tool_search may show only part of the tool list, so recall can be missing from storage-biased queries with a low limit even though it always exists in tools/list. If recall is not visible, retry with a broader query and limit 20 or above. Recommended: put this retry rule in the agent system prompt/instructions upfront to avoid the initial discovery loop.

- query: `memento context recall remember reflect batch_remember search_traces reconstruct_history`
- limit: 20 or above
