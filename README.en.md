<p align="center">
  <img src="assets/images/memento_mcp_logo_transparent.png" width="400" alt="Memento MCP Logo">
</p>

<p align="center">
  <a href="https://github.com/JinHo-von-Choi/memento-mcp/releases">
    <img src="https://img.shields.io/github/v/release/JinHo-von-Choi/memento-mcp?style=flat&label=release&color=4c8bf5" alt="GitHub Release" />
  </a>
  <a href="https://github.com/JinHo-von-Choi/memento-mcp/stargazers">
    <img src="https://img.shields.io/github/stars/JinHo-von-Choi/memento-mcp?style=flat&color=f5c542" alt="GitHub Stars" />
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

# Memento MCP

> Give your AI a memory. Then let it use that memory as a foundation to grow.

Imagine a new employee whose memory resets every morning. Everything you taught yesterday, every problem you solved together last week, every preference -- all forgotten. Memento MCP gives this new hire a memory.

Memento MCP is a long-term memory server for AI agents, built on MCP (Model Context Protocol). It persists important facts, decisions, error patterns, and procedures across sessions and restores them in the next.

This is not a library of memories. As feedback accumulates, connections strengthen. As experiences repeat, patterns abstract. As sessions continue, context becomes narrative. The goal is not an AI that remembers — it is an AI that grows from experience.

> [!TIP]
> If installing and configuring the server yourself feels daunting, hand a single sentence to an AI assistant (Claude Code, Cursor, Codex):
>
> > "Install the memento-mcp repository in my environment, read `docs/INSTALL.en.md` and `SKILL.md`, apply the recommended settings, then verify it works."
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

### Supported Environments

| Environment | Recommendation | Getting Started |
|-------------|----------------|-----------------|
| Linux / macOS | Recommended | [Quick Start](docs/getting-started/quickstart.md) |
| Windows + WSL2 | Most recommended | [Windows WSL2 Setup](docs/getting-started/windows-wsl2.md) |
| Windows + PowerShell | Limited support | [Windows PowerShell Setup](docs/getting-started/windows-powershell.md) |

## Compatible Platforms

Memento is a standard MCP (Model Context Protocol) server. It works with any AI platform that supports MCP — not just Claude Code.

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

For Claude.ai Web and ChatGPT, Memento uses OAuth. Enter your API key (`mmcp_xxx`) as the `client_id` -- no Dynamic Client Registration (RFC 7591) flow required. Redirect URIs from trusted domains (claude.ai, chatgpt.com) are auto-approved.

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
| `remember` | Decomposes important information into atomic fragments and stores them |
| `recall` | Returns relevant memories via keyword + semantic 3-tier search |
| `context` | Automatically restores key context at session start |
| Auto-cleanup | Duplicate merging, contradiction detection, importance decay, TTL-based forgetting |
| **Link Reconsolidation** | `tool_feedback` signals update fragment_links weight/confidence in real time (ReconsolidationEngine). Contradicting links are automatically quarantined. |
| **Spreading Activation** | Passing `contextText` to `recall` pre-boosts activation_score for contextually related fragments, surfacing more relevant results (SpreadingActivation). |
| **Episode Continuity** | After `reflect`, `preceded_by` edges are automatically created between episode fragments to preserve the flow of experience as a graph (EpisodeContinuityService). |
| Admin Console | Memory explorer, knowledge graph, statistics dashboard, API key group/status filters, inline daily-limit editing |
| OAuth Integration | RFC 7591 Dynamic Client Registration, Claude.ai Web and ChatGPT integration support |
| **Workspace isolation** | Partition memories by project, role, or client within the same API key. Auto-tag via `api_keys.default_workspace`, auto-filter on recall. |

### What's New in v3.0.0 — CLI/API Enhancement Phase 2 (folded from v2.12.0)

Remote CLI, X-RateLimit headers, dryRun, _meta wrapper, sparse fields, and idempotency.

- Remote CLI: `--remote URL --key KEY` global flags let you operate a remote Memento server without a local instance. `MEMENTO_CLI_REMOTE` / `MEMENTO_CLI_KEY` environment variables are also supported.
- X-RateLimit headers: All API responses include `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Resource` headers. Headers are omitted for master key or when limit is null. A 10-second module-level TTL cache minimizes DB lookups.
- dryRun parameter: remember / link / forget / amend now accept `dryRun: true`. Returns the simulated result without any DB side effects. Defaults to false.

