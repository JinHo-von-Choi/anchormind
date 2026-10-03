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

Every command except `serve` sends server logs to stderr (the CLI sets `MEMENTO_LOG_STDERR=true` before loading the command module). stdout carries only the command result, so `--json` output can be piped as is. A `MEMENTO_LOG_STDERR` value already present in the environment is respected.

### Remote Access Environment Variables

| Variable | Description |
|----------|-------------|
| `MEMENTO_CLI_REMOTE` | MCP server URL to use when `--remote` is not specified |
| `MEMENTO_CLI_KEY` | API key to use when `--key` is not specified |

---

## Command Classification

### Local-only (remote access not supported)

`serve`, `migrate`, `cleanup`, `backfill`, `health`, `update`, `export`, `import`, `benchmark`, and `anchor-scope` access the DB or process directly and return an error when used with `--remote`.

### Remote-capable

`recall`, `remember`, `stats`, `inspect`, `session` can be executed through a remote MCP server via `--remote URL --key KEY`.

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
| `export [--topic x] [--type t] [--format-version n]` | Dump fragments as JSONL (format version 2 by default) | No |
| `import [--input FILE] [--key id] [--restore]` | Ingest JSONL (file or stdin) | No |
| `completion <shell>` | Print bash/zsh completion script | Yes |
| `benchmark [--goldset FILE]` | Measure recall quality against a goldset | No |
| `anchor-scope [--execute]` | Inventory and normalize approved shared anchors, snapshot backfill (dry-run by default) | No |

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
node bin/memento.js cleanup --execute --include-nli  # also delete NLI-conflict fragments
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

`--format table` prints a key/value table (Fragments, Anchors, Active, Expired, Topics, Avg utility, Noise ratio) followed by a table of the top 5 topics.

Example output (`--format json`, local):

```json
{
  "fragments": 1204,
  "anchors": 38,
  "active": 1180,
  "expired": 24,
  "topics": 12,
  "avgUtility": 0.62,
  "noiseEstimate": { "count": 9, "ratio": 0.7 },
  "topTopics": [{ "topic": "infra", "fragments": 210 }]
}
```

`stats` in `--remote` mode calls the server's `memory_stats` tool, so it needs a master key, and the output is the statistics object the server returns.

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
| `--type <t>` | Fragment type filter (fact, decision, error, preference, procedure, relation) |
| `--limit <n>` | Maximum results to return (default: 10) |
| `--time-range from,to` | Date range filter (ISO 8601) |
| `--workspace <name>` | Search that workspace plus global (NULL) fragments |
| `--all-workspaces` | Master-only explicit cross-workspace search |
| `--include-peer-agents` | Master-only. Include fragments of all agents within the key/workspace scope |

Without a workspace or key default, recall searches global (NULL) fragments only. If writes used an explicit workspace, pass that same `--workspace` when reading; an empty-result hint calls out this scope difference. Use `--all-workspaces` explicitly for the former master-wide behavior.

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
| `--type <t>` | Fragment type (fact, decision, error, preference, procedure, relation; default: fact) |
| `--importance <n>` | Importance score 0.0--1.0 (type default when omitted) |
| `--keywords <a,b,c>` | Comma-separated keywords |
| `--source <name>` | Source label (default: cli) |
| `--stdin` | Read the content from stdin (auto-detected when not a TTY, max 1MB) |
| `--idempotency-key <k>` | Skip storage if a fragment with this key already exists |

Local mode (no `--remote`) passes the same semantic write gate as the server remember and writes through FragmentWriter.

- Email addresses, password fields, mobile phone numbers, API keys and tokens, private keys, resident registration numbers and card numbers are masked (`MEMENTO_SENSITIVE_SCAN`).
- Content longer than 300 characters (1000 for episode) is truncated when stored.
- Supplied keywords are lowercased and merged with keywords extracted from the content.
- When the same content already exists in the duplicate detection scope (`MEMENTO_DEDUP_SCOPE`, by default the same workspace or a global fragment), no new row is created and the existing fragment id is printed.
- importance is stored with the same per-type cap as server writes (the output shows the requested value).
- content_hash is the full sha256 of the content (64 hex characters), the same as server writes.
- PolicyRules warnings, if any, are included as `validation_warnings` in the `--json` output.

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

`session rotate` rebinds only the ID while preserving the Redis-stored session state. In-progress work and memory fragments are unaffected. `reason` is up to 128 chars of audit-log text (CLI default `user_request`; a direct HTTP call defaults to `explicit_rotate`).

Rotate endpoint policy:

- HTTP: `POST /session/rotate` (body: `{ "reason": "..." }`)
- Auth: `Authorization: Bearer <API key or master key>` plus `Mcp-Session-Id` header for target session
- Origin check: without an `Origin` header only requests from a loopback socket are accepted. When `ALLOWED_ORIGINS` or `ADMIN_ALLOWED_ORIGINS` is set, an Origin outside both lists gets 403
- Rate limit: `MEMENTO_ROTATE_RATE_LIMIT_PER_MIN` per IP per minute (default 5); exceeding returns 429
- Metrics: `mcp_session_rotation_total` (label: `outcome`, values: `rotated`, `not_found`, `expired`, `forbidden`, `unavailable`, `error`), `mcp_rotate_rate_limited_total`

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

