# CLI

## Overview

`bin/memento.js` is the CLI entry point for operating and querying the memory server directly from the terminal, without a running server instance (for most commands). When installed globally, run it as `anchormind`; the `memento-mcp` command works identically.

```bash
node bin/memento.js <command> [options]
# or
npm run cli -- <command> [options]
```

All commands read environment variables from the `.env` file (`DATABASE_URL`, etc.). Load them before running:

```bash
export $(grep -v '^#' .env | grep '=' | xargs)
node bin/memento.js stats
```

---

## Global Flags

Flags available for all subcommands.

| Flag | Description |
|------|-------------|
| `--help`, `-h` | Print detailed help for the current subcommand |
| `--format table\|json\|csv` | Output format. Defaults to `table` in TTY, `json` when piped or redirected |
| `--json` | Alias for `--format json` (backward compatible) |
| `--remote URL` | Remote MCP server URL. Falls back to `MEMENTO_CLI_REMOTE` env var when not set |
| `--key KEY` | Bearer API key for remote server authentication. Falls back to `MEMENTO_CLI_KEY` env var |
| `--timeout ms` | Remote HTTP request timeout (default: 30000ms) |
| `--verbose` | Print stack traces on error |

### Remote Access Environment Variables

| Variable | Description |
|----------|-------------|
| `MEMENTO_CLI_REMOTE` | MCP server URL to use when `--remote` is not specified |
| `MEMENTO_CLI_KEY` | API key to use when `--key` is not specified |

---

## Command Classification

### Local-only (remote access not supported)

`serve`, `migrate`, `cleanup`, `backfill`, `health`, `update` access the DB or process directly and return an error when used with `--remote`.

### Remote-capable

`recall`, `remember`, `stats`, `inspect` can be executed through a remote MCP server via `--remote URL --key KEY`.

---

## Command Reference

| Command | Description | Remote |
|---------|-------------|--------|
| `serve` | Start the MCP server | No |
| `migrate` | Run DB migrations | No |
| `cleanup [--execute]` | Clean up noisy fragments (dry-run by default) | No |
| `backfill` | Backfill missing embeddings | No |
| `stats` | Fragment / anchor / topic statistics | Yes |
| `health` | DB / Redis / embedding connectivity diagnostics | No |
| `recall <query>` | Terminal recall | Yes |
| `remember <content>` | Terminal remember | Yes |
| `inspect <id>` | Fragment detail + 1-hop links | Yes |
| `session <sub>` | Session list / show / delete / rotate (master key required) | Yes |
| `update [--execute] [--redetect]` | Check and apply updates (dry-run by default) | No |
| `export [--topic x] [--type t]` | Dump fragments as JSONL | No |
| `import [--input FILE]` | Ingest JSONL (file or stdin) | No |
| `completion <shell>` | Print bash/zsh completion script | Yes |

---

## Command Details

### serve

Start the MCP server in the foreground.

```bash
node bin/memento.js serve
# or
npm start
```

Set the `PORT` environment variable to override the default port (57332).

Help:

```bash
node bin/memento.js serve --help
```

### migrate

Run all pending `lib/memory/migrations/migration-*.sql` files in order. Already-applied migrations are skipped.

```bash
node bin/memento.js migrate
# or
npm run migrate
```

Applied migrations are tracked in `agent_memory.schema_migrations`.

Help:

```bash
node bin/memento.js migrate --help
```

### cleanup

Delete noisy fragments that satisfy `util_score`, `importance`, and inactivity conditions.

```bash
node bin/memento.js cleanup            # dry-run (preview only)
node bin/memento.js cleanup --execute  # execute deletions
```

Alternative direct invocation:

```bash
node scripts/cleanup-noise.js --dry-run
node scripts/cleanup-noise.js --execute
```

### backfill

Generate embeddings for existing fragments that have none. Requires an embedding API key or a local transformers provider.

```bash
node bin/memento.js backfill
# or
npm run backfill:embeddings
```

### stats

Print fragment count, anchor count, and topic distribution.

```bash
# TTY environment -- table format (default)
node bin/memento.js stats

# JSON format
node bin/memento.js stats --format json

# CSV format
node bin/memento.js stats --format csv

# --json alias (same as --format json)
node bin/memento.js stats --json

# Remote server query
node bin/memento.js stats --remote https://memento.anchormind.net/mcp --key mmcp_xxx
```

Example output (`--format table`):

```
fragments   anchors   topics
----------  --------  ------
1204        38        12
```

Example output (`--format json`):

```json
{"fragments": 1204, "anchors": 38, "topics": 12}
```

Help:

```bash
node bin/memento.js stats --help
```

### health

Diagnose DB connectivity, Redis status, and embedding provider availability.

```bash
node bin/memento.js health
node bin/memento.js health --format json
```