CLI examples:

```bash
# Remote recall via environment variable
MEMENTO_CLI_REMOTE=https://memento.anchormind.net/mcp MEMENTO_CLI_KEY=mmcp_xxx memento-mcp recall "query"

# Remote recall via flags
memento-mcp recall "query" --remote https://memento.anchormind.net/mcp --key mmcp_xxx

# Table output, limit 5
memento-mcp recall "query" --format table --limit 5

# Prevent duplicate storage with idempotency key
memento-mcp remember "content" --topic project --idempotency-key k1
```

### What's New in v3.0.0 — CLI/API Enhancement Phase 1 (folded from v2.11.0)

H group: _meta wrapper, sparse fields, CLI improvements, and idempotency.

- _meta wrapper: recall / context responses now include a `_meta: { searchEventId, hints, suggestion }` field. The existing top-level `_searchEventId` / `_memento_hint` / `_suggestion` fields are deprecated and will be removed in v3.1.0. Use `_meta.*` instead.
- sparse fields: Pass a `fields` array to recall to restrict the returned fields. Whitelist of 17: id / content / type / topic / keywords / importance / created_at / access_count / confidence / linked / explanations / workspace / context_summary / case_id / valid_to / affect / ema_activation.
- CLI `--format`: `--format table|json|csv` flag controls output format. Defaults to table in TTY environments and json when piped. `--json` is an alias for `--format json`.
- CLI `--help`: All 14 subcommands support `--help` / `-h`.
- idempotencyKey: remember / batchRemember accept an `idempotencyKey` parameter (max 128 chars) to prevent duplicate storage within the same key_id scope. migration-034-v2.16.0-bundle adds the `fragments.idempotency_key` column.

### What's New in v3.0.0 — Admin Metrics Dashboard (folded from v2.16.0)

- Admin Console metrics tab: 8 Prometheus cards (Active Sessions / Auth Denied / RBAC Denied / Tenant Blocked / RPC p50/p99 / Tool Errors / Symbolic Gate Blocked / OAuth Tokens) + per-tool call statistics table + error type distribution table. Left sidebar expands from 7 to 8 menus.
- `/v1/internal/model/nothing/metrics-summary` endpoint (master/admin only): derived directly from the prom-client Registry, 10-second response cache TTL, `?windowSec=N` supported.
- Phase 2: timeseries ring buffer + SVG sparkline rendered by browser-native ESM with no external chart library.
- Test cleanup hang resolved at the root: removed the 14-second residual "Promise resolution pending" from node:test runner (SSE heartbeat `.unref()`, lifecycle regression guards).

_meta structure example:

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

`serverTime`: Server time of the response, mitigating LLM clients' training-time fixation. Included consistently in all recall/context responses. Four fields: `iso` (UTC ISO 8601), `epoch_ms` (Unix ms), `display_kst` (Asia/Seoul formatted), `timezone`.

Deprecation notice: v3.0.0 mirrors the top-level `_searchEventId` / `_memento_hint` / `_suggestion` fields to `_meta.*`. The top-level fields will be removed in v3.1.0. Migrate to `_meta.searchEventId` / `_meta.hints` / `_meta.suggestion`.

### What's New in v3.0.0 — MemoryManager decomposition (folded from v2.10.0)

Phase 5-B internal decomposition. No changes to the public API.

- MemoryManager reduced from 1252 to 259 lines as a facade. Business logic was moved into 4 classes under `lib/memory/processors/`:
  - MemoryRememberer: remember / batchRemember
  - MemoryRecaller: recall / context
  - MemoryReflector: reflect
  - MemoryLinker: link / graph_explore
- Shared property synchronization: facade and processors sync shared setters via the `_installSharedSync` pattern.

### What's New in v3.0.0 — Mode preset / Affect / Local Embedding (folded from v2.9.0)