Dump fragments as JSONL for backup or migration. The default is format version 2 (header line, fragment lines with all columns, link lines, end line); the structure is defined in the [API and Export Format Version Policy](api-versioning.en.md).

```bash
node bin/memento.js export --topic memento-mcp --type fact > out.jsonl
node bin/memento.js export --since 2026-04-01 --output backup.jsonl
node bin/memento.js export --key <key_id> --limit 500
node bin/memento.js export --include-versions --output full.jsonl
node bin/memento.js export --format-version 1 --output legacy.jsonl
```

Main options: `--topic`, `--type`, `--since <ISO>`, `--limit <n>`, `--output <FILE>`, `--format-version <1|2>`, `--no-links` (leave out link lines), `--include-versions` (add amendment history lines), `--json` (emit array).

- Fragments are read in id ordered batches and written line by line.
- Only links that are not deleted and whose two ends are both exported are written. Narrowing the scope with `--topic`, `--type`, `--since` or `--limit` drops links to fragments outside it.
- Format version 1 carries the 17 fragment columns only.

Help:

```bash
node bin/memento.js export --help
```

### import

Read fragments (with links and amendment history) from a JSONL file or stdin and load them. Reads format version 2 files (export output) and version 1 files (fragment lines without a header, accepted until 2027-10-03).

```bash
node bin/memento.js import --input out.jsonl
cat out.jsonl | node bin/memento.js import
node bin/memento.js import --input out.jsonl --idempotent --dry-run
node bin/memento.js import --input out.jsonl --key <key_id>
node bin/memento.js import --input full.jsonl --restore
```

Main options: `--input <FILE>`, `--key <key_id>` (target key, master scope when omitted), `--idempotent`, `--dry-run`, `--restore`, `--json`.

Each fragment line passes the semantic write gate (outside the transaction) and is written through FragmentWriter in its own transaction.

- Email addresses, password fields, mobile phone numbers, API keys and tokens, private keys, resident registration numbers and card numbers are masked, and content longer than 300 characters (1000 for episode) is truncated when stored. Keywords are lowercased.
- The key written is chosen by `--key`; the `key_id` of a file row is never read (it is counted in `ignored.key_id`). The CLI runs with the DB account of the server host, which is the owner path, so `is_anchor` follows the file.
- Counts are imported (newly written), duplicates (same content already stored in the duplicate detection scope, `MEMENTO_DEDUP_SCOPE`), rejected (typed reason) and errors (failures that are not about the row); a row falls in exactly one. `skipped` in `--json` equals `duplicates`.
- Rows the gate does not accept (missing or too short content, more than 4000 characters, malformed keywords, policy violations on a hard-gate key) and rows the database rejects because of their values (CHECK constraints on type, assertion_status and so on) are counted per reason in `rejected_by_reason`, and the import continues with the next line.
- A row whose id exists with different content is rejected as `id_conflict`. `--idempotent` counts only the same id within the same key as a duplicate; an id owned by another key is `id_conflict`. An `idempotency_key` used by another row is rejected as `idempotency_conflict`. When the same row is imported concurrently it is checked once more and counted as a duplicate when the content is the same.
- Input with no header line, no end line and only lines that are not JSON or not records is refused without writing anything and the command exits with code 1.
- A newly written row whose values differ from the file is counted as `transformed` (reason `content`: the gate changed the content, `importance`: the per-type cap lowered the value).
- A link line is written only when both end fragments were handled in the same run. An end that maps to an existing fragment because the content matches links to the existing fragment's id. Amendment history lines attach only to fragments created in this run.
- `--dry-run` processes through the same path and rolls the transaction back at the end. The counts equal those of a real run and no gate metrics are recorded. It is one transaction and holds the locks of the rows it wrote until it ends, so split files into about 5000 fragment lines each. The DB is contacted (input the gate rejects entirely does not connect).
- `--restore` restores stored values. It works only on format version 2 files, skips the minimum quality check and the storage length cut, and writes `importance`, `ttl_tier` and `workspace_source` as in the file. Secret masking still applies while `MEMENTO_WRITE_GATE` is on (when it is off content is neither trimmed nor masked), and one audit log line with the `outcome` (completed, failed) and the counts so far is written whether the run ends or stops on an error. Content is trimmed at both ends, so it is not byte exact. Use it to restore existing rows that a normal import would change or reject under the same `content_hash`.
- `created_at` and `valid_from` use the file value; access counts and the verification time take the values at import time. Embeddings are created by the server's embedding backfill.

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

