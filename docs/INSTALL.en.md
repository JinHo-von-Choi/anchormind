# Installation Guide

> [!TIP]
> Not confident installing this yourself? Jump to [Delegate to an AI Assistant](#delegate-to-an-ai-assistant). A single prompt covers prerequisites, dependencies, `.env`, MCP registration, and the health check.

## Delegate to an AI Assistant

The fastest path for someone new to this repository is to hand the work to an AI assistant. Claude Code, Cursor, and Codex all work.

### Recommended Prompts

**Clean install (first-time setup)**

> "Clone the anchormind repository (`https://github.com/JinHo-von-Choi/anchormind`) into my environment, read `docs/INSTALL.en.md` and `SKILL.md`, and do the following:
>
> 1. Verify system prerequisites (Node.js, PostgreSQL, Redis)
> 2. Run `npm install` and `bash setup.sh` to install dependencies and generate `.env`
> 3. If PostgreSQL or Redis is missing, install them or propose a Docker Compose setup
> 4. Run `npm run migrate`
> 5. Confirm `node bin/memento.js health` passes
> 6. Register memento-mcp in my current AI client's MCP settings (Claude Code / Cursor / Codex)
> 7. Call `mcp__anchormind__context` to verify wiring (`mcp__anchormind__memory_stats` also works with a master key)
>
> Report each step as a table. On failure, consult `docs/getting-started/troubleshooting.md` and try to recover."

**Integrate into an existing Claude Code setup**

> "Add memento-mcp to my `~/.claude.json`. Follow `docs/getting-started/claude-code.md`:
>
> 1. Back up `~/.claude.json`
> 2. Add memento-mcp under `mcpServers` with URL and ACCESS_KEY
> 3. Tell me how to restart Claude Code
> 4. Verify `mcp__anchormind__remember` etc. appear in the tool list"

### Checklist the AI Should Satisfy

After the assistant finishes, all of the following must hold:

- `.env` exists, with `MEMENTO_ACCESS_KEY`, `POSTGRES_*`, and `REDIS_*` populated
- `npm run migrate` succeeds through `migration-060`
- `node bin/memento.js health` returns OK for DB, Redis, and the embedding provider
- The AI client lists `mcp__*__remember`, `recall`, and `reflect`
- A `context` call returns a valid response (zero fragments is fine; so does `memory_stats` with a master key)

### When the AI Gets Stuck

- Dependency errors: [Troubleshooting](getting-started/troubleshooting.md)
- Windows: [Windows WSL2 Setup](getting-started/windows-wsl2.md)
- Claude Code details: [Claude Code Configuration](getting-started/claude-code.md)
- Smoke test: [First Memory Flow](getting-started/first-memory-flow.md)
- Operating manual: [SKILL.md](../SKILL.md)

## Choose Your Starting Path

- Fastest bootstrap: [Quick Start](getting-started/quickstart.md)
- Best Windows path: [Windows WSL2 Setup](getting-started/windows-wsl2.md)
- Bash-free Windows path: [Windows PowerShell Setup](getting-started/windows-powershell.md)
- Claude Code integration: [Claude Code Configuration](getting-started/claude-code.md)
- Post-install verification: [First Memory Flow](getting-started/first-memory-flow.md)
- Common failures: [Troubleshooting](getting-started/troubleshooting.md)

## Support Policy

- Linux / macOS: standard path
- Windows: WSL2 Ubuntu recommended
- Windows PowerShell: limited support
- `setup.sh`: assumes a Bash environment

## Quick Start (Interactive Setup Script)

```bash
bash setup.sh
```

Guides you through `.env` creation, `npm install`, and DB schema setup step by step.

## Manual Installation

[Quick Start](getting-started/quickstart.md) walks through dependencies, the environment file, the PostgreSQL schema and starting the server. The `vector` extension needs superuser rights and `npm run migrate` does not create it, so run `CREATE EXTENSION IF NOT EXISTS vector` first.

## Upgrade (Existing Installation)

The order is `git pull`, `npm install`, `npm run migrate`, restart the service. Version-specific notes and rollback are in [Upgrade Notes](operations/upgrade-notes.en.md).

## Environment Variables and Optional Setup

- Start from `.env.example.minimal`; `.env.example` is the production-style example. All variables are in [Configuration](configuration.en.md).
- To embed with a local model instead of an OpenAI key, follow the [local embedding guide](embedding-local.md).
- LLM providers used for quality evaluation and automatic reflect, and their CLI installation, are in [LLM Providers](operations/llm-providers.md).

## Post-Startup Verification Checklist

After the server starts, verify the following in order:

```bash
# 1. Health endpoint returns 200
curl -s http://localhost:57332/health | jq .status
curl -s http://localhost:57332/health/live    # always 200 (process is alive)
curl -s http://localhost:57332/health/ready   # 200 when the primary DB answers, otherwise 503 (db_timeout, db_error)

# 2. Check server log for embedding consistency (evaluated at startup)
# Success: no log line — startup simply continues
# Failure: "[embedding-consistency] 차원 불일치 발견:" followed by an aborted startup

# 3. CLI diagnostics
node bin/memento.js health
```

The embedding consistency check is silent on success and startup proceeds. When it prints `[embedding-consistency] 차원 불일치 발견:` with a per-table `DB=Nd, config=Nd` breakdown and halts startup, `EMBEDDING_DIMENSIONS` disagrees with the dimensions actually stored in the database. Either revert to the previous provider, or run `EMBEDDING_DIMENSIONS=N DATABASE_URL=$DATABASE_URL node scripts/post-migrate-flexible-embedding-dims.js` followed by `node scripts/backfill-embeddings.js`, then restart the server.

## Starting the Server and Connecting

```bash
node server.js
```

For client setup see [Connecting Clients](getting-started/clients.en.md) and [Claude Code](getting-started/claude-code.md); for terminal commands see [CLI](cli.en.md).

## Making the Agent Use Memory Automatically

The `instructions` field in the `initialize` response encourages memory tool use, but this alone does not inject memories at session start. Set up one of the following.

- Hooks: [Hooks](getting-started/hooks.en.md)
- Plugin (hooks and skill bundled): [Plugin install](getting-started/plugins.en.md)
- Instruction file: add this to `CLAUDE.md`.

```markdown
## Session Start Rules
- At the start of every conversation, call the `context` tool to load Core Memory and Working Memory.
- Before debugging or writing code, call `recall(keywords=[relevant_keywords], type="error")` to surface related past learnings.
```