### recall

Search fragments from the terminal. Works directly against the local DB without a running server. Use `--remote` to route through a remote MCP server.

```bash
# Basic search
node bin/memento.js recall "search query"

# With options
node bin/memento.js recall "nginx error" --topic my-project --limit 5

# Time range filter
node bin/memento.js recall "recent entries" --time-range 2026-01-01,2026-12-31

# Output format
node bin/memento.js recall "query" --format table
node bin/memento.js recall "query" --format json
node bin/memento.js recall "query" --format csv

# Remote server
node bin/memento.js recall "query" --remote https://memento.anchormind.net/mcp --key mmcp_xxx

# Via environment variables
MEMENTO_CLI_REMOTE=https://memento.anchormind.net/mcp MEMENTO_CLI_KEY=mmcp_xxx \
  node bin/memento.js recall "query"
```

Options:

| Flag | Description |
|------|-------------|
| `--topic <t>` | Topic filter |
| `--type <t>` | Fragment type filter (fact, error, procedure, decision, preference, episode) |
| `--limit <n>` | Maximum results to return (default: 10) |
| `--time-range from,to` | Date range filter (ISO 8601) |

Help:

```bash
node bin/memento.js recall --help
```

### remember

Store a fragment from the terminal. Use `--remote` to store on a remote server.

```bash
# Basic store
node bin/memento.js remember "pg_hba.conf must be configured for remote connections" --topic infra --type fact

# Procedure store
node bin/memento.js remember "deployment complete" --topic deploy-2026 --type procedure

# With idempotency key (prevents duplicate storage)
node bin/memento.js remember "nginx restart, port 443 healthy" --topic infra --type fact \
  --idempotency-key "infra-nginx-restart-2026-04-20"

# Remote server
node bin/memento.js remember "deployment complete" --topic deploy-2026 --type procedure \
  --remote https://memento.anchormind.net/mcp --key mmcp_xxx
```

Options:

| Flag | Description |
|------|-------------|
| `--topic <t>` | Topic tag (recommended) |
| `--type <t>` | Fragment type (fact, error, procedure, decision, preference, episode) |
| `--importance <n>` | Importance score 0.0--1.0 |
| `--idempotency-key <k>` | Skip storage if a fragment with this key already exists |

Help:

```bash
node bin/memento.js remember --help
```

### inspect

Print full metadata and 1-hop links for a fragment by ID.

```bash
node bin/memento.js inspect frag-00abc123
node bin/memento.js inspect frag-00abc123 --format json
node bin/memento.js inspect frag-00abc123 --format table

# Remote server
node bin/memento.js inspect frag-00abc123 --remote https://memento.anchormind.net/mcp --key mmcp_xxx
```

Help:

```bash
node bin/memento.js inspect --help
```

### session

Inspects active sessions, force-closes them, or rotates their IDs. All subcommands require the master key (`MEMENTO_ACCESS_KEY`). In remote mode (`--remote` / `--key`) the CLI calls the Admin HTTP API directly.

Four subcommands.

```bash
# Active session list (default limit 50)
memento-mcp session list [--limit N] [--workspace X] [--format table|json|csv]

# Single session detail (keyId, createdAt, lastAccessedAt, expiresAt, heartbeat)
memento-mcp session show <sessionId>

# Force-close a session (autoReflect included)
memento-mcp session delete <sessionId>

# Rotate session ID (session fixation defense)
memento-mcp session rotate <sessionId> [--reason "suspected_leak"]
```

`session rotate` rebinds only the ID while preserving the Redis-stored session state. In-progress work and memory fragments are unaffected. `reason` is up to 128 chars of audit-log text (default `explicit_rotate`).

Rotate endpoint policy:

- HTTP: `POST /session/rotate` (body: `{ "reason": "..." }`)
- Auth: `Authorization: Bearer <API key or master key>` plus `Mcp-Session-Id` header for target session
- CSRF guard: `Origin` header mandatory; missing Origin returns 403
- Rate limit: `MEMENTO_ROTATE_RATE_LIMIT_PER_MIN` per IP per minute (default 5); exceeding returns 429
- Metric: `mcp_session_rotation_total` (label: `reason`)

The CLI surfaces `HTTP 429` on stderr when the rate limit is exceeded. The same limit applies to remote mode.

Example output (list, table format):

```
SESSION ID                       KEY ID    WORKSPACE  CREATED              LAST ACCESSED        TTL (min)
----------------------------------------------------------------------------------------------------------
aabbcc11-2233-4455-6677-8899ddee  default   paysvc     2026-04-21T10:12:03  2026-04-21T12:34:56  41520
bbccdd22-3344-5566-7788-99aaeeff  mmcp_xx   -          2026-04-21T11:00:00  2026-04-21T12:30:00  41500
```

