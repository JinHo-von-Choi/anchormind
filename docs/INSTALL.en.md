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
> 7. Call `mcp__memento__context` to verify wiring (`mcp__memento__memory_stats` also works with a master key)
>
> Report each step as a table. On failure, consult `docs/getting-started/troubleshooting.md` and try to recover."

**Integrate into an existing Claude Code setup**

> "Add memento-mcp to my `~/.claude.json`. Follow `docs/getting-started/claude-code.md`:
>
> 1. Back up `~/.claude.json`
> 2. Add memento-mcp under `mcpServers` with URL and ACCESS_KEY
> 3. Tell me how to restart Claude Code
> 4. Verify `mcp__memento__remember` etc. appear in the tool list"

### Checklist the AI Should Satisfy

After the assistant finishes, all of the following must hold:

- `.env` exists, with `MEMENTO_ACCESS_KEY`, `POSTGRES_*`, and `REDIS_*` populated
- `npm run migrate` succeeds through `migration-054`
- `node bin/memento.js health` returns OK for DB, Redis, and the embedding provider
- The AI client lists `mcp__*__remember`, `recall`, and `reflect`
- A `context` call returns a valid response (zero fragments is fine; so does `memory_stats` with a master key)

### When the AI Gets Stuck

- Dependency errors: [Troubleshooting](getting-started/troubleshooting.md)
- Windows: [Windows WSL2 Setup](getting-started/windows-wsl2.md)
- Claude Code details: [Claude Code Configuration](getting-started/claude-code.md)
- Smoke test: [First Memory Flow](getting-started/first-memory-flow.md)
- Operating manual: [SKILL.md](../SKILL.md)

---

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

---

## Manual Installation

## Dependencies

```bash
npm install

# (Optional) If npm install fails on a CUDA 11 system due to onnxruntime-node GPU binding:
# npm install --onnxruntime-node-install-cuda=skip
```

**Note on ONNX Runtime and CUDA:** On systems with CUDA 11 installed, `npm install` may fail during `onnxruntime-node` post-install. Use `npm install --onnxruntime-node-install-cuda=skip` to force CPU-only mode. This project does not require GPU acceleration.

## PostgreSQL Schema

The `pgvector` extension must be installed prior to schema initialization:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Verify with `\dx` in psql. The HNSW index requires pgvector 0.5.0 or later.

**Fresh install:**

```bash
npm run migrate
```

One command is enough even on an empty database. The runner detects a missing
base schema, applies `lib/memory/memory-schema.sql` first, and then runs the
migrations in order.

The only prerequisite is the `vector` extension, which requires superuser rights.

```bash
psql -U postgres -d $POSTGRES_DB -c "CREATE EXTENSION IF NOT EXISTS vector"
```

Applying the base schema by hand still works, but is not required.

```bash
psql -U $POSTGRES_USER -d $POSTGRES_DB -f lib/memory/memory-schema.sql
```

## Upgrade (Existing Installation)

Run migrations in order:

