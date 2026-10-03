<p align="center">
  <img src="assets/images/anchormind_logo.png" width="400" alt="AnchorMind Logo">
</p>

<p align="center">
  <a href="https://github.com/JinHo-von-Choi/anchormind/releases">
    <img src="https://img.shields.io/github/v/release/JinHo-von-Choi/anchormind?style=flat&label=release&color=4c8bf5" alt="GitHub Release" />
  </a>
  <a href="https://github.com/JinHo-von-Choi/anchormind/stargazers">
    <img src="https://img.shields.io/github/stars/JinHo-von-Choi/anchormind?style=flat&color=f5c542" alt="GitHub Stars" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat" alt="License" />
  </a>
  <a href="https://lobehub.com/mcp/jinho-von-choi-memento-mcp">
    <img src="https://lobehub.com/badge/mcp/jinho-von-choi-memento-mcp" alt="MCP Badge" />
  </a>
</p>

<p align="center">
  <a href="README.md">📖 한국어 문서</a>
</p>

# AnchorMind

> Give your AI a memory. Then let it use that memory as a foundation to grow.

Imagine a new employee whose memory resets every morning. Everything you taught yesterday, every problem you solved together last week, every preference -- all forgotten. AnchorMind gives this new hire a memory.

AnchorMind is a long-term memory server for AI agents, built on MCP (Model Context Protocol). It persists important facts, decisions, error patterns, and procedures across sessions and restores them in the next.

> This project started out as memento-mcp — a name that still fits a memory system well, but one shared by too many similar projects. It is now AnchorMind: memories worth keeping are anchored in place so they don't drift away with the session, echoing the anchor fragments at the core of this system.

This is not a library of memories. As feedback accumulates, connections strengthen. As experiences repeat, patterns abstract. As sessions continue, context becomes narrative. The goal is not an AI that remembers — it is an AI that grows from experience.

