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
| `context` | Automatically restores key context at session start |
| Auto-cleanup | Duplicate merging, contradiction detection, importance decay, TTL-based forgetting |
| Storage adapter layer | `lib/storage/` holds the storage abstraction. The `getStorage()` factory returns `PgVectorStore` (default) or `SqliteVecStore` (stub, not yet implemented) based on the `MEMENTO_STORAGE` environment variable. |
| **Link Reconsolidation** | `tool_feedback` signals update fragment_links weight/confidence in real time (ReconsolidationEngine). Contradicting links are automatically quarantined. |
| **Spreading Activation** | Passing `contextText` to `recall` pre-boosts activation_score for contextually related fragments, surfacing more relevant results (SpreadingActivation). |
| **Episode Continuity** | After `reflect`, `preceded_by` edges are automatically created between episode fragments to preserve the flow of experience as a graph (EpisodeContinuityService). |
| Admin Console | Memory explorer, knowledge graph, statistics dashboard, API key group/status filters, inline daily-limit editing |
| OAuth Integration | RFC 7591 Dynamic Client Registration, Claude.ai Web and ChatGPT integration support. The access token binds to a stable session ID through a keyId-namespaced Redis reverse index, so a reconnecting client keeps its existing session instead of starting a new one. |
| **Workspace isolation** | Partitions memories by project, role, or client within the same API key. Auto-tags via `api_keys.default_workspace`, auto-filters on recall. |
| **Batch processing** | `batch_remember` persists fragments through a single multi-row INSERT (256KB or 500-row chunks) and offloads embedding and post-processing to a non-blocking async worker (BatchRememberWorker). With `async: true`, the worker guarantees at-least-once delivery via ack, retry (up to 3), dead-letter, and startup recovery (RPOPLPUSH reliable queue). Use `batch_status(jobId)` to query job state (queued/processing/completed/dead). Always returns a standard single JSON-RPC response (`stream` deprecated). `reflect` delegates its 5 categories through a single batch call. EmbeddingWorker processes queued batches via generateBatchEmbeddings and a multi-row UPDATE. |
| Consistency Gate | The `fragments.morpheme_indexed` column tracks whether morpheme indexing has completed. Fragments not yet indexed are automatically excluded from the L3 morpheme search path. |
| Mode preset | `recall-only` / `write-only` / `onboarding` / `audit` JSON presets. The `X-Memento-Mode` header or `api_keys.default_mode` restricts which tools are exposed. |
| Affective tagging | `fragments.affect` column (neutral / frustration / confidence / surprise / doubt / satisfaction). Filter remember / recall results by emotional label. |
| Recall suggestions | `recall` responses carry a `_meta.suggestion` field that flags repeat queries, empty results with no context, oversized limits with no budget, and noisy untyped queries — a non-invasive hint clients are free to ignore. |
| Local embedding | `EMBEDDING_PROVIDER=transformers` runs `@huggingface/transformers` pipeline-based embeddings without an external API call (`Xenova/multilingual-e5-small`, 384d by default). |
| Migration lint | `npm run lint:migrations` checks new migration files for numbering conflicts and convention violations before commit. |

See [SKILL.md](SKILL.md) for the full list of MCP tools.

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

`--format table|json|csv` selects the output format; all 14 subcommands support `--help` / `-h`. See [docs/cli.md](docs/cli.md) for the full flag reference.

## API Response Meta

`recall` / `context` responses include a `_meta: { searchEventId, hints, suggestion, serverTime }` field. `serverTime` exposes the server's current time on every response to counter LLM clients anchoring to their training cutoff.

```json
{
  "fragments": [...],
  "_meta": {
    "searchEventId": "evt-abc123",
    "hints": { "signal": "consider_context" },
    "suggestion": { "code": "large_limit_no_budget", "message": "..." },
    "serverTime": {
      "iso"        : "2026-05-15T06:32:11.000Z",
      "epoch_ms"   : 1747291931000,
      "display_kst": "2026년 5월 15일 (목) 15:32",
      "timezone"   : "Asia/Seoul"
    }
  }
}
```

`remember` / `link` / `forget` / `amend` accept a `dryRun: true` parameter that returns the expected result with no side effects. All responses carry `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Resource` headers, omitted for the master key or when limit is null. `recall` accepts a `fields` array that restricts the returned fields to a whitelist of 17. `remember` / `batchRemember` accept an `idempotencyKey` parameter (max 128 chars) that prevents duplicate storage within the same key_id scope. `content` on `remember`, `batchRemember` items, and `amend` is rejected with a JSON-RPC -32602 error once it exceeds 4000 characters — a reception-side gate ahead of the per-type storage truncation (1000/300 chars) described above; `batchRemember` fails only the offending item and continues processing the rest of the batch.

## Security

- RBAC default-deny: Any tool name absent from the `TOOL_PERMISSIONS` map is rejected immediately regardless of permissions.
- Tenant isolation: forget / amend / link / fragment_history enforce SQL-level `key_id` conditions that prevent cross-tenant fragment access. "Not found" and "not authorized" return the same message to avoid existence disclosure.
- injectSessionContext: Client-supplied internal fields (`_keyId` / `_permissions`, etc.) are stripped and re-injected from the server-side authentication result, so session context cannot be forged.
- Admin rate limit: IP-based rate limits apply to `/auth`, `/keys` POST, and `/import` POST.
- OpenAPI: `GET /openapi.json` endpoint (`ENABLE_OPENAPI=true`). The master key receives the full spec; an API key receives a permissions-filtered spec.