```bash
# Temporal schema: adds valid_from, valid_to, superseded_by columns and indexes
psql $DATABASE_URL -f lib/memory/migrations/migration-001-temporal.sql

# Decay idempotency: adds last_decay_at column
psql $DATABASE_URL -f lib/memory/migrations/migration-002-decay.sql

# API key management: creates api_keys and api_key_usage tables
psql $DATABASE_URL -f lib/memory/migrations/migration-003-api-keys.sql

# API key isolation: adds key_id column to fragments
psql $DATABASE_URL -f lib/memory/migrations/migration-004-key-isolation.sql

# GC policy reinforcement: adds auxiliary indexes on utility_score and access_count
psql $DATABASE_URL -f lib/memory/migrations/migration-005-gc-columns.sql

# fragment_links constraint: adds superseded_by to relation_type CHECK
psql $DATABASE_URL -f lib/memory/migrations/migration-006-superseded-by-constraint.sql

# Link weight column for Hebbian co-retrieval strength
psql $DATABASE_URL -f lib/memory/migrations/migration-007-link-weight.sql

# Morpheme dictionary table for Korean tokenization
psql $DATABASE_URL -f lib/memory/migrations/migration-008-morpheme-dict.sql

# fragment_links CHECK: adds co_retrieved relation type
psql $DATABASE_URL -f lib/memory/migrations/migration-009-co-retrieved.sql

# EMA activation columns for dynamic decay half-life
psql $DATABASE_URL -f lib/memory/migrations/migration-010-ema-activation.sql

# API key groups (N:M mapping for cross-agent memory sharing)
psql $DATABASE_URL -f lib/memory/migrations/migration-011-key-groups.sql

# Quality verification column
psql $DATABASE_URL -f lib/memory/migrations/migration-012-quality-verified.sql

# Search events observability table
psql $DATABASE_URL -f lib/memory/migrations/migration-013-search-events.sql

# TTL short-lived fragments
psql "$DATABASE_URL" -f lib/memory/migrations/migration-014-ttl-short.sql

# created_at index for time-range queries
psql "$DATABASE_URL" -f lib/memory/migrations/migration-015-created-at-index.sql

# agent_id + topic composite index
psql "$DATABASE_URL" -f lib/memory/migrations/migration-016-agent-topic-index.sql

# Episodic memory table and indexes
psql "$DATABASE_URL" -f lib/memory/migrations/migration-017-episodic.sql

# api_keys.fragment_limit column (NULL = unlimited)
psql $DATABASE_URL -f lib/memory/migrations/migration-018-fragment-quota.sql

# HNSW tuning: rebuilds the index with ef_construction 64 → 128
psql $DATABASE_URL -f lib/memory/migrations/migration-019-hnsw-tuning.sql

# search_events per-layer latency columns
psql $DATABASE_URL -f lib/memory/migrations/migration-020-search-layer-latency.sql

# OAuth client registration
psql $DATABASE_URL -f lib/memory/migrations/migration-021-oauth-clients.sql

# fragment_links CHECK: adds the temporal relation type
psql $DATABASE_URL -f lib/memory/migrations/migration-022-temporal-link-type.sql

# fragment_links.weight integer → real
psql $DATABASE_URL -f lib/memory/migrations/migration-023-link-weight-float.sql

# Workspace isolation: fragments.workspace + api_keys.default_workspace
psql $DATABASE_URL -f lib/memory/migrations/migration-024-workspace.sql

# Narrative Reconstruction columns: case_id + structured episode columns in fragments
psql $DATABASE_URL -f lib/memory/migrations/migration-025-case-id-episode.sql
# Narrative Reconstruction: case_events + case_event_edges + fragment_evidence tables
psql $DATABASE_URL -f lib/memory/migrations/migration-026-case-events.sql

# Reconsolidation, Episode Continuity, Spreading Activation: fragment_links consolidated columns + link_reconsolidations + case_events idempotency_key + keywords GIN index
psql $DATABASE_URL -f lib/memory/migrations/migration-027-v25-reconsolidation-episode-spreading.sql

# Composite indexes, used_rrf consolidation, superseded_by removal
psql $DATABASE_URL -f lib/memory/migrations/migration-028-v253-improvements.sql

# SearchParamAdaptor learning table
psql $DATABASE_URL -f lib/memory/migrations/migration-029-search-param-thresholds.sql

# search_param_thresholds.key_id INTEGER → TEXT (UUID compatible)
psql $DATABASE_URL -f lib/memory/migrations/migration-030-search-param-thresholds-key-text.sql

# content_hash global UNIQUE → per-tenant partial unique index
psql $DATABASE_URL -f lib/memory/migrations/migration-031-content-hash-per-key.sql

# Symbolic Memory Layer: fragment_claims table + tenant isolation partial unique
psql $DATABASE_URL -f lib/memory/migrations/migration-032-fragment-claims.sql

# api_keys.symbolic_hard_gate column (symbolic hard gate opt-in)
psql $DATABASE_URL -f lib/memory/migrations/migration-033-symbolic-hard-gate.sql

# api_keys.default_mode + fragments.affect + fragments.idempotency_key (single bundle)
psql $DATABASE_URL -f lib/memory/migrations/migration-034-v2.16.0-bundle.sql

# fragments.morpheme_indexed BOOLEAN + backfill + sparse partial index
psql $DATABASE_URL -f lib/memory/migrations/migration-035-morpheme-indexed.sql

# fragments.split_attempt_failed_at TIMESTAMPTZ column
psql $DATABASE_URL -f lib/memory/migrations/migration-036-split-attempt-failed-at.sql

# HNSW index rename for naming consistency
psql $DATABASE_URL -f lib/memory/migrations/migration-037-hnsw-index-rename.sql

# fragment_versions resolution_status/outcome/phase columns
psql $DATABASE_URL -f lib/memory/migrations/migration-038-fragment-versions-case-fields.sql

# task_feedback outcome/evaluator/evidence/unmet_requirements + tool_feedback irrelevance_reason
psql $DATABASE_URL -f lib/memory/migrations/migration-039-feedback-instrumentation.sql

# fragments.workspace_source + quality_rationale columns
psql $DATABASE_URL -f lib/memory/migrations/migration-040-workspace-audit-columns.sql

# Columns recording inferred workspace values
psql $DATABASE_URL -f lib/memory/migrations/migration-041-workspace-backfill-inference.sql

# api_keys.allowed_workspaces column
psql $DATABASE_URL -f lib/memory/migrations/migration-042-api-keys-allowed-workspaces.sql

# fragment_synthetic_query auxiliary vector table
psql $DATABASE_URL -f lib/memory/migrations/migration-043-fragment-synthetic-query.sql

# idempotency_records table
psql $DATABASE_URL -f lib/memory/migrations/migration-044-idempotency-records.sql

# RLS enabled on fragments and fragment_links with isolation policies
psql $DATABASE_URL -f lib/memory/migrations/migration-045-fragment-rls.sql

# search_events scope columns + fragment_versions agent snapshot columns
psql $DATABASE_URL -f lib/memory/migrations/migration-047-agent-scope-audit.sql

# case_closed added to case_events.event_type
psql $DATABASE_URL -f lib/memory/migrations/migration-048-case-events-case-closed.sql

# Synthetic query embedding alignment marker (the DDL is applied by scripts/migrate.js)
psql $DATABASE_URL -f lib/memory/migrations/migration-049-align-synthetic-query-embedding.sql

# Per key and workspace content_hash unique indexes (production databases create them first with online-index)
psql $DATABASE_URL -f lib/memory/migrations/migration-050-dedup-scope-workspace.sql

# search_events budget selection columns (candidate_count, budget_kept)
psql $DATABASE_URL -f lib/memory/migrations/migration-051-search-events-budget.sql

# outbox_events table
psql $DATABASE_URL -f lib/memory/migrations/migration-052-outbox-events.sql

# case_events source fragment index (production databases create it first with online-index)
psql $DATABASE_URL -f lib/memory/migrations/migration-054-case-events-source-fragment.sql

# api_keys.egress_policy (LLM egress policy) column
psql $DATABASE_URL -f lib/memory/migrations/migration-055-api-keys-egress-policy.sql

# admin_audit_events audit hash chain table
psql $DATABASE_URL -f lib/memory/migrations/migration-056-admin-audit-events.sql
# Fragment provenance, trust tier and review state columns
psql $DATABASE_URL -f lib/memory/migrations/migration-057-fragment-provenance.sql

# Review decision table and review_state value constraint
psql $DATABASE_URL -f lib/memory/migrations/migration-058-review-decisions.sql

psql $DATABASE_URL -f lib/memory/migrations/migration-060-admin-users.sql
```