- **Mode presets**: Four JSON presets — recall-only, write-only, onboarding, audit. Activate via `X-Memento-Mode` header or `api_keys.default_mode` DB column to constrain which tools are exposed per session. Enables role-based access control without any code changes.
- **RecallSuggestionEngine**: Non-invasive `_suggestion` meta field appended to recall responses. Detects four patterns — repeat queries, empty results with no context, oversized limit with no budget, and noisy untyped queries — and surfaces improvement hints. Clients that ignore the field see no behavior change.
- **Affective tagging**: `fragments.affect` column with six enums: neutral, frustration, confidence, surprise, doubt, satisfaction. Expose the `affect` parameter in remember / recall to filter by emotional label. Useful for distinguishing recurring error patterns from high-confidence decisions.
- **CLI LLM provider chain**: Gemini CLI, Codex CLI, and GitHub Copilot CLI can now be specified in `LLM_PRIMARY` / `LLM_FALLBACKS`. Morpheme analysis, auto-reflect, and contradiction escalation run through local CLI binaries with no external API cost.
- **Local transformers.js embedding**: Set `EMBEDDING_PROVIDER=transformers` to use `@huggingface/transformers` pipeline-based embeddings without an OpenAI API key. Defaults to `Xenova/multilingual-e5-small` (384d). Suitable for fully local deployments.
- **Token-based session reuse**: Resolves the issue where the claude.ai connector created a new session on every initialize after losing Mcp-Session-Id. The same access token is now bound to an existing session ID via a sha256 hash + keyId-namespaced Redis reverse index, preventing fragment loss.

### Security Hardening (v2.7.0)

- **RBAC default-deny**: Any tool name not present in the `TOOL_PERMISSIONS` map is immediately rejected regardless of permissions.
- **Tenant isolation hardening**: forget/amend/link/fragment_history enforce SQL-level `key_id` conditions preventing cross-tenant fragment access. "Not found" and "not authorized" return the same message to prevent existence disclosure.
- **injectSessionContext**: Client-supplied internal fields (`_keyId`/`_permissions`, etc.) are stripped and re-injected from server-side authentication results. Session context forgery is impossible.
- **Admin rate limit**: IP-based rate limits applied to `/auth`, `/keys` POST, and `/import` POST endpoints.
- **OpenAPI**: `GET /openapi.json` endpoint added (`ENABLE_OPENAPI=true`). Master key receives the full spec; API keys receive a permissions-filtered spec.

### Symbolic Verification Layer (v2.8.0)

- **Symbolic Verification Layer (v2.8.0)**: Optional explainability, advisory link integrity, polarity conflict detection, policy rules soft gating. 9 core modules + 5 rule files. All flags off by default for full v2.7.0 backwards compatibility.

### Smart Recall (v2.7.0)
- **ProactiveRecall**: Automatically links similar fragments based on keyword overlap during remember()
- **CaseRewardBackprop**: Automatically back-propagates importance to evidence fragments on case verification events
- **SearchParamAdaptor**: Automatically optimizes search thresholds based on usage patterns
- **CBR (Case-Based Reasoning)**: `recall(caseMode=true)` retrieves goal->events->outcome flows from similar cases, enabling reuse of past resolution patterns
- **depth filter**: Controls recall depth per Planner/Executor role (`"high-level"` | `"detail"` | `"tool-level"`)
- **recall response key_id**: Each returned fragment includes a `key_id` field for tenant identification
- **Reconsolidation**: Real-time strengthening or weakening of fragment_links weight/confidence based on `tool_feedback` signals (`ENABLE_RECONSOLIDATION=true`)
- **Spreading Activation**: Passing `recall(contextText=...)` pre-boosts ema_activation for contextually related fragments based on conversation context (`ENABLE_SPREADING_ACTIVATION=true`)

See [SKILL.md](SKILL.md) for the full list of MCP tools.

## Memory vs Rules

Memory fragments injected by Memento have lower priority than the system prompt. Factual memories like "we use PostgreSQL 15" work well, but behavioral rules like "always use Given-When-Then pattern in tests" may be ignored when they conflict with the system prompt.

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

Memento is optimized for fact caching. When narrative context matters:

- Use the `episode` type to store narratives that preserve "why" behind decisions
- Add `contextSummary` when storing facts to get context alongside recall results
- A dual-memory setup works well: fact retrieval via Memento, context restoration via your main memory system (e.g., MEMORY.md)

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
| [CHANGELOG](CHANGELOG.md) | Version history, v3.0.0 umbrella release notes, and Pre-3.0.0 incremental build ledger |

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

"Do you remember Mijeong?" -- without a cue, nothing comes to mind. But say "your desk mate from first grade" and suddenly you remember her lending you an eraser. AI works the same way. The bug you fixed yesterday, the decision you made last week, your preferred coding style. Instead of resetting every session, Memento remembers for you.

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
