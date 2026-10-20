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

## Getting Codex to use the memory tools

Codex (CLI and Desktop) does not show MCP tools to the model directly; the model has to search the tool list to find them. With only the connection configured, Codex connects to AnchorMind and fetches the tool list every session, but does not call any tool unless the user asks about memory directly ("what did we do last time?"). Set up one of the following.

1. Instructions: add this to `~/.codex/AGENTS.md` (all projects) or the project's `AGENTS.md`.

   ```markdown
   # AnchorMind memory

   The AnchorMind MCP server (`anchormind`) is connected. If its tools are not listed, find them by searching the tools for `anchormind`.

   - At the start of a task, call `context` to load past memory.
   - Before working on past work, settings or errors, use `recall` to find related memory.
   - When a decision, the cause and fix of an error, or a user preference is settled, save it with `remember`.
   - When the task is done, leave a summary with `reflect`. Put lessons worth reusing elsewhere in `lessons` as situation (cue), action (lesson) and evidence.
   ```

2. Hooks: inject memory at session start and leave a reflection at the end. Follow [Hook Setup](hooks.en.md#codex) or [Plugin Install](plugins.en.md).

When searching the tools, use a broad query (`anchormind context recall remember reflect`) and a limit of 20 or more. Not seeing a tool once does not mean it is missing.