There is no migration 046. Prefer `npm run migrate`, which records applied files and substitutes the vector opclass automatically.

After migration-050 the per-key content_hash indexes (`uq_frag_hash_per_key`, `uq_frag_hash_master`) remain, so duplicate detection stays per key. A new install finishes the switch to per workspace detection (`MEMENTO_DEDUP_SCOPE=workspace`, the default) by dropping the per-key indexes with the command below after migrating. Without options it only prints the steps; the target comes from `--url` or the PG environment variables (it does not read environment files).

```bash
node scripts/ops/finish-dedup-scope.mjs
PGHOST=<host> PGDATABASE=<db> PGUSER=<user> PGPASSWORD=<password> node scripts/ops/finish-dedup-scope.mjs --confirm
```

Installs whose per-key indexes carry the names `fragments_new_key_id_content_hash_idx` and `fragments_new_content_hash_idx` are detected and dropped the same way when the definition matches. The following query lists the detection indexes present:

```sql
SELECT c.relname, i.indisvalid, i.indisready
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relnamespace = 'agent_memory'::regnamespace
   AND c.relname IN ('uq_frag_hash_per_key', 'uq_frag_hash_master',
                     'fragments_new_key_id_content_hash_idx', 'fragments_new_content_hash_idx',
                     'uq_frag_hash_ws_per_key', 'uq_frag_hash_ws_master');
```