Use `--help` to inspect subcommand-level options.

```bash
memento-mcp session --help
memento-mcp session list --help
memento-mcp session rotate --help
```

### update

Check for and optionally apply server updates.

```bash
node bin/memento.js update              # dry-run: check available updates
node bin/memento.js update --execute    # apply the update
node bin/memento.js update --redetect   # re-detect install type, then update
```

Help:

```bash
node bin/memento.js update --help
```

### export

Dump fragments as JSONL (one fragment per line) for backup or migration.

```bash
node bin/memento.js export --topic memento-mcp --type fact > out.jsonl
node bin/memento.js export --since 2026-04-01 --output backup.jsonl
node bin/memento.js export --key mmcp_xxx --limit 500
```

Main options: `--topic`, `--type`, `--since <ISO>`, `--limit <n>`, `--output <FILE>`, `--json` (emit array).

Help:

```bash
node bin/memento.js export --help
```

### import

Read fragments from a JSONL file or stdin and insert them into the `fragments` table.

```bash
node bin/memento.js import --input out.jsonl
cat out.jsonl | node bin/memento.js import
node bin/memento.js import --input out.jsonl --idempotent --dry-run
```

`--idempotent` skips inserts that collide with an existing `idempotency_key` or `id`. `--dry-run` validates only.

Help:

```bash
node bin/memento.js import --help
```

### completion

Print a bash/zsh completion script to stdout.

```bash
node bin/memento.js completion bash >> ~/.bashrc
node bin/memento.js completion zsh  >> ~/.zshrc
source <(node bin/memento.js completion bash)
```

Supported shells: `bash`, `zsh` (bash-compat mode).

Help:

```bash
node bin/memento.js completion --help
```

---

## Remote Access Examples

Specify `--remote` and `--key` directly, or set environment variables.

```bash
# Direct flags
node bin/memento.js recall "deployment history" \
  --remote https://memento.anchormind.net/mcp \
  --key mmcp_xxx

# Via environment variables
export MEMENTO_CLI_REMOTE=https://memento.anchormind.net/mcp
export MEMENTO_CLI_KEY=mmcp_xxx
node bin/memento.js recall "deployment history"
node bin/memento.js stats
node bin/memento.js remember "deployment complete" --topic deploy --type procedure
```

Using `--remote` with `serve`, `migrate`, `cleanup`, `backfill`, `health`, or `update` returns an error.

---

## Output Format Details

| Format | Characteristics | Recommended for |
|--------|----------------|-----------------|
| `table` | Human-readable aligned table | Direct TTY inspection |
| `json` | Machine-readable JSON | Pipe processing, scripts |
| `csv` | Comma-separated values | Spreadsheets, awk processing |

TTY detection: in pipe or redirect environments (`| jq`, `> out.txt`), `json` is selected automatically even without `--format`.

`recall --format csv` example output:

```
id,type,topic,importance,content
frag-00abc123,fact,infra,0.80,"pg_hba.conf must be configured for remote connections"
frag-00def456,procedure,deploy-2026,0.70,"deployment complete"
```

---

## npm Script Reference

| Script | What it runs |
|--------|-------------|
| `npm start` | `node server.js` (start server) |
| `npm run cli -- <args>` | `node bin/memento.js <args>` |
| `npm run migrate` | `node scripts/migrate.js` |
| `npm run backfill:embeddings` | `node scripts/backfill-embeddings.js` |
| `npm test` | node:test unit tests |
| `npm run test:integration` | Integration and E2E tests (all) |
| `npm run test:integration:llm` | LLM provider integration tests (sequential) |

---

## Standalone Script Invocation

### Embedding Consistency Check

```bash
DATABASE_URL=$DATABASE_URL EMBEDDING_DIMENSIONS=1536 \
  node scripts/check-embedding-consistency.js
```

Verifies that the actual vector dimensions stored in `fragments` and `morpheme_dict` match the `EMBEDDING_DIMENSIONS` setting. Prints `PASS` on success or `FAIL` with remediation guidance on mismatch.

### Vector Dimension Migration (re-run migration-007)

Run after switching embedding providers or changing `EMBEDDING_DIMENSIONS`.

```bash
EMBEDDING_DIMENSIONS=384 DATABASE_URL=$DATABASE_URL \
  node scripts/post-migrate-flexible-embedding-dims.js
```

Updates the vector column dimensions in both `fragments` and `morpheme_dict` simultaneously.

### Embedding Backfill

Re-generate embeddings for fragments with missing or stale vectors.

```bash
node scripts/backfill-embeddings.js
```

### L2 Normalization

Normalize embedding vectors to unit length. Run once after switching providers.

```bash
DATABASE_URL=$DATABASE_URL node scripts/normalize-vectors.js
```
