# Capabilities

Reference list of features, response metadata, optional modules and the tech stack. If you are new, start with the flow and FAQ in the [README](../README.en.md). Environment variables: [configuration.en.md](configuration.en.md). Module inputs and outputs: [features.md](features.md).

## Feature list

Names in parentheses are the environment variables that switch a feature on or off. Values and defaults are in [configuration.en.md](configuration.en.md).

### Putting memory in and taking it out

- `remember`: splits what matters into one- or two-sentence fragments and stores them. With `MEMENTO_REMEMBER_ATOMIC=true`, the quota check and the insert run in one transaction.
- `batch_remember`: stores many fragments at once. Called with `async: true`, the server processes them in the background and retries failures up to 3 times. Check progress with `batch_status(jobId)`.
- `recall`: searches in three steps (keyword, morpheme, meaning) and returns only what is needed. Scopes such as workspace, caseId and affect apply identically to all three steps.
- `context`: restores core memory in one call at session start. Called with `agentId=X` it returns X's memory plus shared memory; without it, shared memory only.
- `reflect`: saves a summary at session end. Episodes from consecutive sessions are linked with `preceded_by` automatically, so the flow of experience is kept.

### Making search accurate

- Spreading activation: pass `contextText` to `recall` to say what you are working on, and related fragments come first (`ENABLE_SPREADING_ACTIVATION`).
- Body lexical search: finds fragments by words in the text. It works with embeddings off, but needs the GIN index (`MEMENTO_LEXICAL_CHANNEL`).
- Selecting within the budget: candidates, including linked fragments, are scored first and then chosen within `tokenBudget` (`MEMENTO_RANK_BEFORE_BUDGET`).
- Answer pack: `recall(format: "pack")` returns quotable blocks with source and saved date. Lines injected by `context` also carry the saved date and verification status (`MEMENTO_CONTEXT_ANNOTATE`).
- Local embeddings: `EMBEDDING_PROVIDER=transformers` creates embeddings without an external API. The default model is `Xenova/multilingual-e5-small` (384 dimensions).
- Affect tags: tag fragments with `affect` (neutral, frustration, confidence, surprise, doubt, satisfaction) and filter searches by it.
- Search hints: `_meta.suggestion` in the `recall` response flags inefficient queries: repeated queries, empty results without context, a large `limit` without a budget, and noisy queries without a type. You can ignore it.

### Keeping memory tidy by itself

- Automatic cleanup: duplicate merging, contradiction detection, importance decay and TTL expiry run periodically. Expiry cleanup repeats in chunks of 100 per cycle (`MEMENTO_GC_THROUGHPUT`).
- Link adjustment: as `tool_feedback` accumulates, the weights of links between fragments change, and contradicting links are quarantined automatically (`ENABLE_RECONSOLIDATION`).
- Duplicate judgment: identical text counts as one within a key and workspace. If it already exists, the `remember` response carries the existing fragment id in `duplicate_of` (`MEMENTO_DEDUP_SCOPE`).
- Cascading delete: `forget` also deletes case summaries built from that fragment and body copies in contradiction-resolution records, in the same transaction (`MEMENTO_FORGET_CASCADE`).
- Morpheme index check: fragments whose morpheme indexing is unfinished are excluded from morpheme search automatically.

### Deciding who can see what

- Workspace isolation: separate memory per project or client even under one key. If no workspace is given, the key's `default_workspace` applies; with neither, only global memory is read. Reading everything (`allWorkspaces=true`) is master-key only.
- Mode presets: restrict the tools a key can use to one of `recall-only`, `write-only`, `onboarding` or `audit`. Set it with the `X-Memento-Mode` header or the key's `default_mode`.
- Anchor permission and read authorization: setting an anchor is limited by the `anchor` permission and a per-key cap (`MEMENTO_ANCHOR_PERMISSION`); the workspace a read targets is checked against the key's `allowed_workspaces` (`MEMENTO_WORKSPACE_READ_AUTHZ`).
- Admin permissions and admin accounts: every admin API route declares the capability it needs, judged by role (owner, admin, reviewer, auditor, viewer, service). Admins sign in with a password and TOTP (`MEMENTO_ADMIN_USERS`). `GET /me` shows your own capabilities and scope.
- API key lifetime: each key can have an expiry time, allowed address ranges, an owner and a kind. Rotation with an overlap period, revocation and access-review sign-off are done in the admin API and console.
- Provenance and trust tier: a fragment's `trust_tier` (0 to 3) comes from the `origin` claim in `remember` and the key's cap. Tier 1 or below is left out of ANCHOR and CORE injection, and `recall` responses carry the source (`MEMENTO_PROVENANCE`).
- Review queue: text that tries to override agent instructions, low-trust anchors, preferences and procedures, and anchor requests without permission are not rejected but stored for review. Approve or reject them through the admin API; undecided items are rejected automatically after 30 days (`MEMENTO_REVIEW_QUEUE`).