The production rollout and its rollback are described in [operations/online-migration.md](operations/online-migration.md#중복-판정-범위-전환).

> **Re-running migration-007**: If you change `EMBEDDING_DIMENSIONS` or switch embedding providers, re-run `scripts/post-migrate-flexible-embedding-dims.js` to update the vector column dimensions in the `fragments`, `morpheme_dict`, and `fragment_synthetic_query` tables simultaneously.

Since v1.8.0, automatic migration is supported. Instead of running each file manually:

```bash
DATABASE_URL=postgresql://user:pass@host:port/dbname npm run migrate
```

When adding new migration files, verify body-only convention compliance before running migrate:

```bash
npm run lint:migrations
```

See [docs/migration-conventions.md](migration-conventions.md) for convention details.

> **migration-035 morpheme_indexed**: Adds `fragments.morpheme_indexed BOOLEAN NOT NULL DEFAULT false`. Existing fragments with `keywords IS NOT NULL` are automatically backfilled to `true`. A sparse partial index `idx_fragments_morpheme_indexed` (`WHERE morpheme_indexed = false`) tracks fragments pending re-indexing. `DEFAULT false` makes hot deploy safe without rollback. The Consistency Gate restricts L3 morpheme search to fragments where `morpheme_indexed = true`.

> **migration-036 split_attempt_failed_at**: Adds `fragments.split_attempt_failed_at TIMESTAMPTZ` to record split-attempt failure timestamps, enabling the reprocessing scheduler to track failure history.

> **migration-037 hnsw-index-rename**: Renames HNSW indexes for naming consistency. Drops the existing indexes and recreates them under the standard naming convention.

> **migration-038 fragment-versions-case-fields**: Adds `resolution_status`, `outcome`, and `phase` to `fragment_versions` so an amend that updates case state preserves the prior state in history. All three columns are nullable, so mixed old/new writers during a rolling deploy stay compatible.

> **migration-039 feedback-instrumentation (required before 5.6.0)**: Adds `outcome`, `evaluator`, `evidence`, `unmet_requirements` plus CHECK constraints on `outcome` and `evaluator` to `task_feedback`, and `irrelevance_reason` with its CHECK constraint plus the partial index `idx_tf_irrelevance` to `tool_feedback`. **A 5.6.0 server started without this migration fails to persist `tool_feedback` calls and the `task_effectiveness` payload of `reflect`, because the columns are missing.** Existing rows are not backfilled, so NULL means "unreported"; `task_completed_rate` and `irrelevance_breakdown` in `memory_stats` denominate only reported rows.

> **migration-034-v2.16.0-bundle CONCURRENTLY option**: migration-034-v2.16.0-bundle runs inside a transaction, so it uses `CREATE UNIQUE INDEX` (not CONCURRENTLY). For large production tables (millions of fragments) where minimizing lock time is critical, run the two statements below manually before `npm run migrate`. The IF NOT EXISTS guard ensures they are safely skipped during automatic execution.
>
> ```sql
> CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_tenant
>   ON agent_memory.fragments (key_id, idempotency_key)
>   WHERE idempotency_key IS NOT NULL AND key_id IS NOT NULL;
>
> CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_master
>   ON agent_memory.fragments (idempotency_key)
>   WHERE idempotency_key IS NOT NULL AND key_id IS NULL;
> ```

### Upgrading from before migration-034 bundle

```bash
# 1. Update dependencies
npm install

# 2. Run migrations (includes migration-034-v2.16.0-bundle)
npm run migrate

# 3. Review EMBEDDING_PROVIDER
#    If you changed the provider or EMBEDDING_DIMENSIONS:
#    EMBEDDING_DIMENSIONS=N DATABASE_URL=$DATABASE_URL node scripts/post-migrate-flexible-embedding-dims.js
#    DATABASE_URL=$DATABASE_URL node scripts/backfill-embeddings.js

# 4. Check .env
#    Add MEMENTO_CLI_REMOTE and MEMENTO_CLI_KEY if using the CLI in remote mode

# 5. Restart the server
node server.js
```

Verify migration-034-v2.16.0-bundle index application:

```sql
-- In psql
\d agent_memory.fragments
-- Both idx_fragments_idempotency_tenant and idx_fragments_idempotency_master should appear.
```

### Upgrading from before migration-037

```bash
# 1. Update dependencies
npm install

# 2. Run migrations (includes migration-036, migration-037)
npm run migrate

# 3. Restart the server
node server.js
```

### Upgrading to 5.6.0 (migration-039 required first)

5.6.0 inserts directly into `tool_feedback.irrelevance_reason` and the `task_feedback.outcome` family of columns. Starting 5.6.0 without migration-039 makes `tool_feedback` writes and the `task_effectiveness` payload of `reflect` fail, so run the migration before restarting the server.

```bash
# 1. Update dependencies
npm install

# 2. Run migrations (includes migration-038, migration-039)
npm run migrate

# 3. Verify
psql $DATABASE_URL -c "\d agent_memory.task_feedback"   # outcome, evaluator, evidence, unmet_requirements
psql $DATABASE_URL -c "\d agent_memory.tool_feedback"   # irrelevance_reason

# 4. Review .env (optional)
#    MEMENTO_FEEDBACK_SAMPLING=false     : disable the feedback request hint on write tools
#    MEMENTO_SPLIT_SUBJECT_GATE=false    : disable the split-child subject anchor check
#    MEMENTO_SPLIT_MODALITY_GATE=false   : disable the split-child modality drift check

# 5. Restart the server
node server.js
```

Applied migrations are tracked in `agent_memory.schema_migrations`. Only unapplied files are executed in order.

> **MEMENTO_ACCESS_KEY**: The server does not start and exits with code 78 when it is unset, because a server without a key would expose every tool and master scope without authentication. To run without authentication for development or testing, set `MEMENTO_AUTH_DISABLED=true` explicitly in `.env`.

> **Upgrading from v1.1.0 or earlier**: If migration-006 is not applied, any operation that creates a `superseded_by` link — `amend`, `memory_consolidate`, and automatic relationship generation in GraphLinker — will fail with a DB constraint error. This migration is mandatory when upgrading an existing database.

```bash
# For models with >2000 dimensions (e.g., Gemini gemini-embedding-001 at 3072 dims) only:
# EMBEDDING_DIMENSIONS=3072 DATABASE_URL=$DATABASE_URL \
#   node scripts/post-migrate-flexible-embedding-dims.js

# One-time L2 normalization of existing embeddings (safe to re-run; idempotent)
DATABASE_URL=$DATABASE_URL node scripts/normalize-vectors.js

# Backfill embeddings for existing fragments (requires embedding API key, one-time)
npm run backfill:embeddings
```

## Environment Variables

For the fastest bootstrap:

```bash
cp .env.example.minimal .env
```

For the full operational sample:

```bash
cp .env.example .env
# Edit .env: set DATABASE_URL, MEMENTO_ACCESS_KEY, and other required values
```

Additional environment variables:

```
LLM_PRIMARY                   - Primary LLM provider (default: gemini-cli). Options: gemini-cli, agy-cli, codex-cli, opencode-cli, anthropic, etc.
LLM_FALLBACKS                 - JSON array of fallback providers: [{"provider":"anthropic","apiKey":"...","model":"claude-opus-4-6"}]
MEMENTO_REMEMBER_ATOMIC       - When true, atomizes quota check + INSERT in remember() into a single transaction to eliminate TOCTOU (default: false)
MEMENTO_CASE_BACKPROP_ENABLED - When true, enables CaseRewardBackprop — reward back-propagation per case_id (default: false)
MEMENTO_STORAGE               - Storage backend name. Currently pgvector only; this value does not affect behavior
MEMENTO_CONFIG_STRICT         - When true, a problem in a numeric, enum or boolean environment variable stops startup with exit code 78 (default: false; problems are logged as one startup line)
MEMENTO_HEALTH_READY_DB_TIMEOUT_MS - Upper bound of the DB check behind /health/ready (default: 2000)
MEMENTO_SHUTDOWN_DEADLINE_MS  - Upper bound of the whole shutdown sequence (default: 60000, 0 means no bound)
MEMENTO_LLM_CLI_TOOL_APPROVAL - Tool approval mode of gemini-cli, copilot-cli and opencode-cli. none (default) runs with restricted approval in an empty temporary directory; all lifts the approval restriction
MEMENTO_FEEDBACK_SAMPLING     - Attaches a tool_feedback request hint to successful remember/amend/forget responses with a fixed probability (default: true)
MEMENTO_SPLIT_SUBJECT_GATE    - Discards a split child carrying none of the parent's subject anchors (default: true)
MEMENTO_SPLIT_MODALITY_GATE   - Discards a split child introducing a modality absent from the parent (default: true)
MIGRATION_LINT_FROM           - Lower-bound migration number for lint:migrations checks. Defaults to max existing number + 1 when unset
```

For the full list of environment variables, see [Configuration — Environment Variables](configuration.en.md#environment-variables).

---

## Local Embedding Mode (No OpenAI API Key Required)

You can generate embeddings using a local `@huggingface/transformers` model without an OpenAI API key.

### .env Configuration

```
EMBEDDING_PROVIDER=transformers
EMBEDDING_MODEL=Xenova/multilingual-e5-small
EMBEDDING_DIMENSIONS=384
# Do NOT set EMBEDDING_API_KEY — mixing local and API providers corrupts the vector space
```

Supported local models:

| Model | Size | Dimensions | Notes |
|-------|------|-----------|-------|
| `Xenova/multilingual-e5-small` | ~120 MB | 384 | Recommended starting point |
| `Xenova/multilingual-e5-base` | ~280 MB | 768 | Higher accuracy |

Setting `EMBEDDING_PROVIDER=transformers` together with `EMBEDDING_API_KEY` will cause the server to exit immediately on startup to prevent vector space corruption.

### First-Run Model Download

On first startup, the model is automatically downloaded from HuggingFace Hub. For `Xenova/multilingual-e5-small` (~120 MB), this may take a few minutes depending on network speed. Subsequent starts load from the local cache.

```
[LocalEmbedder] loading model Xenova/multilingual-e5-small (dtype=q8)
```

### Cache Path (HF_HOME)

Default cache location: `~/.cache/huggingface`

For Docker deployments, mount the cache directory as a volume to avoid re-downloading on container restart:

```yaml
volumes:
  - hf_cache:/root/.cache/huggingface
environment:
  - HF_HOME=/root/.cache/huggingface
```

For full details, see [docs/embedding-local.md](embedding-local.md).

---

## Optional Dependencies

### gemini CLI (default LLM provider)

```bash
npm install -g @google/gemini-cli
gemini auth login
```

### Codex CLI (LLM fallback)

```bash
npm install -g @openai/codex
codex auth login
```

### Copilot CLI (LLM fallback)

```bash
npm install -g @github/copilot
```

The `copilot` executable must be on the PATH and logged in.

To use a CLI provider, set `LLM_PRIMARY` or `LLM_FALLBACKS` to a provider name such as `gemini-cli`, `codex-cli` or `copilot-cli`. By default (`MEMENTO_LLM_CLI_TOOL_APPROVAL=none`), gemini-cli, copilot-cli and opencode-cli run with restricted tool approval in an empty temporary directory instead of the server working directory.

---

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

## Starting the Server

```bash
node server.js
```

On startup, the server logs the listening port, authentication status, session TTL, confirms `MemoryEvaluator` worker initialization, and begins NLI model preloading in the background (~30s on first download, ~1-2s from cache). Graceful shutdown on `SIGTERM` / `SIGINT` triggers `AutoReflect` for all active sessions, stops `MemoryEvaluator`, drains the PostgreSQL connection pool, and flushes access statistics.

## MCP Client Configuration

See [Claude Code Configuration](getting-started/claude-code.md) for the dedicated setup guide.

For external access, expose the service through a reverse proxy (TLS termination, rate limiting). Do not publish internal host addresses or port numbers in external documentation.

## Hook-Based Context Loading

AnchorMind's `instructions` field encourages the AI to use memory tools actively, but this alone doesn't automatically inject past memories at session start. With Claude Code hooks, you can ensure the AI loads relevant context at the beginning of every session.

**Auto-load Core Memory on session start** (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "SID=$(curl -s -D - -o /dev/null -X POST http://localhost:57332/mcp -H 'Authorization: Bearer YOUR_KEY' -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"hook\",\"version\":\"1\"}}}' | awk 'tolower($1)==\"mcp-session-id:\"{print $2}' | tr -d '\\r'); curl -s -X POST http://localhost:57332/mcp -H 'Authorization: Bearer YOUR_KEY' -H 'Content-Type: application/json' -H \"MCP-Session-Id: $SID\" -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"context\",\"arguments\":{}}}'"
          }
        ]
      }
    ]
  }
}
```

Alternatively, add the following to your `CLAUDE.md` to have the AI load context on its own:

```markdown
## Session Start Rules
- At the start of every conversation, call the `context` tool to load Core Memory and Working Memory.
- Before debugging or writing code, call `recall(keywords=[relevant_keywords], type="error")` to surface related past learnings.
```

`context` returns only high-importance fragments within your token budget, so it injects critical information without polluting the context window. Combining session hooks with `CLAUDE.md` instructions significantly reduces the "amnesia effect" where the AI behaves as if meeting you for the first time each session.

## MCP Protocol Version Negotiation

| Version | Notable Additions |
|---------|------------------|
| `2025-11-25` | Tasks abstraction, long-running operation support |
| `2025-06-18` | Structured tool output, server-driven interaction |
| `2025-03-26` | OAuth 2.1, Streamable HTTP transport |
| `2024-11-05` | Initial release; Legacy SSE transport |

The server advertises all four versions. Clients negotiate the highest mutually supported version during `initialize`.