## Symbolic Verification Layer

Optional explainability, advisory link integrity, polarity conflict detection, and policy-rule soft gating. 9 core modules plus 5 rule files. All flags are off by default.

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

The `/metrics` endpoint exposes Prometheus-compatible metrics. Collection and visualization are left to the operator.

## Memory vs Rules

Memory fragments injected by AnchorMind have lower priority than the system prompt. Factual memories like "we use PostgreSQL 15" work well, but behavioral rules like "always use Given-When-Then pattern in tests" may be ignored when they conflict with the system prompt.

For behavioral rules, use higher-priority channels such as CLAUDE.md, AGENTS.md, hooks, or skills.

## Benchmark

Performance on [LongMemEval-S](https://arxiv.org/abs/2407.15460) (500 questions):

| Metric | Score | Comparison |
|--------|-------|------------|
| Retrieval recall@5 | 88.3% | +8-18pp vs Stella 1.5B (LongMemEval paper) |
| QA accuracy | 45.4% | with temporal metadata (baseline 40.4%) |
| Fragment throughput | 89,006 / 27s | full ingestion-embedding-retrieval pipeline |

Retrieval exceeds 80% recall on 5 of 6 question types. However, a significant gap exists between retrieval recall (88.3%) and QA accuracy (45.4%). This reflects reader-stage limitations in synthesizing answers from retrieved fragments, particularly for multi-session and temporal reasoning questions.

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
| [CLI](docs/cli.en.md) | 9 terminal commands |
| [Internals](docs/internals.en.md) | Evaluator, consolidator, contradiction detection |
| [Benchmark](docs/benchmark.en.md) | Full LongMemEval-S benchmark analysis |
| [SKILL.md](SKILL.md) | Full MCP tool reference |
| [INSTALL.md](docs/INSTALL.en.md) | Migrations, hook setup, detailed installation |
| [CHANGELOG](CHANGELOG.md) | Version history |

## Operations

- `/health`: Comprehensive check of DB, Redis, pgvector, and worker status. Returns degraded on partial failure.
- Rate Limiting: 100/min per API key, 30/min per IP. Configurable via environment variables.
- Worker Recovery: Embedding/evaluator workers use exponential backoff (1s→60s) on errors.
- Graceful Shutdown: On SIGTERM, waits up to 30s for workers to drain, then runs session auto-reflect.
- OAuth Endpoints: On authentication failure, a `WWW-Authenticate` header is returned so OAuth clients can automatically initiate the auth flow. Session TTL defaults to 240 minutes.

## Known Limitations

- L1 Redis cache supports API key-based isolation only. Agent-level isolation in multi-agent deployments is enforced at L2/L3.
- Automatic quality evaluation targets decision, preference, and relation types only. fact, procedure, and error types are excluded from the evaluation queue.
- Authentication is disabled when MEMENTO_ACCESS_KEY is not set. Always configure it for externally exposed deployments.
- ALLOWED_ORIGINS — Whitelist for browser-based MCP clients. When unset, only same-origin requests pass.
  Desktop/CLI/IDE clients (Claude Code, Cursor, Windsurf, Continue, Cline, Zed, gemini CLI, etc.)
  do not send Origin headers and need no whitelist entry.
  Browser candidates: claude.ai, claude.com, chatgpt.com, chat.openai.com, copilot.microsoft.com,
  gemini.google.com, aistudio.google.com, www.perplexity.ai, cursor.com, codeium.com,
  windsurf.com, sourcegraph.com, typingmind.com (enable only the clients you actually use).
- ADMIN_ALLOWED_ORIGINS — Whitelist for Admin UI origins. When unset, only same-origin requests pass.
- TRUST_PROXY_HOPS — Trusted reverse-proxy hop count. When unset, retains legacy behavior
  (first XFF entry). Set 0 for direct exposure, 1 behind a single proxy.
- OAUTH_TRUSTED_ORIGINS — Whitelist of origins for automatic consent. When hosting multiple apps
  on the same origin, prefer OAUTH_ALLOWED_REDIRECT_URIS for full URI matching.

## Tech Stack

- Node.js 20+
- PostgreSQL 14+ (pgvector extension)
- Redis 6+ (optional)
- OpenAI Embedding API (optional) or `EMBEDDING_PROVIDER=transformers` (local zero-cost mode)
- garu-ko / natural PorterStemmer / @node-rs/jieba / kuromoji (local morpheme analysis, per-language CPU routing; default `MEMENTO_MORPHEME_TOKENIZER=local`)
- Gemini CLI / Codex CLI / GitHub Copilot CLI (quality evaluation, auto-reflect; optional, chain-configurable via LLM_PRIMARY / LLM_FALLBACKS)
- @huggingface/transformers + ONNX Runtime (NLI contradiction classification + local embeddings, CPU-only)
- MCP Protocol 2025-11-25

The core features work with PostgreSQL alone. Adding Redis enables L1 cascade search and SessionActivityTracker. Adding the OpenAI API or setting `EMBEDDING_PROVIDER=transformers` enables L3 semantic search and automatic linking.

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