### Keeping storage safe

- Write gate: `remember`, `amend`, `batch_remember`, writes derived from reflect, import, and the CLI's local `remember` all pass the same checks: normalization, sensitive-data masking, per-type length limits, policy rules, workspace permission and anchor permission. Violations are reported in `validation_warnings` and rejected only for keys with `symbolic_hard_gate=true` (`MEMENTO_WRITE_GATE`, `MEMENTO_SENSITIVE_SCAN`).
- Audit hash chain: admin changes, admin authentication, memory writes, anchors, gate rejections, review decisions and external transmissions are recorded in a hash-linked table. Query and verify it through the admin API, the admin console, or `anchormind audit verify` (`MEMENTO_AUDIT_DB`).
- LLM egress policy: a per-key and per-workspace `egress_policy` restricts external LLM providers, masks outgoing text and records transmissions (`MEMENTO_EGRESS_POLICY`).
- Working memory without Redis: when Redis is not ready, `remember(scope=session)` is stored as a PostgreSQL row, and `working_memory` in the response tells you the storage path (`MEMENTO_WM_PG_FALLBACK`).
- Transactional outbox: events are recorded in the same transaction as the change, and a worker delivers them to per-topic handlers, with retry, dead-letter storage and retention cleanup (`MEMENTO_OUTBOX`).

### Integration and operations

- OAuth: Claude.ai Web and ChatGPT Web connect through RFC 7591 dynamic client registration. Reconnecting with the same token resumes the existing session instead of creating a new one.
- Hooks and plugins: `POST /hooks/{client}/{event}` and `anchormind hook` wire session-start injection and session-end retrospectives for Claude Code and Codex. `anchormind init --target claude|codex` builds the plugin (`MEMENTO_HOOK_ENDPOINTS`). Installation: [Plugin install](getting-started/plugins.en.md).
- Admin console: memory browsing, knowledge graph, statistics, API key groups and status filters, daily-limit editing.
- Export and import: export format version 2 JSONL with all fragment columns, links and revision history. Import writes through the same write gate to a chosen target key. Compatibility rules: [api-versioning.en.md](api-versioning.en.md).
- Migration lint: `npm run lint:migrations` catches number collisions and convention violations in new migration files before commit.

The full MCP tool list is in [SKILL.md](../SKILL.md).

## Usage patterns

AnchorMind is optimized for fact caching. When narrative context matters:

- Use the `episode` type to store narratives that preserve "why" behind decisions
- Add `contextSummary` when storing facts to get context alongside recall results
- A dual-memory setup works well: fact retrieval via AnchorMind, context restoration via your main memory system (e.g., MEMORY.md)

## API response meta

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

The `/metrics` endpoint exposes Prometheus-compatible metrics (master-key authentication is required when `MEMENTO_ACCESS_KEY` is set). Collection and visualization are left to the operator. Scrape jobs and alert rules for a shared Prometheus instance are in [docs/operations/monitoring.md](operations/monitoring.md).

## Tech stack

- Node.js 20+
- PostgreSQL 14+ (pgvector extension)
- Redis 6+ (optional)
- OpenAI Embedding API (optional) or `EMBEDDING_PROVIDER=transformers` (local zero-cost mode)
- garu-ko / natural PorterStemmer / @node-rs/jieba / kuromoji (local morpheme analysis, per-language CPU routing; default `MEMENTO_MORPHEME_TOKENIZER=local`)
- 18 LLM providers (CLI: gemini-cli, agy-cli, codex-cli, copilot-cli, qwen-cli, opencode-cli / HTTP: openai, anthropic, gemini, groq, openrouter, xai, ollama, vllm, deepseek, mistral, cohere, zai), optional, used for quality evaluation and auto-reflect; chain-configurable via LLM_PRIMARY / LLM_FALLBACKS (default `gemini-cli`)
- @huggingface/transformers + ONNX Runtime (NLI contradiction classification + local embeddings, CPU-only)
- MCP Protocol 2025-11-25

With PostgreSQL alone, storage, recall by matching the stored keywords array, links and admin features work. Natural-language `text` recall returns results only when embeddings are configured. Adding Redis enables L1 cascade search and SessionActivityTracker. Adding the OpenAI API or setting `EMBEDDING_PROVIDER=transformers` enables L3 semantic search and automatic linking.