> [!TIP]
> If installing and configuring the server yourself feels daunting, hand a single sentence to an AI assistant (Claude Code, Cursor, Codex):
>
> > "Install the anchormind repository in my environment, read `docs/INSTALL.en.md` and `SKILL.md`, apply the recommended settings, then verify it works."
>
> The assistant will walk you through dependency setup, `.env` configuration, MCP registration, and the health check. Detailed delegation flow lives in [`docs/INSTALL.en.md`](docs/INSTALL.en.md#delegate-to-an-ai-assistant).

## 30-Second Demo

Teach your AI something, then watch it recall the knowledge in a new session:

```
[Session 1]
User: "Our project uses PostgreSQL 15, and we run tests with Vitest."
  -> AI calls remember -> 2 fragments saved

[Session 2 -- next day]
  -> AI calls context -> "Uses PostgreSQL 15", "Vitest for testing" auto-restored
User: "How do I run the tests again?"
  -> AI calls recall -> returns the "Vitest" fragment
  -> AI: "This project uses Vitest. Run npx vitest."
```

No more repeating yourself every session.

## Installation

Requirements: Node.js 20+, PostgreSQL (pgvector extension)

> The server runs on Node.js 20 or later. The development unit test suite relies on `--experimental-test-module-mocks`, which is only stable on Node.js 24, so use Node.js 24 to run the tests.

```bash
cp .env.example.minimal .env
# Edit .env, then export to shell
export $(grep -v '^#' .env | grep '=' | xargs)
npm install
npm run migrate
node server.js
```

To use local embeddings without an OpenAI API key, add `EMBEDDING_PROVIDER=transformers` to `.env`. The `Xenova/multilingual-e5-small` model is downloaded automatically on first start. Do not mix local and OpenAI embeddings within the same database — dimension mismatch will cause a startup abort.

Once the server is running, verify it with the [First Memory Flow](docs/getting-started/first-memory-flow.md).

For other platforms, see the [Compatible Platforms](#compatible-platforms) table above.

### Update

```bash
cd ~/memento-mcp
git pull origin main
npm install
npm run migrate
# Restart service (systemd / pm2 / docker as appropriate)
```

- `npm run migrate` automatically reads DB settings from `.env`. No need to pass `DATABASE_URL` manually.
- pgvector schema is auto-detected. `PGVECTOR_SCHEMA` is usually not needed.
- For an update that includes migrations, take a backup with `scripts/ops/backup.sh --label pre-migration` before `npm run migrate`. On a production database with many rows, build the migration-050 indexes with `scripts/ops/online-index.mjs` before `npm run migrate`, and after the deployment finish the duplicate detection scope switch with `node scripts/ops/finish-dedup-scope.mjs --confirm` ([docs/operations/online-migration.md](docs/operations/online-migration.md#중복-판정-범위-전환), Korean).

### Claude Code Integration

Register via the `claude mcp add` CLI. HTTP-type MCP servers placed manually in `settings.json` will not be recognized by Claude Code.

```bash
claude mcp add memento http://localhost:57332/mcp \
  --transport http \
  --scope user \
  --header "Authorization: Bearer YOUR_ACCESS_KEY"
```

The registration is persisted to `~/.claude.json`. Verify:

```bash
claude mcp list
# memento: http://localhost:57332/mcp (HTTP) - ✓ Connected
```

For project-scoped sharing, declare the server in `.mcp.json` at the repository root instead. See [Claude Code Configuration](docs/getting-started/claude-code.md) for details.

### Codex Desktop Integration

Some MCP clients such as Codex Desktop use deferred/lazy tool discovery. tool_search may expose only a subset of tools depending on the query and limit, so recall — which always exists in tools/list — can be missing from storage-biased queries with a low limit. If recall is not visible, retry with a broader query and limit 20 or above. Recommendation: seed this retry rule into the agent system prompt/instructions upfront to prevent the initial discovery loop.

- query: `memento context recall remember reflect batch_remember search_traces reconstruct_history`
- limit: 20 or above

### Supported Environments

| Environment | Recommendation | Getting Started |
|-------------|----------------|-----------------|
| Linux / macOS | Recommended | [Quick Start](docs/getting-started/quickstart.md) |
| Windows + WSL2 | Most recommended | [Windows WSL2 Setup](docs/getting-started/windows-wsl2.md) |
| Windows + PowerShell | Limited support | [Windows PowerShell Setup](docs/getting-started/windows-powershell.md) |

## Compatible Platforms

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

See [integration guides](docs/getting-started/) for platform-specific setup.

## 7 Fragment Types

| Type | Description | Use Case |
|------|-------------|----------|
| `fact` | Factual information | Config values, paths, versions, objective data |
| `decision` | Decision record | Architecture choices, tech stack decisions with rationale |
| `error` | Error & resolution | Errors encountered, root causes, and fixes |
| `preference` | User preference | Coding style, workflow preferences, conventions |
| `procedure` | Procedure | Deployment, build, test steps — repeatable sequences |
| `relation` | Relationship | Entity connections, dependencies, ownership |
| `episode` | Episode narrative | Contextual narrative preserving "why" behind events (1000 chars; others capped at 300) |

## Core Features

| Feature | Description |
|---------|-------------|
| `remember` | Decomposes important information into atomic fragments and stores them. With `MEMENTO_REMEMBER_ATOMIC=true`, the quota check and the INSERT run as a single atomic transaction. |
| `recall` | Returns only relevant memories via keyword + semantic 3-tier search. `SearchScope` consistently applies workspace/caseId/affect and other scope filters across all L1-L3 layers. |
| `context` | Restores key context. `agentId=X` returns `X + default`; omission returns shared `default` memory only. |
| Auto-cleanup | Duplicate merging, contradiction detection, importance decay, TTL-based forgetting |
| Storage access | Storage access is handled by `getPrimaryPool` and `queryWithAgentVector` in `lib/tools/db.js`. `MEMENTO_STORAGE` is the storage backend name and does not affect behavior. |
| **Link Reconsolidation** | `tool_feedback` signals update fragment_links weight/confidence in real time (ReconsolidationEngine). Contradicting links are automatically quarantined. |
| **Spreading Activation** | Passing `contextText` to `recall` pre-boosts activation_score for contextually related fragments, surfacing more relevant results (SpreadingActivation). |
| **Episode Continuity** | After `reflect`, `preceded_by` edges are automatically created between episode fragments to preserve the flow of experience as a graph (EpisodeContinuityService). |
| Admin Console | Memory explorer, knowledge graph, statistics dashboard, API key group/status filters, inline daily-limit editing |
| OAuth Integration | RFC 7591 Dynamic Client Registration, Claude.ai Web and ChatGPT integration support. The access token binds to a stable session ID through a keyId-namespaced Redis reverse index, so a reconnecting client keeps its existing session instead of starting a new one. |
| **Workspace isolation** | Partitions memories by project, role, or client. Recall uses an explicit workspace or `api_keys.default_workspace`; without either it returns global (NULL) fragments only. Cross-workspace reads require master `allWorkspaces=true`. |
| **Batch processing** | `batch_remember` persists fragments through a single multi-row INSERT (256KB or 500-row chunks) and offloads embedding and post-processing to a non-blocking async worker (BatchRememberWorker). With `async: true`, the worker guarantees at-least-once delivery via ack, retry (up to 3), dead-letter, and startup recovery (RPOPLPUSH reliable queue). Use `batch_status(jobId)` to query job state (queued/processing/completed/dead). Always returns a standard single JSON-RPC response (`stream` deprecated). `reflect` delegates its 5 categories through a single batch call. EmbeddingWorker processes queued batches via generateBatchEmbeddings and a multi-row UPDATE. |
| Consistency Gate | The `fragments.morpheme_indexed` column tracks whether morpheme indexing has completed. Fragments not yet indexed are automatically excluded from the L3 morpheme search path. |
| Mode preset | `recall-only` / `write-only` / `onboarding` / `audit` JSON presets. The `X-Memento-Mode` header or `api_keys.default_mode` restricts which tools are exposed. |
| Affective tagging | `fragments.affect` column (neutral / frustration / confidence / surprise / doubt / satisfaction). Filter remember / recall results by emotional label. |
| Recall suggestions | `recall` responses carry a `_meta.suggestion` field that flags repeat queries, empty results with no context, oversized limits with no budget, and noisy untyped queries. Clients are free to ignore it. |
| Local embedding | `EMBEDDING_PROVIDER=transformers` runs `@huggingface/transformers` pipeline-based embeddings without an external API call (`Xenova/multilingual-e5-small`, 384d by default). |
| Semantic write gate | `remember`, `amend`, `batch_remember`, reflect derived writes, imports and the CLI `remember` local mode pass the same gate (normalization, sensitive data masking, per-type length caps, PolicyRules, workspace permission, anchor permission). Violations are reported in `validation_warnings` and rejected only for keys with `symbolic_hard_gate=true` (`MEMENTO_WRITE_GATE`, `MEMENTO_SENSITIVE_SCAN`). |
| Duplicate detection scope | The same body counts once per key and workspace. A hit on an existing fragment in the same scope returns its id in `duplicate_of` of the `remember` response (`MEMENTO_DEDUP_SCOPE`). |
| Working memory fallback | While Redis is not ready, `remember(scope=session)` is stored as a PostgreSQL working memory row, and `working_memory` in the response reports the storage path (`MEMENTO_WM_PG_FALLBACK`). |
| Recall budget selection | Candidates, linked fragments included, receive the final score before selection within `tokenBudget` (`MEMENTO_RANK_BEFORE_BUDGET`). |
| Export and import | Export writes format version 2 JSONL (all fragment columns, links, revision history); import writes through the same write gate under a chosen target key. Compatibility rules are in [docs/api-versioning.en.md](docs/api-versioning.en.md). |
| Transactional outbox | Events are recorded inside the changing transaction, and a worker delivers them to per-topic handlers with `SKIP LOCKED` claims, retries, dead-letter and retention cleanup (`MEMENTO_OUTBOX`). |
| Migration lint | `npm run lint:migrations` checks new migration files for numbering conflicts and convention violations before commit. |

See [SKILL.md](SKILL.md) for the full list of MCP tools.

### Agent scope

`agent_id='default'` is shared within the same key/workspace; any other value selects that agent's scope. Omit `agentId` or use `default` for ordinary clients. API keys have no trusted specific-agent binding; strict mode restricts specific-agent selection to master authentication. `includePeerAgents=true` always requires master authentication and never widens key/workspace boundaries. Before normalizing legacy anchors, run `memento-mcp anchor-scope --classifications <file>` (dry-run by default). Add `--include-non-anchors` to inventory all legacy fragments. Execution requires migration-047 plus the bare `--execute --approve-shared` flags.

This transition release defaults `MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE` to `true`, allowing deployed clients' non-default `agentId` claims. Each compatibility use emits a warning and increments `mcp_legacy_unbound_agent_scope_total`. This does not authenticate agents sharing an API key. Migrate clients, confirm the counter stops increasing, then explicitly set `false` for strict mode. A default change in the next minor release requires first confirming zero compatibility usage.

For upgrades, apply migration-047 (nullable columns), roll the new code to every instance and confirm all old writers have stopped, inspect counts with `memento-mcp anchor-scope --backfill-snapshots`, then run `--backfill-snapshots --execute --approve-backfill`. Both `fragment_versions` and `case_events` require manual backfill; `migrate` warns about pending snapshots. Until then, NULL snapshots are excluded and existing version histories may appear empty. Missing/deleted-source rows remain quarantined as NULL, excluded even from peer reads. Remaining or quarantined rows cause `SNAPSHOT_BACKFILL_INCOMPLETE` with `sourceMissing`/`sourceDeleted` counts. Quarantined rows require operator review; rerunning alone cannot repair them.

Reconnect old sessions and run `initialize` again. Old sessions reused without bearer credentials may fail with `-32001` because their explicit authentication scope cannot be restored. Normalization moves fragment and version snapshot agents in one transaction. Rolling back the snapshot migration drops columns and backfill results but does not undo normalization; reapplying/backfilling uses the current agent. Keep a separate pre-execution backup if restoration is required.

Backfill is limited to 1,000 batches per invocation. `--batch-size` accepts integers from 1 to 10,000 (default 500). Reaching the limit fails with committed progress counts. Progress is retained, so confirm old writers have stopped and rerun the same command to process remaining NULL snapshots.

## CLI

Operate a remote MCP server directly without a local instance, using the `--remote URL --key KEY` global flags or the `MEMENTO_CLI_REMOTE` / `MEMENTO_CLI_KEY` environment variables.

```bash
# Remote recall via environment variable
MEMENTO_CLI_REMOTE=https://memento.anchormind.net/mcp MEMENTO_CLI_KEY=mmcp_xxx memento-mcp recall "query"

# Remote recall via flags
memento-mcp recall "query" --remote https://memento.anchormind.net/mcp --key mmcp_xxx

# Table output, limit 5
memento-mcp recall "query" --format table --limit 5

# Prevent duplicate storage with an idempotency key
memento-mcp remember "content" --topic project --idempotency-key k1
```

`--format table|json|csv` selects the output format; all 16 subcommands support `--help` / `-h`. See [docs/cli.md](docs/cli.md) for the full flag reference.

## API Response Meta

`recall` / `context` responses include a `_meta: { searchEventId, hints, suggestion, serverTime }` field. `serverTime` exposes the server's current time on every response to counter LLM clients anchoring to their training cutoff.

```json
{
  "fragments": [...],
  "_meta": {
    "searchEventId": 1234,
    "hints": [
      { "signal": "consider_context", "suggestion": "...", "trigger": "recall" }
    ],
    "suggestion": { "code": "empty_result_no_context", "message": "..." },
    "serverTime": {
      "iso"        : "2026-05-15T06:32:11.000Z",
      "epoch_ms"   : 1747291931000,
      "display_kst": "2026년 5월 15일 (목) 15:32",
      "timezone"   : "Asia/Seoul"
    }
  }
}
```

Successful `remember` / `amend` / `forget` responses carry a `feedback_sampled` signal in `_meta.hints` with a fixed probability. Pass the hint's `args` straight into `tool_feedback` to rate the result (disable with `MEMENTO_FEEDBACK_SAMPLING=false`).

`remember` / `link` / `forget` / `amend` accept a `dryRun: true` parameter that returns the expected result with no side effects. `POST /mcp` responses for API-key sessions carry `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Resource: fragments` headers (fragment quota); they are omitted for the master key or when the quota is null. `recall` accepts a `fields` array that restricts the returned fields to a whitelist of 19. `remember` / `batchRemember` accept an `idempotencyKey` parameter (max 128 chars) that prevents duplicate storage within the same key_id scope. `content` on `remember`, `batchRemember` items, and `amend` is rejected with a JSON-RPC -32602 error once it exceeds 4000 characters. This reception gate runs ahead of the per-type storage truncation (1000/300 chars) described above, and `batchRemember` fails only the offending item and continues processing the rest of the batch.

## Security

- RBAC default-deny: Any tool name absent from the `TOOL_PERMISSIONS` map is rejected immediately regardless of permissions.
- Tenant isolation: forget / amend / link / fragment_history enforce SQL-level `key_id` conditions that prevent cross-tenant fragment access. "Not found" and "not authorized" return the same message to avoid existence disclosure.
- injectSessionContext: Client-supplied internal fields (`_keyId` / `_permissions`, etc.) are stripped and re-injected from the server-side authentication result, so session context cannot be forged.
- Admin rate limit: IP-based rate limits apply to `/auth`, `/keys` POST, and `/import` POST.
- OpenAPI: `GET /openapi.json` endpoint (`ENABLE_OPENAPI=true`). The master key receives the full spec; an API key receives a permissions-filtered spec.
- Key state recheck: an MCP session opened with an API key rereads the key state on use at the `MEMENTO_SESSION_KEY_RECHECK_MS` interval (default 30000 ms, 0 disables). The session of an inactive or deleted key is closed and receives 404 `Session not found`; permission changes apply to open sessions.
- Tool argument validation: `MEMENTO_TOOL_ARGS_VALIDATION` (`off`, `warn`, `enforce`, default `warn`) checks call arguments against the `tools/list` inputSchema. `warn` only logs a warning; `enforce` rejects violations with -32602.
- Session ID: `MEMENTO_SESSION_ID_POLICY` (`warn`, `enforce`, default `warn`) governs query-string session IDs and recovery of IDs that are not in the server-issued format (UUID). `enforce` answers 400 for a query-string ID and 404 for recovery of a non-UUID ID.
- Reserved agent IDs: `MEMENTO_RESERVED_AGENT_IDS` (`warn`, `enforce`, default `warn`) sets the handling of the internal agent IDs (`system`, `admin`) in API-key requests. `enforce` rejects them with FORBIDDEN (-32001); the master key is allowed.
- Audit records: tool-call audit records carry the actor (`key=`, `sid=` first 8 characters, `ip=`), and admin API mutating requests (anything but GET) plus admin authentication successes and failures are recorded as `admin_auth` and `admin <METHOD> <path>`. With `MEMENTO_ADMIN_AUTH_BACKOFF=on`, after 5 consecutive failed admin authentications the next attempt is delayed up to 60 seconds, and during the delay even the correct key receives 429 (`Retry-After`) (default `off`).
- Common response headers: every response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; `MEMENTO_FRAME_OPTIONS=deny` adds `X-Frame-Options: DENY`. HSTS belongs to the TLS-terminating reverse proxy.

## Symbolic Verification Layer

Optional explainability, advisory link integrity, polarity conflict detection, and policy-rule soft gating. 8 core modules plus 2 rule files. All flags are off by default.

## Smart Recall

- ProactiveRecall: Automatically links similar fragments based on keyword overlap during `remember()`.
- CaseRewardBackprop: Automatically back-propagates importance to evidence fragments on case verification events.
- SearchParamAdaptor: Automatically optimizes search thresholds based on usage patterns.
- CBR (Case-Based Reasoning): `recall(caseMode=true)` retrieves goal → events → outcome flows from similar cases, enabling reuse of past resolution patterns.
- depth filter: Controls recall depth per Planner/Executor role (`"high-level"` / `"detail"` / `"tool-level"`).
- recall response `key_id`: Each returned fragment carries the owning tenant's identifier.
- Reconsolidation: `tool_feedback` signals update `fragment_links` weight/confidence in real time (`ENABLE_RECONSOLIDATION=true`).
- Spreading Activation: Passing `recall(contextText=...)` pre-activates `ema_activation` for contextually related fragments based on conversation context (`ENABLE_SPREADING_ACTIVATION=true`).

`fragments.id` uses the `frag-{16-char hex}` text format. It is not a UUID — take care when generating or parsing IDs externally.

The `/metrics` endpoint exposes Prometheus-compatible metrics (master-key authentication is required when `MEMENTO_ACCESS_KEY` is set). Collection and visualization are left to the operator. Scrape jobs and alert rules for a shared Prometheus instance are in [docs/operations/monitoring.md](docs/operations/monitoring.md).

## Memory vs Rules

Memory fragments injected by AnchorMind have lower priority than the system prompt. Factual memories like "we use PostgreSQL 15" work well, but behavioral rules like "always use Given-When-Then pattern in tests" may be ignored when they conflict with the system prompt.

For behavioral rules, use higher-priority channels such as CLAUDE.md, AGENTS.md, hooks, or skills.

## Benchmark

Performance on [LongMemEval-S](https://arxiv.org/abs/2410.10813) (500 questions, measured 2026-03-29, reader and judge Gemini 2.5 Flash):

| Metric | Score | Condition |
|-|-|-|
| Retrieval recall_any@5 | 88.3% | text-embedding-3-small, 99% of queries served by the pgvector layer |
| QA accuracy | 44.9% | with temporal metadata and abstention detection (base condition 40.4%) |
| Data load | 89,006 / 27s | DB bulk INSERT only. Embedding backfill (~15 min) and retrieval of 500 questions (2 min) are separate |

Retrieval exceeds 80% recall on 5 of 6 question types. However, a significant gap exists between retrieval recall (88.3%) and QA accuracy (44.9%). This reflects reader-stage limitations in synthesizing answers from retrieved fragments, particularly for multi-session and temporal reasoning questions. The retrieval table in the LongMemEval paper uses LongMemEval_M (about 500 sessions per question), so it is not directly comparable with these numbers.

See [Benchmark Report](docs/benchmark.en.md) for the full analysis.

## Usage Patterns

AnchorMind is optimized for fact caching. When narrative context matters:

- Use the `episode` type to store narratives that preserve "why" behind decisions
- Add `contextSummary` when storing facts to get context alongside recall results
- A dual-memory setup works well: fact retrieval via AnchorMind, context restoration via your main memory system (e.g., MEMORY.md)

## Who Is This For

- Developers who use AI agents (Claude Code / Cursor / Windsurf) daily
- Anyone tired of repeating the same explanations every session
- Anyone who wants their AI to remember project context

## Learn More

| Document | Contents |
|----------|----------|
| [Quick Start](docs/getting-started/quickstart.md) | Detailed installation guide |
| [Architecture](docs/architecture.en.md) | System design, DB schema, 3-tier search, TTL |
| [Configuration](docs/configuration.en.md) | Environment variables, MEMORY_CONFIG, embedding providers |
| [API Reference](docs/api-reference.en.md) | HTTP endpoints, prompts, resources |
| [CLI](docs/cli.en.md) | Terminal commands |
| [API and Export Version Policy](docs/api-versioning.en.md) | Compatibility rules for the protocol, tool schemas, admin API, schema and export format |
| [Internals](docs/internals.en.md) | Evaluator, consolidator, contradiction detection |
| [Benchmark](docs/benchmark.en.md) | Full LongMemEval-S benchmark analysis |
| [Features](docs/features.md) | Module ledger, experimental flags, ENV mapping (Korean) |
| [SKILL.md](SKILL.md) | Full MCP tool reference |
| [INSTALL.md](docs/INSTALL.en.md) | Migrations, hook setup, detailed installation |
| [CHANGELOG](CHANGELOG.md) | Version history |

## Operations

- `/health`: Comprehensive check of DB, Redis, pgvector, and worker status. Returns degraded on partial failure. Unauthenticated requests receive the status only.
- `/health/live`: checks only that the event loop is alive; always 200. `/health/ready`: 200 when the primary DB answers within `MEMENTO_HEALTH_READY_DB_TIMEOUT_MS` (default 2000), otherwise 503 with reason `db_timeout` or `db_error`.
- Watchdog: `memento-watchdog.sh` restarts the service only when `/health/live` does not respond, spaces consecutive restarts exponentially, and prevents duplicate runs with a lock.
- Rate Limiting: 100/min per API key, 30/min per IP. Configurable via environment variables. The IP limit is one bucket shared by `initialize`, `GET /sse`, `/token`, `/register`, and `/authorize`; above it the server answers 429 with `Retry-After`.
- Worker Recovery: Embedding/evaluator workers use exponential backoff (1s→60s) on errors.
- Graceful Shutdown: On SIGTERM, waits up to 30s for workers to drain, then runs session auto-reflect. The whole shutdown is bounded by `MEMENTO_SHUTDOWN_DEADLINE_MS` (default 60000, 0 means no bound); exceeding it forces exit with code 1.
- OAuth Endpoints: On authentication failure, a `WWW-Authenticate` header is returned so OAuth clients can automatically initiate the auth flow. Session TTL defaults to 43200 minutes (30 days) and is set with `SESSION_TTL_MINUTES`.
- Migration lint: `npm run lint:migrations` checks numbering conflicts and convention violations before commit.
- Backup and restore drill: `scripts/ops/backup.sh` (`pg_dump` of the agent_memory schema, 14 days kept by default) and `scripts/ops/restore-verify.mjs` (restores into a disposable test server and compares with the manifest). Procedures are in [docs/operations/backup-restore.md](docs/operations/backup-restore.md) (Korean).
- Large table indexes: `scripts/ops/online-index.mjs` builds the indexes of the work list without blocking writes (`--dry-run`, `--confirm`). Procedures are in [docs/operations/online-migration.md](docs/operations/online-migration.md) (Korean).
- Switch report: `npm run switches` prints the applied value, default and state of every feature switch as a table; `--strict` exits with code 1 when a switch has an invalid value.
- Operations guides: [docs/operations/](docs/operations/) covers the LLM provider chain, symbolic hard gate, agent worktree, upstream porting and more.
- External access check: follow the "외부 노출 점검" procedure in `docs/operations/maintenance.md` to verify the listen address, access key, and Origin allowlist state.

## Known Limitations

- The L1 Redis index is keyed per API key, but Hot Cache and Working Memory hydration re-validate the effective agent scope. Legacy cache entries without agent metadata are excluded (fail-closed).
- Automatic quality evaluation targets decision, preference, and relation types only. fact, procedure, and error types are excluded from the evaluation queue.
- The server refuses to start when MEMENTO_ACCESS_KEY is not set. To run without authentication you must also set MEMENTO_AUTH_DISABLED=true.
- ALLOWED_ORIGINS: Whitelist for browser-based MCP clients. When unset, requests from every Origin are accepted and the cross-origin response header follows `MEMENTO_CORS_MODE` (default `observe`: echoes the request Origin and logs each newly seen Origin once; `reflect`; `allowlist`: only `OAUTH_TRUSTED_ORIGINS`). When set, requests with an Origin outside the list end with 403. On externally reachable deployments register only the browser Origins you actually use, and add `MCP_STRICT_ORIGIN=true` to narrow `/mcp` to trusted domains.
  Desktop/CLI/IDE clients (Claude Code, Cursor, Windsurf, Continue, Cline, Zed, gemini CLI, etc.)
  do not send Origin headers and need no whitelist entry.
  Browser candidates: claude.ai, claude.com, chatgpt.com, chat.openai.com, copilot.microsoft.com,
  gemini.google.com, aistudio.google.com, www.perplexity.ai, cursor.com, codeium.com,
  windsurf.com, sourcegraph.com, typingmind.com (enable only the clients you actually use).
- ADMIN_ALLOWED_ORIGINS: Whitelist for Admin UI origins. When unset, every Origin is accepted. On externally reachable deployments list the admin console Origin explicitly or restrict access at the reverse proxy or firewall.
- TRUST_PROXY_HOPS — Trusted reverse-proxy hop count. When unset, retains legacy behavior
  (first XFF entry). Set 0 for direct exposure, 1 behind a single proxy.
- OAUTH_TRUSTED_ORIGINS — Whitelist of origins for automatic consent. When hosting multiple apps
  on the same origin, prefer OAUTH_ALLOWED_REDIRECT_URIS for full URI matching.
- MEMENTO_SSE_QUERY_KEY: Legacy SSE `?accessKey=` handling. Default `allow` accepts it for the master key only; `deny` rejects it with 401 pointing to the `Authorization` header.
- MEMENTO_OAUTH_REDIRECT_CHECK: Redirect target check for `/authorize` error responses. Default `warn` still redirects to an unregistered `redirect_uri` and logs a warning; `enforce` answers with 400 JSON.
- MEMENTO_FRAME_OPTIONS: Adds `X-Frame-Options: DENY` only when set to `deny`.
- MEMENTO_WORKSPACE_READ_AUTHZ: Check of reads outside an API key's `allowed_workspaces` (recall, context and the other read tools, resources/read) and of master-only preset requests from non-master sessions. Default `warn` processes them and records `memento_workspace_read_authz_total` and a warning log; `enforce` rejects with `-32001`. Review the per-key records from the warn period before switching to `enforce`.

## Tech Stack

- Node.js 20+
- PostgreSQL 14+ (pgvector extension)
- Redis 6+ (optional)
- OpenAI Embedding API (optional) or `EMBEDDING_PROVIDER=transformers` (local zero-cost mode)
- garu-ko / natural PorterStemmer / @node-rs/jieba / kuromoji (local morpheme analysis, per-language CPU routing; default `MEMENTO_MORPHEME_TOKENIZER=local`)
- 18 LLM providers (CLI: gemini-cli, agy-cli, codex-cli, copilot-cli, qwen-cli, opencode-cli / HTTP: openai, anthropic, gemini, groq, openrouter, xai, ollama, vllm, deepseek, mistral, cohere, zai), optional, used for quality evaluation and auto-reflect; chain-configurable via LLM_PRIMARY / LLM_FALLBACKS (default `gemini-cli`)
- @huggingface/transformers + ONNX Runtime (NLI contradiction classification + local embeddings, CPU-only)
- MCP Protocol 2025-11-25

With PostgreSQL alone, storage, recall by matching the stored keywords array, links and admin features work. Natural-language `text` recall returns results only when embeddings are configured. Adding Redis enables L1 cascade search and SessionActivityTracker. Adding the OpenAI API or setting `EMBEDDING_PROVIDER=transformers` enables L3 semantic search and automatic linking.

## Why I Built This

<details>
<summary>Expand</summary>

Working with AI in production, I kept wasting time re-explaining the same context every single day. I tried embedding notes in system prompts, but the limitations were obvious. As fragments piled up, management fell apart -- search stopped working, and old information clashed with new.

The biggest problem was the endless repetition. Having to re-state things I had already explained, re-confirm settings that were already in place. I would painstakingly correct the AI, get it working perfectly -- only to start a new session and face the exact same issues all over again. It felt like being the training supervisor for a brilliant new hire who graduated top of their class but has their memory wiped clean every morning.

"Do you remember Mijeong?" -- without a cue, nothing comes to mind. But say "your desk mate from first grade" and suddenly you remember her lending you an eraser. AI works the same way. The bug you fixed yesterday, the decision you made last week, your preferred coding style. Instead of resetting every session, AnchorMind remembers for you.

To solve this pain, I designed a system that decomposes memories into atomic units, searches them hierarchically, and lets them decay naturally over time. Just as humans are creatures of forgetting, this system embraces "appropriate forgetting" as a feature.

And it does not stop there. As feedback accumulates, connections grow stronger and weak links fade. As patterns repeat, they abstract into higher-order knowledge. As episodes chain across sessions, context becomes narrative. The goal was never to build a library. It was to build an AI that grows from experience.

---

Memory is not the prerequisite of intelligence. Memory is the condition for it. Even if you know how to play chess, failing to remember yesterday's lost game means repeating the same moves. Even if you speak every language, failing to remember yesterday's conversation means meeting a stranger every time. Even with billions of parameters holding all the world's knowledge, failing to remember yesterday with you makes the AI nothing more than an unfamiliar polymath.

Memory is what enables relationships. Relationships are what enable trust.

Memories do not disappear. They simply drop to the cold tier. And cold fragments left neglected long enough are purged in the next consolidate cycle. This is by design, not a bug. Useless memories must make room. Even the palace of Augustine needs its storeroom tidied.

Even a goldfish -- famously considered brainless -- can remember things for months.

Now your AI can too.

</details>

## License

Apache 2.0

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