Using `--remote` or `MEMENTO_CLI_REMOTE` with a local-only command (`serve`, `migrate`, `cleanup`, `backfill`, `health`, `update`, `export`, `import`, `benchmark`, `anchor-scope`) returns an error.

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
| `npm run test:coverage` | Run the unit tests, then compare line, branch and function coverage totals with `coverage-baseline.json` (`scripts/check-coverage.js`) |
| `npm run test:integration` | Integration and E2E tests (all) |
| `npm run test:integration:llm` | LLM provider integration tests (sequential) |
| `npm run test:e2e` | E2E tests only |
| `npm run test:e2e:local` | Runs `scripts/run-e2e-tests.sh` |
| `npm run test:db` | Real-PostgreSQL tests (row lock order, batch link creation consistency, online indexes and resumable backfill, duplicate detection scope, working memory rows, outbox worker, export and import round trip). Creates and drops a dedicated database per run |
| `npm run test:ci` | `npm test` followed by `npm run test:integration` |
| `npm run lint` | ESLint |
| `npm run lint:ratchet` | `scripts/lint-ratchet.js`. Fails when a per-rule metric grows past the baseline (`scripts/lint-baseline.json`) |
| `npm run lint:migrations` | `scripts/lint-migrations.js`. Checks migration numbering conflicts and convention violations |
| `npm run switches` | `scripts/switch-report.mjs`. Prints the applied value, default and state of every feature switch as a table. `-- --strict` exits with code 1 when a switch has an invalid value |
| `npm run audit:ci` | audit-ci dependency check (`audit-ci.jsonc`) |
| `npm run release -- X.Y.Z` | `scripts/release.js`. Release preparation (version markers, commit, annotated tag). Prints the push and Release commands without running them |

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

Updates the vector column dimensions in `fragments`, `morpheme_dict`, and `fragment_synthetic_query` simultaneously. The skip decision compares the (type, declared dimension) pair, and `--dry-run` previews the conversion targets without applying changes. Each table converts inside a transaction and rolls back on mid-step failure. After conversion, `fragments` is re-embedded automatically by the server scheduler, while `morpheme_dict` requires a separate run of `node scripts/backfill-morpheme-dict.js`.

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

### OAuth client cleanup

Removes old dynamically registered clients that were never used. Clients bound to an API key are excluded. The default is a preview that prints the candidate count and a sample; `--execute` deletes in batches of 200.

```bash
node scripts/purge-oauth-clients.js                         # preview
node scripts/purge-oauth-clients.js --older-than-days 45    # cutoff (default 30)
node scripts/purge-oauth-clients.js --execute               # delete
```

Deletion cannot be undone, so keep a copy of the table with `pg_dump -t agent_memory.oauth_clients` before running it.

### Import cycle check

```bash
node scripts/import-cycles.js
```

Finds cycles of size 2 or more among the relative imports of `lib`, `config` and `server.js`, and prints the result for static imports only and the result including dynamic imports separately.

### benchmark

Measures recall quality against a goldset of (stored text, paraphrased query) pairs. Seeds the stored texts into an isolated key scope, runs the queries, computes Recall@k / MRR / latency from the rank of the expected fragment, and removes the seeded fragments when finished.

```bash
node bin/memento.js benchmark
node bin/memento.js benchmark --repeat 3 --json
node bin/memento.js benchmark --save-baseline scripts/baseline-recall.json
node bin/memento.js benchmark --baseline scripts/baseline-recall.json
```

Options: `--goldset <path>` (default `tests/fixtures/recall-goldset.jsonl`), `--baseline <path>`, `--save-baseline <path>`, `--limit <n>`, `--repeat <n>`, `--synthetic`, `--page-size <n>`, `--key-scope isolated|corpus`, `--agent-id <id>` (default `benchmark-harness`), `--workspace <name>` (default `__benchmark__`), `--no-seed`, `--no-cleanup`, `--format table|json`.

Before seeding, one line with the target DB (host, port, database) is written to stderr. A run with zero embedded fragments (including `--no-seed`) is refused by `--save-baseline`. The baseline file records the embedding provider, model and dimensions, and a `--baseline` comparison warns when the model or dimensions differ. The `isolated` mode creates the isolation key `benchmark-harness-key` (status `inactive`) row in `api_keys` once.

`--synthetic` generates synthetic reverse queries for the seeded fragments before evaluating, so the augmentation can be measured as a controlled variable. It costs one LLM call per fragment and is therefore off by default.

Exits with code 2 when `--baseline` comparison detects a regression. Tolerances are 2pp for recall and 15% for p95 latency. Repeated evaluations of one seeding show zero spread, but a fresh seeding moves the number by about 1pp, so a tighter tolerance would fire on noise.

| Mode | Candidate set | Reproducible | Use |
|-|-|-|-|
| `isolated` (default) | seeded goldset only | identical across runs | attribution of a change |
| `corpus` | competes with production fragments | varies as the corpus changes | realistic haystack check |

`--repeat` seeds once and evaluates repeatedly, reporting the median and the spread across runs. Seeding is followed by a settle step that waits for morpheme registration and automatic link creation; without it, ranks shift between runs even with identical code.
