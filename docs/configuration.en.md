# Configuration

---

## Environment Variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 57332 | HTTP listen port |
| MEMENTO_ACCESS_KEY | (none) | Bearer authentication key. With it unset the server refuses to start and exits with code 78. To run without authentication you must also set `MEMENTO_AUTH_DISABLED=true` |
| MEMENTO_AUTH_DISABLED | false | When `true`, completely disables authentication and processes all requests with master privileges. Development/testing only. Only effective when `MEMENTO_ACCESS_KEY` is unset |
| SESSION_TTL_MINUTES | 43200 | Session TTL (minutes). Default 30 days. Sliding window: TTL resets on every tool call |
| LOG_DIR | ./logs | Winston log file directory |
| ALLOWED_ORIGINS | (none) | Allowed Origins list. Comma-separated. When unset, all Origins are allowed (MCP client compatibility takes precedence) |
| ADMIN_ALLOWED_ORIGINS | (none) | Admin console allowed Origins list. When unset, all Origins are allowed |
| ENABLE_OPENAPI | false | When `true`, enables the `GET /openapi.json` endpoint. Returns different specs based on authentication level (master key: all paths included, API key: permission-filtered tool list) |
| RATE_LIMIT_WINDOW_MS | 60000 | Rate limiting window size (ms) |
| RATE_LIMIT_MAX_REQUESTS | 120 | Max requests per IP per window |
| RATE_LIMIT_PER_IP | 30 | Per-IP requests per minute (unauthenticated) |
| RATE_LIMIT_PER_KEY | 100 | Per-API-key requests per minute (authenticated) |
| CONSOLIDATE_INTERVAL_MS | 21600000 | Auto-maintenance (consolidate) interval (ms). Default 6 hours |
| EVALUATOR_MAX_QUEUE | 100 | MemoryEvaluator queue size cap (older jobs dropped on overflow) |
| OAUTH_TRUSTED_ORIGINS | (none) | Additional OAuth redirect_uri trusted domains (comma-separated, origin level). Added on top of default trusted domains (claude.ai, chatgpt.com, platform.openai.com, copilot.microsoft.com, gemini.google.com). Only specify additional origins to allow |
| MCP_STRICT_ORIGIN | false | When `true`, enables strict Origin header validation (DNS rebinding defense). Requests from Origins not in the allowlist (`OAUTH_TRUSTED_ORIGINS` + `ALLOWED_ORIGINS` + default trusted domains) are rejected with 403. Requests without an Origin header (CLI/curl) are always allowed. **opt-in** — defaults to `false` to preserve existing behavior |
| MCP_REJECT_NONAPIKEY_OAUTH | true | Set to `false` to allow `is_api_key=false` OAuth tokens (backward compatibility). Default `true` — non-API-key OAuth tokens create a `keyId=null` session with master-level access to all fragments. API-key-based OAuth tokens (`is_api_key=true`) and Bearer ACCESS_KEY direct use are unaffected |
| MCP_ALLOW_AUTO_DCR_REGISTER | false | Set to `true` to allow auto-registration of unregistered `client_id` in `/authorize` (legacy behavior). Default `false` — enforces RFC 7591 `POST /register` endpoint for client registration |
| OAUTH_ALLOWED_REDIRECT_URIS | (none) | OAuth redirect_uri exact-match allowed list (comma-separated). Operates independently of OAUTH_TRUSTED_ORIGINS |
| DEFAULT_DAILY_LIMIT | 10000 | Default daily call limit when creating API keys |
| DEFAULT_PERMISSIONS | read,write | Default permissions when creating API keys |
| DEFAULT_FRAGMENT_LIMIT | (none) | Default fragment quota when creating API keys. Unlimited when unset |
| DEDUP_BATCH_SIZE | 100 | Semantic deduplication batch size |
| DEDUP_MIN_FRAGMENTS | 5 | Minimum fragment count for dedup. Deduplication is skipped below this threshold |
| COMPRESS_AGE_DAYS | 30 | Memory compression target inactive days |
| COMPRESS_MIN_GROUP | 3 | Minimum compression group size. Groups below this threshold are not compressed |
| MEMENTO_RERANKER_ENABLED | false | Enables the in-process cross-encoder reranker. It is off by default: the default model is English-only, and on a Korean corpus an ablation showed turning it off improves Recall@1 from 74% to 85%, MRR from 0.827 to 0.890, and p50 latency from 561ms to 126ms. External rerankers configured through `RERANKER_URL` work regardless of this switch |
| RERANKER_MODEL | minilm | ONNX model used when the in-process reranker is enabled. `minilm` (default, ~80MB, English-only) or `bge-m3` (~280MB, multilingual). bge-m3 ranks non-English text far better but takes several seconds to rerank 30 candidates on CPU, so use it only behind a GPU-backed external service |
| RERANKER_EXTERNAL_FALLBACK | skip | Policy applied after 3 consecutive external reranker failures. `skip` (default): no switch to in-process — external calls are simply skipped for `RERANKER_EXTERNAL_COOLDOWN_MS`, and original scores (RRF order) are returned as-is. `inprocess`: switches to the ONNX in-process model (opt-in, the previous behavior) |
| RERANKER_EXTERNAL_COOLDOWN_MS | 60000 | Cooldown duration (ms) when `RERANKER_EXTERNAL_FALLBACK=skip`. After the window expires, the next recall retries the external call once; success resumes normal operation, failure re-enters cooldown |
| QUOTA_NEAR_LIMIT_MARGIN | 10 | Remaining-quota threshold at which `QuotaChecker.check()` switches to the precise FOR UPDATE check. The transaction lock is only acquired when `remaining` is at or below this value; above it, the check passes using the 10-second TTL cache (getUsage) without locking |
| ENABLE_RECONSOLIDATION | false | Enable ReconsolidationEngine. When true, tool_feedback and contradicts detection dynamically update fragment_links weight/confidence |
| ENABLE_SPREADING_ACTIVATION | false | Enable SpreadingActivation. When true, the contextText parameter in recall proactively activates related fragments. Recommended to measure latency impact before enabling |
| ENABLE_PATTERN_ABSTRACTION | (unused) | Reserved for pattern abstraction. No code reads this variable, so setting it has no effect |
| MEMENTO_METRICS_DEFAULT | (none) | Set to `off` to skip prom-client default metrics (CPU, memory, …). Any other value keeps collection on |
| MEMENTO_ADMIN_METRICS_SAMPLING | (none) | Set to `off` to disable admin console metric sampling. Any other value keeps sampling on |
| UPDATE_CHECK_DISABLED | false | Set to `true` to skip new-version checks |
| UPDATE_CHECK_INTERVAL_HOURS | 24 | New-version check interval (hours) |
| MEMENTO_REMEMBER_ATOMIC | false | When true, atomizes the quota check + INSERT in remember() into a single transaction. Sequence: BEGIN → api_keys FOR UPDATE (quota re-validation) → INSERT → COMMIT, fully eliminating TOCTOU. false (default) performs only a pre-check and is appropriate for environments with low concurrent request volume |
| MEMENTO_CASE_BACKPROP_ENABLED | false | When true, enables CaseRewardBackprop, which back-propagates tool_feedback reward signals along case_id fragment chains. Adjust importance scores of cause fragments based on outcome quality |
| MEMENTO_STORAGE | pgvector | Storage adapter selection. `pgvector` (default, PostgreSQL + pgvector). Additional adapters can be registered in `lib/storage/`. Changing this value requires all fragments to be re-indexed in the target backend |
| MEMENTO_KEYWORD_SEMANTIC_FALLBACK | true | Set `false` to disable the L3 semantic supplement for keywords-only recall queries without text. When active, one embedding of the normalized keywords text runs in parallel with L2, recovering fragments whose stored keywords lack the query terms via content matching |
| MEMENTO_KEYWORD_FALLBACK_TIMEOUT_MS | 1500 | Upper bound (ms, clamped 100-60000) for the keyword-supplement L3 run. On timeout it resolves to an empty result and leaves `L3kw:timeout` in searchPath |
| MEMENTO_CONTEXT_ANCHOR_LIMIT | 10 | Maximum number of anchor (isAnchor) fragments always included in context responses. Clamped to 1-30; falls back to 10 on parse failure. Anchors are not trimmed by tokenBudget, so this count cap is the only injection limit |
| MEMENTO_RECALL_MIN_SIM_FLOOR | (unset) | Opt-in floor for the adaptive similarity threshold returned by `SearchParamAdaptor.getMinSimilarity`. Example: when set to `0.45`, the returned value is clamped to at least 0.45 even if the learned value is lower. Unset preserves the existing behavior |
| MEMENTO_MORPHEME_TOKENIZER | local | Morpheme tokenizer path. `local` (default): routes to per-language CPU analyzers — garu-ko (Korean), natural PorterStemmer (English), @node-rs/jieba (Chinese), kuromoji (Japanese). `llm`: falls back to the LLM subprocess path (`MorphemeIndex._tokenizeViaLLM()`). |
| MEMENTO_ENABLE_KUROMOJI | true | When `false`, skips loading the kuromoji Japanese analyzer, saving ~269MB resident memory. Useful for deployments with no Japanese fragments. Synced with `config/memory.js` `morphemeIndex.enableKuromoji`. |
| MEMENTO_FEEDBACK_SAMPLING | true | Attaches a `feedback_sampled` hint to successful remember/amend/forget responses with a fixed probability (`config/memory.js` `feedback.sampling.enabled`). When `false`, no hint is attached |
| MEMENTO_SPLIT_SUBJECT_GATE | true | Discards a split child that carries none of the parent's subject anchors (`fragmentSplit.requireSubjectAnchor`). When `false`, the subject check is skipped |
| MEMENTO_SPLIT_MODALITY_GATE | true | Discards a split child that introduces a modality absent from the parent (planned/intended/conjectured/obligatory) (`fragmentSplit.rejectIntroducedModality`). When `false`, the modality check is skipped |

#### Workspace Scoping & Session Segmentation

| Variable | Default | Description |
|----------|---------|-------------|
| MEMENTO_WORKSPACE_DECAY | true | When `false`, disables workspace ranking decay. When enabled, if the search scope specifies a workspace, a decay multiplier is applied to the ranking score of mismatched or global (NULL) fragments (the fragments themselves are still returned). Applies to both the recall and context injection paths |
| MEMENTO_WORKSPACE_DECAY_PENALTY | 0.7 | Decay multiplier (0-1) applied to the ranking score of workspace-mismatched or global fragments |
| MEMENTO_SESSION_SEGMENT | true | When `false`, disables session segment rotation and uses the transport-layer session ID as-is |
| MEMENTO_SEGMENT_IDLE_MS | 2700000 | When session idle time exceeds this value (ms), the segment rotates on the next tool call. Default 45 minutes |
| MEMENTO_SEGMENT_MAX_AGE_MS | 43200000 | When a segment's age exceeds this value (ms), it rotates regardless of idle state. Default 12 hours |
| MEMENTO_SEGMENT_MIN_ACTIVITY | 3 | Minimum activity (fragments + tool calls) required in the previous segment for AutoReflect to fire on segment rotation |
| MEMENTO_WORKSPACE_GATE | false | When `true`, includes `fragmentHasWorkspace` violations (workspace could not be resolved from an explicit value or the key default) in the hard-gate-eligible set. By default only a warning is recorded and storage is not blocked. Actual blocking still requires `MEMENTO_SYMBOLIC_POLICY_RULES` to be enabled and the key to have `api_keys.symbolic_hard_gate=true` |
| EPISODE_CONTINUITY_CACHE_TTL_MS | 5000 | TTL (ms) of the in-memory cache EpisodeContinuityService keeps per scope (`agentId:keyId:scopeType:scopeValue`) for the most recent milestone event ID. Insertion-order LRU, tracking up to 1000 scopes |

#### Migration Linting

| Variable | Default | Description |
|----------|---------|-------------|
| MIGRATION_LINT_FROM | (max existing + 1) | Lower-bound migration file number for `npm run lint:migrations`. Files with a number below this value are excluded from the body-only convention check. Useful for gradually adopting the convention on an existing codebase |

#### CLI Remote Access

| Variable | Default | Description |
|----------|---------|-------------|
| MEMENTO_CLI_REMOTE | (none) | Remote MCP server URL used when the CLI `--remote` flag is not specified. Example: `https://memento.anchormind.net/mcp` |
| MEMENTO_CLI_KEY | (none) | API key for remote server authentication, used when the CLI `--key` flag is not specified |

#### Symbolic Memory (opt-in)

All flags default to `false` / noop. For phased activation, follow the recommended order in the CHANGELOG.md Symbolic Memory Migration Guide.

| Variable | Default | Phase | Description |
|----------|---------|-------|-------------|
| MEMENTO_SYMBOLIC_ENABLED | false | 0 | Master kill switch for the entire symbolic subsystem |
| MEMENTO_SYMBOLIC_SHADOW | false | 1 | Shadow mode: symbolic results are recorded but not applied |
| MEMENTO_SYMBOLIC_CLAIM_EXTRACTION | false | 1 | Enables ClaimExtractor call in RememberPostProcessor |
| MEMENTO_SYMBOLIC_EXPLAIN | false | 2 | Includes `explanations: [{code, detail, ruleVersion}]` field in recall response fragments (only when explanations exist) |
| MEMENTO_SYMBOLIC_LINK_CHECK | false | 3 | Enables LinkIntegrityChecker advisory path |
| MEMENTO_SYMBOLIC_POLARITY_CONFLICT | false | 3 | Records ClaimConflictDetector advisory warnings |
| MEMENTO_SYMBOLIC_POLICY_RULES | false | 4 | PolicyRules soft gating — `remember` response includes `validation_warnings: string[]` (only when violations present), persisted to DB |
| MEMENTO_SYMBOLIC_CBR_FILTER | false | 5 | Applies symbolic filter to CaseRecall |
| MEMENTO_SYMBOLIC_PROACTIVE_GATE | false | 6 | ProactiveRecall polarity gate |
| MEMENTO_SYMBOLIC_RULE_VERSION | v1 | - | Rule package version identifier (fragment_claims.rule_version column) |
| MEMENTO_SYMBOLIC_TIMEOUT_MS | 50 | - | SymbolicOrchestrator single call timeout (ms) |
| MEMENTO_SYMBOLIC_MAX_CANDIDATES | 32 | - | Candidate count cap for symbolic processing |

The `api_keys.symbolic_hard_gate` column (migration-033) enables per-key hard gate switching. Defaults to false. When set to true, PolicyRules violations cause the remember() call to be rejected with a JSON-RPC **protocol-level** error `-32003` (not an MCP tool error — `error.data.violations: string[]` included). Master keys (keyId=NULL) are excluded. Cache TTL is 30 seconds.

#### LLM Provider Fallback Chain

Automatic fallback to 15 providers beyond Gemini CLI. Existing behavior is fully preserved with default settings.

##### Basic Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| LLM_PRIMARY | gemini-cli | Primary provider name. gemini-cli requires no env configuration |
| LLM_FALLBACKS | (none) | JSON array. Each element specifies provider/apiKey/model/baseUrl/timeoutMs/extraHeaders |
| LLM_PROVIDER_TIMEOUT_MS | 60000 | Per-provider call timeout (ms). Overrides the caller-supplied timeout only when explicitly set; otherwise each call path keeps its own value |
| LLM_CHAIN_TIMEOUT_MS | 0 | Deadline for the whole chain (ms). `0` disables the deadline. Exceeding it aborts with `chain deadline exceeded after Nms` |

##### Circuit Breaker

| Variable | Default | Description |
|----------|---------|-------------|
| LLM_CB_FAILURE_THRESHOLD | 5 | Consecutive failure tolerance. Exceeding this threshold transitions the provider to OPEN state |
| LLM_CB_OPEN_DURATION_MS | 60000 | OPEN state duration (ms). Automatically transitions to CLOSED after this interval |
| LLM_CB_FAILURE_WINDOW_MS | 60000 | Failure count window (ms) |

When REDIS_ENABLED=true, state is stored in Redis; otherwise in-memory.

##### LLM Concurrency Control

| Variable | Default | Description |
|----------|---------|-------------|
| LLM_CONCURRENCY_ENABLED | true | When false, bypasses the semaphore and sends requests to all providers without concurrency limits |
| LLM_CONCURRENCY_WAIT_MS | 30000 | Slot wait timeout (ms). Request fails if no slot becomes available within this duration |
| LLM_CONCURRENCY | (see below) | JSON object. Slot limit keyed by chainKey (`provider|baseUrl|model`) or provider name |

`LLM_CONCURRENCY` defaults (`DEFAULT_LLM_CONCURRENCY`):

```json
{
  "ollama": 16,
  "openai|https://token-plan-sgp.xiaomimimo.com/v1|mimo-v2-pro": 8,
  "gemini-cli": 1,
  "agy-cli": 1,
  "copilot-cli": 1,
  "codex-cli": 1,
  "qwen-cli": 1,
  "opencode-cli": 1
}
```

The default slot limit for providers not listed is 10. When `LLM_CONCURRENCY` is set, it is merged with the defaults.

##### Token Usage Cap

| Variable | Default | Description |
|----------|---------|-------------|
| LLM_TOKEN_BUDGET_INPUT | (none) | Input token cap. When set, requests exceeding the cap are rejected. When unset, observation only |
| LLM_TOKEN_BUDGET_OUTPUT | (none) | Output token cap |
| LLM_TOKEN_BUDGET_WINDOW_SEC | 86400 | Reset interval (seconds). Default 1 day |

##### Supported Providers

gemini-cli, **agy-cli**, anthropic, openai, google-gemini-api, groq, openrouter, xai, ollama, vllm, deepseek, mistral, cohere, zai, **codex-cli**, **copilot-cli**, **qwen-cli**, **opencode-cli**

**agy-cli**: Runs Google Antigravity CLI (`agy`) with `--print --output-format text --mode plan --sandbox`. AnchorMind uses the provider only for JSON transformations, so the CLI is constrained from editing files or approving tool calls. Antigravity authentication and the `agy` binary are required; `model` and `timeoutMs` are passed to the CLI invocation:
```json
[{"provider": "agy-cli", "model": "<model listed by agy models>", "timeoutMs": 40000}]
```

Because `agy` treats tokens after `--print` as the prompt, AnchorMind invokes it as `--output-format text --mode plan --sandbox [--model MODEL] --print PROMPT`.

On macOS launchd deployments, shell profiles are not loaded. Add `~/.local/bin` explicitly to the plist `PATH` so the service can find `agy`.

**codex-cli**: Executes `codex exec --skip-git-repo-check --sandbox read-only --output-last-message FILE`. Authenticates via `OPENAI_API_KEY` or the Codex CLI config file. `model` and `timeoutMs` in `LLM_FALLBACKS` are passed through to the actual CLI invocation:
```json
[{"provider": "codex-cli", "model": "gpt-5.3-codex-spark"}]
```

**copilot-cli**: Wraps GitHub Copilot CLI (`gh copilot suggest`). Requires `gh` CLI and a Copilot subscription:
```json
[{"provider": "copilot-cli"}]
```

**qwen-cli**: Wraps Alibaba Cloud Qwen Code CLI (`qwen`). Requires Qwen CLI authentication (`qwen auth`). `model` and `timeoutMs` from `LLM_FALLBACKS` are passed through as provider config, and when `model` is still omitted the CLI default model is used:
```json
[{"provider": "qwen-cli"}]
[{"provider": "qwen-cli", "model": "qwen-max"}]
```

**geminiTimeoutMs**: The `morphemeIndex.geminiTimeoutMs` value in `config/memory.js` defaults to **60000ms**. In Gemini CLI and Ollama Cloud environments, response latency can reach 20-40s, so this value is set high enough to avoid "all LLM providers failed" errors.

This value is passed to the `geminiCLIJson(userPrompt, { timeoutMs: cfg.geminiTimeoutMs })` call inside `MorphemeIndex._tokenizeViaLLM()`, which is invoked only when `MEMENTO_MORPHEME_TOKENIZER=llm`. With the default setting (`MEMENTO_MORPHEME_TOKENIZER=local`), the local analyzer (MorphemeTokenizer) is used and this value is not referenced. When the LLM path fails, no morphemes are extracted and the L3 morpheme search path degrades gracefully via `_fallbackTokenize`.

**buildChain ordering logic** (`lib/llm/index.js:38–68`): An entries array is constructed from `LLM_PRIMARY` followed by `LLM_FALLBACKS` in declaration order. A `seen` Set removes duplicate providers, and each provider's `isAvailable()` check determines whether it is included in the chain. If `LLM_PRIMARY` also appears in `LLM_FALLBACKS`, the fallback config object takes precedence. A provider that fails `isAvailable()` is excluded from the chain and the next provider is tried immediately. The resulting chain order corresponds 1:1 with the env variable declaration order.

For detailed operational guidance, see `docs/operations/llm-providers.md`.

#### OAuth Token TTL

OAuth token TTLs are linked to the session TTL.

| Variable | Default | Description |
|----------|---------|-------------|
| OAUTH_TOKEN_TTL_SECONDS | 2592000 | OAuth access token TTL (seconds). Calculated as `SESSION_TTL_MINUTES * 60`. Default 30 days |
| OAUTH_REFRESH_TTL_SECONDS | 5184000 | OAuth refresh token TTL (seconds). `OAUTH_TOKEN_TTL_SECONDS * 2`. Default 60 days |

Sliding window: each time an OAuth-authenticated request arrives, the Redis TTL for that access token is reset to `OAUTH_TOKEN_TTL_SECONDS`. The token never expires as long as tools continue to be used.

#### SSE Connection

| Variable | Default | Description |
|----------|---------|-------------|
| SSE_HEARTBEAT_INTERVAL_MS | 25000 | SSE heartbeat ping interval (ms). Used to verify client connection is alive |
| SSE_MAX_HEARTBEAT_FAILURES | 10 | Consecutive heartbeat send failure tolerance. Session is automatically terminated when exceeded. Detects write backpressure and network errors |
| SSE_RETRY_MS | 5000 | SSE reconnection wait time (ms). Sent to client via the `retry:` field |
| MCP_IDLE_REFLECT_HOURS | 24 | Idle session intermediate autoReflect threshold (hours). Sessions inactive for this duration receive a mid-session reflect during cleanup to prevent memory loss. |

### PostgreSQL

POSTGRES_* prefixes take precedence over DB_* prefixes. Both formats can be mixed.

| Variable | Description |
|----------|-------------|
| POSTGRES_HOST / DB_HOST | Host address |
| POSTGRES_PORT / DB_PORT | Port number. Default 5432 |
| POSTGRES_DB / DB_NAME | Database name |
| POSTGRES_USER / DB_USER | Connection user |
| POSTGRES_PASSWORD / DB_PASSWORD | Connection password |
| DB_MAX_CONNECTIONS | Connection pool max connections. Default 20 |
| DB_IDLE_TIMEOUT_MS | Idle connection return timeout ms. Default 30000 |
| DB_CONN_TIMEOUT_MS | Connection acquisition timeout ms. Default 10000 |
| DB_QUERY_TIMEOUT | Query timeout ms. Default 30000 |
| BATCH_DATABASE_URL | (none, optional) Dedicated PostgreSQL URL for batchPool. Falls back to the primary `DATABASE_URL` when unset. batchPool handles heavy transactions (multi-row INSERTs) in a dedicated pool to prevent starvation of recall requests. Pool size is `primaryMax × 0.3` (minimum 2). `application_name='memento-mcp:batch'` is set for pg_stat_activity monitoring. Pool size and application_name are determined internally and cannot be overridden via environment variables. |

### batch_remember Async Mode

`batch_remember` tool requests with `async=true` are processed asynchronously through a Redis queue (`memento:batch_remember_queue`).

| Item | Value |
|-|-|
| Queue key | `memento:batch_remember_queue` |
| Worker polling interval | 1000ms |
| Fallback when Redis disabled | Automatically falls back to synchronous mode |
| Automatic retry | None (no retry on queue loss) |

This feature operates asynchronously only when `REDIS_ENABLED=true`. When `REDIS_ENABLED=false`, passing `async=true` still processes synchronously.

**Total character gate**: If the total content character count across the `fragments` array exceeds `BATCH_REMEMBER_MAX_TOTAL_CHARS` (default 200,000), the entire batch request is rejected immediately, before the sync/async branch is taken. This is a separate cap from the per-item 4000-character limit (which fails only the offending item); it bounds the processing cost of large batches upfront.

| Variable | Default | Description |
|----------|---------|-------------|
| BATCH_REMEMBER_MAX_TOTAL_CHARS | 200000 | Total content character cap across the `batch_remember` fragments array |

### Redis

| Variable | Default | Description |
|----------|---------|-------------|
| REDIS_ENABLED | false | Enable Redis. When false, L1 search and caching are disabled |
| REDIS_SENTINEL_ENABLED | false | Use Sentinel mode |
| REDIS_HOST | localhost | Redis server host |
| REDIS_PORT | 6379 | Redis server port |
| REDIS_PASSWORD | (none) | Redis authentication password |
| REDIS_DB | 0 | Redis database number |
| REDIS_MASTER_NAME | mymaster | Sentinel master name |
| REDIS_SENTINELS | localhost:26379, localhost:26380, localhost:26381 | Sentinel node list. Comma-separated host:port format |

### Caching

| Variable | Default | Description |
|----------|---------|-------------|
| CACHE_ENABLED | Same as REDIS_ENABLED | Enable query result caching |
| CACHE_DB_TTL | 300 | DB query result cache TTL (seconds) |
| CACHE_SESSION_TTL | SESSION_TTL_MS / 1000 | Session cache TTL (seconds) |

### AI

| Variable | Default | Description |
|----------|---------|-------------|
| OPENAI_API_KEY | (none) | OpenAI API key. Used when `EMBEDDING_PROVIDER=openai` |
| EMBEDDING_PROVIDER | openai | Embedding provider. `openai` \| `gemini` \| `ollama` \| `localai` \| `cloudflare` \| `custom` \| `transformers` |
| EMBEDDING_API_KEY | (none) | Generic embedding API key. Falls back to `OPENAI_API_KEY` when unset |
| EMBEDDING_BASE_URL | (none) | OpenAI-compatible endpoint URL when `EMBEDDING_PROVIDER=custom` |
| EMBEDDING_MODEL | (provider default) | Embedding model to use. Provider-specific default applied when omitted |
| EMBEDDING_DIMENSIONS | (provider default) | Embedding vector dimensions. Must match the DB schema's vector dimension |
| EMBEDDING_SUPPORTS_DIMS_PARAM | (provider default) | Override dimensions parameter support (`true`\|`false`) |
| GEMINI_API_KEY | (none) | Google Gemini API key. Used when `EMBEDDING_PROVIDER=gemini` |
| CF_ACCOUNT_ID | (none) | Cloudflare account ID. Required when `EMBEDDING_PROVIDER=cloudflare`. Falls back to `CLOUDFLARE_ACCOUNT_ID` when unset |
| CF_API_TOKEN | (none) | Cloudflare API token. Required when `EMBEDDING_PROVIDER=cloudflare`. Falls back to `CLOUDFLARE_API_TOKEN` when unset |
| EMBEDDING_TIMEOUT_MS | 8000 | Absolute per-call timeout (ms) for embedding API requests. Applied via `AbortSignal.timeout()` and acts as the overall deadline |
| EMBEDDING_MAX_RETRIES | 0 | Retry count for the OpenAI-compatible client's own retry logic. Defaults to 0 because the per-call timeout already acts as the absolute deadline; stacking retries on top would let semaphore hold time accumulate as timeout × retries |
| EMBEDDING_CONCURRENCY | 6 | Process-wide concurrency cap for embedding calls. The semaphore slot count that prevents embedding service latency from propagating into the overall request queue |
| EMBEDDING_SEM_WAIT_MS | 3000 | Wait timeout (ms) for an embedding semaphore slot. Calls that exceed this are rejected and increment the `mcp_embedding_semaphore_wait_exceeded_total` counter |

---

## MEMORY_CONFIG

Configuration file defined in `config/memory.js`. Ranking weights and stale thresholds can be adjusted without modifying server code.

```js
export const MEMORY_CONFIG = {
  ranking: {
    importanceWeight        : 0.4,   // Importance weight in time-semantic composite ranking
    recencyWeight           : 0.3,   // Temporal proximity weight (exponential decay from anchorTime)
    semanticWeight          : 0.3,   // Semantic similarity weight
    activationThreshold     : 0,     // Always apply composite ranking
    recencyHalfLifeDays     : 30,    // Temporal proximity half-life (days)
    // MemoryRecaller final sort lexical correction — additive term only, not a hard override.
    // lexWeight is determined per-fragment by rerankerScore presence.
    lexicalWeightReranked   : 0.12,  // Lexical fine-tuning for fragments that have a rerankerScore
    lexicalWeightFallback   : 0.18,  // Lexical boost for fragments without rerankerScore (intentionally below semanticWeight 0.30)
    lexicalLinkedMultiplier : 0.5,   // Lexical weight decay for includeLinks fragments
    lexicalSaturation       : 8,     // log normalization denominator for lexicalMatchScore
    unrerankedBaseDiscount  : 0.85,  // Base penalty applied to fragments without a rerankerScore
  },
  staleThresholds: {
    procedure: 30,   // Stale threshold for procedure fragments (days)
    fact      : 60,  // Stale threshold for fact fragments (days)
    decision  : 90,  // Stale threshold for decision fragments (days)
    default   : 60   // Stale threshold for other types (days)
  },
  halfLifeDays: {
    procedure : 30,  // Decay half-life -- time for importance to halve (days)
    fact      : 60,
    decision  : 90,
    error     : 45,
    preference: 120,
    relation  : 90,
    default   : 60
  },
  rrfSearch: {
    k             : 60,   // RRF denominator constant. Larger values reduce top-rank dependency
    l1WeightFactor: 2.0   // Weight multiplier for L1 Redis results (highest priority injection)
  },
  linkedFragmentLimit: 10,  // Max 1-hop linked fragments on recall with includeLinks
  embeddingWorker: {
    batchSize      : 10,      // Fragments per batch
    intervalMs     : 5000,    // Polling interval (ms)
    retryLimit     : 3,       // Retry count on failure
    retryDelayMs   : 2000,    // Retry interval (ms)
    queueKey       : "memento:embedding_queue"
  },
  contextInjection: {
    maxCoreFragments   : 15,     // Core Memory max fragment count
    maxWmFragments     : 10,     // Working Memory max fragment count
    typeSlots          : {       // Per-type max slots
      preference : 5,
      error      : 5,
      procedure  : 5,
      decision   : 3,
      fact       : 3
    },
    defaultTokenBudget : 2000
  },
  pagination: {
    defaultPageSize : 20,
    maxPageSize     : 50
  },
  gc: {
    utilityThreshold       : 0.15,   // Below this + inactive = deletion candidate
    gracePeriodDays        : 7,      // Minimum survival period (days)
    inactiveDays           : 60,     // Inactivity period (days)
    maxDeletePerCycle      : 50,     // Max deletions per cycle
    factDecisionPolicy     : {
      importanceThreshold  : 0.2,    // GC importance threshold for fact/decision
      orphanAgeDays        : 30      // Orphan fact/decision deletion threshold (days)
    },
    errorResolvedPolicy    : {
      maxAgeDays           : 30,     // [resolved] error fragment deletion threshold (days)
      maxImportance        : 0.3     // Below this = deletion candidate
    }
  },
  reflectionPolicy: {
    maxAgeDays       : 30,       // session_reflect fragment deletion threshold (days)
    maxImportance    : 0.3,      // Below this = deletion candidate
    keepPerType      : 5,        // Keep latest N per type
    maxDeletePerCycle: 30        // Max deletions per cycle
  },
  semanticSearch: {
    minSimilarity  : 0.4,        // L3 pgvector search minimum similarity (default 0.4)
    limit          : 30,         // L3 max return count
    keywordFallback: true,       // Run L3 semantic supplement for keywords-only queries without text (disable with MEMENTO_KEYWORD_SEMANTIC_FALLBACK=false)
    keywordFallbackTimeoutMs: 1500 // Upper bound for the keyword-supplement L3 run (env MEMENTO_KEYWORD_FALLBACK_TIMEOUT_MS)
  },
  temperatureBoost: {
    warmWindowDays     : 7,      // Apply warmBoost to fragments accessed within this window
    warmBoost          : 0.2,    // Score boost for recently accessed fragments
    highAccessBoost    : 0.15,   // Score boost for fragments exceeding access threshold
    highAccessThreshold: 5,      // Access count threshold for highAccessBoost
    learningBoost      : 0.3     // Score boost for learning_extraction fragments
  }
};
```

The sum of importanceWeight + recencyWeight + semanticWeight must equal 1.0. halfLifeDays determines decay speed and operates independently of staleThresholds. rrfSearch.k is the RRF denominator stabilization constant, with 60 as the general-purpose default. gc.factDecisionPolicy cleans up orphan fact/decision fragments under separate criteria to reduce search noise.

### proactiveRecall

Post-processing settings for the automatic link creation that runs immediately after remember().

| Key | ENV | Default | Description |
|-|-|-|-|
| `mode` | `MEMENTO_PROACTIVE_RECALL_MODE` | `"auto"` | `"auto"`: runs automatically when conditions are met. `"off"`: disabled |
| `keywordOverlapMin` | `MEMENTO_PROACTIVE_KW_OVERLAP_MIN` | `0.5` | Minimum keyword overlap ratio. The ratio of common keywords between the stored fragment and a candidate must reach this threshold for a link to be created |
| `requireSameWorkspace` | — | `true` | Fragments from a different workspace are excluded from ProactiveRecall |
| `caseIdPolicy` | `MEMENTO_PROACTIVE_CASE_POLICY` | `"strict-or-adjacent"` | `"both-required"`: both fragments must share the same case_id. `"strict-or-adjacent"`: same case_id or a different case within adjacencyWindowMs. `"loose"`: case_id mismatches are allowed |
| `adjacencyWindowMs` | — | `86400000` (24h) | Time window (ms) within which a different case is considered adjacent under the `"strict-or-adjacent"` policy |
| `requireSameTopicOrType` | — | `false` | When true, only fragments sharing the same topic or type are eligible for linking |

The `proactive-gate.js` symbolic gate evaluates `workspace_mismatch` and `case_policy` block reasons. Activated by `MEMENTO_SYMBOLIC_PROACTIVE_GATE=true`.

### consolidate.schemaFit

Gate conditions that evaluate whether sufficient changes have accumulated before running MemoryConsolidator automatically.

| Key | Default | Description |
|-|-|-|
| `pendingCaseFragmentsMin` | `5` | Condition met when unprocessed case fragments reach this count |
| `recentRelatedLinksMin` | `20` | Condition met when recently created related links reach this count |
| `fragmentsSinceLastRunMin` | `30` | Condition met when new fragments since the last run reach this count |
| `mode` | `"any"` | `"any"`: run if at least 1 of 3 conditions is met. `"all"`: run only if all 3 are met. `"off"`: disable gate (always run). ENV: `MEMENTO_CONSOLIDATE_GATE_MODE` |

Each time the consolidateIntervalMs timer fires (default 6h = 21600000ms), this gate is evaluated. When the gate is not passed, that run cycle is skipped. `consolidateIntervalMs` is controlled by the `CONSOLIDATE_INTERVAL_MS` environment variable.

### consolidate.enableRiskyStages

Individual activation flags for the 3 stages that involve LLM rewriting and can modify fragment content.

| Key | ENV | Default | Stage | Description |
|-|-|-|-|-|
| `splitLongFragments` | `MEMENTO_CONSOLIDATE_SPLIT_LONG` | `true` | stage 5 | Splits long fragments into 2–3 atomic fragments. LLM determines split boundaries |
| `detectContradictions` | `MEMENTO_CONSOLIDATE_DETECT_CONTRADICT` | `true` | stage 14 | NLI + LLM hybrid contradiction detection and contradicts link creation |
| `compressOldFragments` | `MEMENTO_CONSOLIDATE_COMPRESS_OLD` | `false` | stage 8 | LLM-based compression summary of old fragment groups. Disabled by default |

A stage with its flag set to `false` emits `status: "skipped"` and proceeds to the next stage. `compressOldFragments` defaults to `false` because it modifies original fragment content.

Split children receive their `keywords` from their own body via `FragmentFactory.extractKeywords`, the same path `remember` uses. The parent's keywords are not copied.

Anchor coverage check for `splitLongFragments`: the split rewrites the source through an LLM rather than cutting it, so an entire proposition can go missing. Right before the children are stored, the numeric anchors of the source (dates, amounts, ratios, measurements) are matched against the union of the children. If any anchor is absent, no child is stored, the original is left intact, `split_attempt_failed_at` is refreshed, and `memento_consolidate_split_skipped_total{reason="anchor_loss"}` is incremented. A date such as `2026-07-15` is compared as `2026`/`07`/`15` and a range such as `75~85` as `75`/`85`, so rephrasing passes as long as the component digits survive. Digit group separators are ignored; single digits and sources without any numeric token are excluded from the check.

Subject anchor gate (`fragmentSplit.requireSubjectAnchor`, default `true`, ENV `MEMENTO_SPLIT_SUBJECT_GATE`): up to `subjectAnchorMax` (default 12) subject anchors are extracted from the parent body — proper-noun/foreign/Han tokens from the morphological analyzer plus code identifiers (camelCase, PascalCase, snake_case) and Latin+Hangul compounds such as `A사`. A child carrying none of them is discarded and `memento_consolidate_split_skipped_total{reason="subject_loss"}` is incremented. Single-character Hangul tokens are not used as anchors because they collide by chance. Only when no anchor can be extracted at all does the gate pass (fail-open). Even if the morphological analyzer fails to load, code identifiers and Latin+Hangul compounds are still extracted by regex, so an unloaded analyzer does not by itself disable the gate.

Modality drift gate (`fragmentSplit.rejectIntroducedModality`, default `true`, ENV `MEMENTO_SPLIT_MODALITY_GATE`): the modality families of parent and child (future, intention, conjecture, obligation) are compared. A child that introduces a family absent from the parent is discarded and `memento_consolidate_split_skipped_total{reason="modality_drift"}` is incremented. Swapping expressions within the same family is allowed as a rewrite; only a completed statement turning into a plan, conjecture, or obligation is blocked.

Both gates judge per child, so a single parent can produce several increments. Do not compare them against per-fragment reasons such as `low_yield` or `anchor_loss` using the same denominator.

### feedback.sampling

Write-path tools attach a `tool_feedback` request hint with a fixed probability. Voluntary feedback alone skews the sample toward successes, so an evaluation is requested right after a store, amend, or delete. Configured in the `feedback.sampling` block of `config/memory.js`.

| Key | Default | Description |
|-|-|-|
| `enabled` | `true` | Enables hint attachment. ENV: `MEMENTO_FEEDBACK_SAMPLING` |
| `rates.remember` | `0.10` | Sampling probability for successful remember responses |
| `rates.amend` | `0.25` | Sampling probability for successful amend responses |
| `rates.forget` | `0.25` | Sampling probability for successful forget responses |
| `maxHintsPerSession` | `2` | Per-session hint cap. Silent beyond the cap |
| `cooldownSeconds` | `900` | Minimum interval before another hint may be issued |

recall is excluded from `rates` because it already has its own hint path. Cap and cooldown counters live in Redis (`frag:fbhint:count:*`, `frag:fbhint:cd:*`); when Redis is unavailable only the probability check applies (fail-open). `remember(dryRun=true)`, `forget(dryRun=true)`, and an `amend` that changed nothing are never sampled. A sampled response carries `signal: "feedback_sampled"` and `args: {tool_name, trigger_type: "sampled"}` in `_meta.hints[0]`.

### SearchParamAdaptor (Automatic Search Parameter Learning)

SearchParamAdaptor operates automatically without any separate environment variables. It uses the `semanticSearch.minSimilarity` value from `config/memory.js` as the default. After 50 or more searches, the learned value per key_id x query_type x hour combination replaces the default.

| Hardcoded Constant | Value | Description |
|--------------------|-------|-------------|
| MIN_SAMPLE | 50 | Minimum sample count before learned values are applied |
| CLAMP_MIN | 0.10 | minSimilarity lower bound |
| CLAMP_MAX | 0.60 | minSimilarity upper bound |
| step | 0.01 | Adjustment step size (symmetric) |

Learned data is stored in the `agent_memory.search_param_thresholds` table (migration-029).

Searches that return zero rows because of an exact-match `topic` filter are excluded from the learning sample. topic is evaluated as an exact match across every layer, so a single typo drives all layers to zero at once, and feeding that into the adaptor only produces downward pressure on minSimilarity. The `search_events` record is still written; only SearchParamAdaptor learning skips it. In that case recall looks up nearby topics and attaches a `topic_mismatch` hint to `_meta.hints` to steer a re-query (`TopicResolver`).

### Runtime Validation

`config/validate-memory-config.js` validates the structural integrity of `MEMORY_CONFIG` once at server startup. On validation failure, it throws an error and halts server startup.

Validated items:
- `ranking` weights (importanceWeight + recencyWeight + semanticWeight) sum = 1.0
- `contextInjection.rankWeights` sum = 1.0
- `semanticSearch.minSimilarity`, `morphemeIndex.minSimilarity`, `gc.utilityThreshold` are in the 0-1 range
- All `halfLifeDays` entries are positive
- `gc.gracePeriodDays` < `gc.inactiveDays`
- `embeddingWorker.batchSize`, `embeddingWorker.intervalMs`, `pagination.defaultPageSize`, `pagination.maxPageSize`, `gc.maxDeletePerCycle` are positive integers

---

## Switching Embedding Providers

Switch providers with a single `EMBEDDING_PROVIDER` environment variable. Model, dimensions, and base URL are automatically determined from provider defaults, with individual environment variable overrides available as needed.

Embeddings are used for L3 semantic search and automatic link creation.

> Dimension change warning: Changing `EMBEDDING_DIMENSIONS` requires a PostgreSQL schema change. Run `node scripts/post-migrate-flexible-embedding-dims.js` followed by `node scripts/backfill-embeddings.js` in order.

---

### OpenAI (default)

```env
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

| Model | Dimensions | Notes |
|-------|-----------|-------|
| text-embedding-3-small | 1536 | Default. Cost-efficient |
| text-embedding-3-large | 3072 | High precision. 2x cost |
| text-embedding-ada-002 | 1536 | Legacy compatible |

---

### Google Gemini

`text-embedding-004` was discontinued January 14, 2026. The currently recommended model is `gemini-embedding-001` (3072 dimensions).

```env
EMBEDDING_PROVIDER=gemini
GEMINI_API_KEY=AIza...
```

3072 dimensions differs from the default schema (1536), so migration-007 must be run on first switch:

```bash
EMBEDDING_DIMENSIONS=3072 DATABASE_URL=$DATABASE_URL \
  node scripts/post-migrate-flexible-embedding-dims.js
DATABASE_URL=$DATABASE_URL node scripts/backfill-embeddings.js
```

> halfvec type requires pgvector 0.7.0 or later. Check version: `SELECT extversion FROM pg_extension WHERE extname = 'vector';`

| Model | Dimensions | Notes |
|-------|-----------|-------|
| gemini-embedding-001 | 3072 | Current recommended model. High precision |
| text-embedding-004 | 768 | Discontinued 2026-01-14 |

---

### Ollama (local)

Ollama must be running at `http://localhost:11434`.

```env
EMBEDDING_PROVIDER=ollama
# EMBEDDING_MODEL=nomic-embed-text  # default
```

```bash
# Download models
ollama pull nomic-embed-text
ollama pull mxbai-embed-large
```

| Model | Dimensions | Notes |
|-------|-----------|-------|
| nomic-embed-text | 768 | 8192 token context, high MTEB performance |
| mxbai-embed-large | 1024 | 512 context, competitive MTEB scores |
| all-minilm | 384 | Ultra-lightweight, suitable for local testing |

---

### LocalAI (local)

```env
EMBEDDING_PROVIDER=localai
```

---

### Cloudflare Workers AI

Uses Cloudflare Workers AI's OpenAI-compatible endpoint. The base URL is automatically constructed from `CF_ACCOUNT_ID`.

```env
EMBEDDING_PROVIDER=cloudflare
CF_ACCOUNT_ID=your_account_id
CF_API_TOKEN=your_api_token
# EMBEDDING_MODEL=@cf/baai/bge-small-en-v1.5  # default
```

Find your Account ID on the Cloudflare dashboard → account home, lower right. Generate an API token with "Workers AI" permission.

384 dimensions differs from the default schema (1536), so migration-007 must be run on first switch:

```bash
EMBEDDING_DIMENSIONS=384 DATABASE_URL=$DATABASE_URL \
  node scripts/post-migrate-flexible-embedding-dims.js
DATABASE_URL=$DATABASE_URL node scripts/backfill-embeddings.js
```

| Model | Dimensions | Notes |
|-------|-----------|-------|
| @cf/baai/bge-small-en-v1.5 | 384 | Default. Lightweight, fast |
| @cf/baai/bge-base-en-v1.5 | 768 | Balanced |
| @cf/baai/bge-large-en-v1.5 | 1024 | High precision |

> The `dimensions` parameter is not supported. When changing models, specify both `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` explicitly.

---

### Custom OpenAI-Compatible Server

Use for any OpenAI-compatible server such as LM Studio or llama.cpp.

```env
EMBEDDING_PROVIDER=custom
EMBEDDING_BASE_URL=http://my-server:8080/v1   # adjust port for your environment
EMBEDDING_API_KEY=my-key
EMBEDDING_MODEL=my-model
EMBEDDING_DIMENSIONS=1024
```

---

### Local Transformers Embedding

> Generates embeddings locally without an API key. Uses the `@huggingface/transformers` library and runs on CPU alone without a GPU.

```env
EMBEDDING_PROVIDER=transformers
EMBEDDING_MODEL=Xenova/multilingual-e5-small   # default (384 dimensions, ~60MB)
# EMBEDDING_MODEL=Xenova/bge-m3                # alternative (1024 dimensions, ~280MB, multilingual high-precision)
EMBEDDING_DIMENSIONS=384                        # must be specified explicitly when different from the default schema (1536)
```

**Note**: Mutually exclusive with API-based providers (openai, gemini, etc.). Switching requires a DB schema change; mismatched dimensions from existing embeddings will degrade search precision.

Switching procedure:
```bash
# 1. Update schema dimensions (example: 1536 -> 384)
EMBEDDING_DIMENSIONS=384 DATABASE_URL=$DATABASE_URL \
  node scripts/post-migrate-flexible-embedding-dims.js

# 2. Regenerate embeddings for existing fragments
DATABASE_URL=$DATABASE_URL node scripts/backfill-embeddings.js
```

At server startup, `check-embedding-consistency.js` automatically validates that the DB vector dimensions match `EMBEDDING_DIMENSIONS`. A mismatch halts the process to guarantee integrity.

For details, see [docs/embedding-local.md](embedding-local.md).

---

### Commercial APIs (Custom Adapter Required)

Cohere, Voyage AI, Mistral, Jina AI, and Nomic are either incompatible with the OpenAI SDK or have separate API structures. Replace the `generateEmbedding` function in `lib/tools/embedding.js` with the examples below.

#### Cohere

```bash
npm install cohere-ai
```

```js
// lib/tools/embedding.js -- replace generateEmbedding
import { CohereClient } from "cohere-ai";

const cohere = new CohereClient({ token: process.env.COHERE_API_KEY });

export async function generateEmbedding(text) {
  const res = await cohere.v2.embed({
    model:          "embed-v4.0",
    inputType:      "search_document",
    embeddingTypes: ["float"],
    texts:          [text]
  });
  return normalizeL2(res.embeddings.float[0]);
}
```

```env
COHERE_API_KEY=...
EMBEDDING_DIMENSIONS=1536
```

| Model | Dimensions | Notes |
|-------|-----------|-------|
| embed-v4.0 | 1536 | Latest, multilingual |
| embed-multilingual-v3.0 | 1024 | Legacy multilingual |

---

#### Voyage AI

```js
// lib/tools/embedding.js -- replace generateEmbedding
export async function generateEmbedding(text) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${process.env.VOYAGE_API_KEY}`,
      "Content-Type":  "application/json"
    },
    body: JSON.stringify({ model: "voyage-3.5", input: [text] })
  });
  const data = await res.json();
  return normalizeL2(data.data[0].embedding);
}
```

```env
VOYAGE_API_KEY=...
EMBEDDING_DIMENSIONS=1024
```

| Model | Dimensions | Notes |
|-------|-----------|-------|
| voyage-3.5 | 1024 | Highest accuracy |
| voyage-3.5-lite | 512 | Low cost, fast |
| voyage-code-3 | 1024 | Code-specialized |

---

#### Mistral AI

OpenAI SDK compatible, so just swap the `baseURL`.

```js
// lib/tools/embedding.js -- replace generateEmbedding
import OpenAI from "openai";

const client = new OpenAI({
  apiKey:  process.env.MISTRAL_API_KEY,
  baseURL: "https://api.mistral.ai/v1"
});

export async function generateEmbedding(text) {
  const res = await client.embeddings.create({
    model: "mistral-embed",
    input: [text]
  });
  return normalizeL2(res.data[0].embedding);
}
```

```env
MISTRAL_API_KEY=...
EMBEDDING_DIMENSIONS=1024
```

---

#### Jina AI

Free tier: 100 RPM / 1M tokens/month.

```js
// lib/tools/embedding.js -- replace generateEmbedding
export async function generateEmbedding(text) {
  const res = await fetch("https://api.jina.ai/v1/embeddings", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${process.env.JINA_API_KEY}`,
      "Content-Type":  "application/json"
    },
    body: JSON.stringify({
      model: "jina-embeddings-v3",
      task:  "retrieval.passage",
      input: [text]
    })
  });
  const data = await res.json();
  return normalizeL2(data.data[0].embedding);
}
```

```env
JINA_API_KEY=...
EMBEDDING_DIMENSIONS=1024
```

| Model | Dimensions | Notes |
|-------|-----------|-------|
| jina-embeddings-v3 | 1024 | MRL support (32~1024 flexible dimensions) |
| jina-embeddings-v2-base-en | 768 | English-specialized |

---

#### Nomic

Free tier: 1M tokens/month. OpenAI SDK compatible, so applicable via `baseURL` change.

```js
// lib/tools/embedding.js -- replace generateEmbedding
import OpenAI from "openai";

const client = new OpenAI({
  apiKey:  process.env.NOMIC_API_KEY,
  baseURL: "https://api-atlas.nomic.ai/v1"
});

export async function generateEmbedding(text) {
  const res = await client.embeddings.create({
    model: "nomic-embed-text-v1.5",
    input: [text]
  });
  return normalizeL2(res.data[0].embedding);
}
```

```env
NOMIC_API_KEY=...
EMBEDDING_DIMENSIONS=768
```

---

### Provider Comparison

| Service | Dimensions | Configuration | Free Tier |
|---------|-----------|---------------|-----------|
| OpenAI text-embedding-3-small | 1536 | `EMBEDDING_PROVIDER=openai` | None |
| OpenAI text-embedding-3-large | 3072 | `EMBEDDING_PROVIDER=openai` | None |
| Google Gemini gemini-embedding-001 | 3072 | `EMBEDDING_PROVIDER=gemini` | Yes (limited) |
| Ollama (nomic-embed-text) | 768 | `EMBEDDING_PROVIDER=ollama` | Fully free (local) |
| Ollama (mxbai-embed-large) | 1024 | `EMBEDDING_PROVIDER=ollama` | Fully free (local) |
| LocalAI | Variable | `EMBEDDING_PROVIDER=localai` | Fully free (local) |
| Cloudflare Workers AI (bge-small) | 384 | `EMBEDDING_PROVIDER=cloudflare` | Yes (10K req/day) |
| Cloudflare Workers AI (bge-large) | 1024 | `EMBEDDING_PROVIDER=cloudflare` | Yes (10K req/day) |
| Custom compatible server | Variable | `EMBEDDING_PROVIDER=custom` | -- |
| HuggingFace Transformers (multilingual-e5-small) | 384 | `EMBEDDING_PROVIDER=transformers` | Fully free (local) |
| Cohere embed-v4.0 | 1536 | Code replacement | None |
| Voyage AI voyage-3.5 | 1024 | Code replacement | None |
| Mistral mistral-embed | 1024 | Code replacement | None |
| Jina jina-embeddings-v3 | 1024 | Code replacement | Yes (1M/month) |
| Nomic nomic-embed-text-v1.5 | 768 | Code replacement | Yes (1M/month) |

---

## Migrations

Run `npm run migrate` to execute unapplied migrations in order. History is managed in the `schema_migrations` table, and already-applied migrations are skipped.

| Number | File | Description |
|--------|------|-------------|
| 001 | migration-001-temporal.sql | Temporal (valid_from/valid_to, searchAsOf) |
| 002 | migration-002-decay.sql | Exponential decay (last_decay_at) |
| 003 | migration-003-api-keys.sql | api_keys + api_key_usage tables |
| 004 | migration-004-key-isolation.sql | fragments.key_id column (API key-based memory isolation) |
| 005 | migration-005-gc-columns.sql | GC policy indexes (utility_score, access_count) |
| 006 | migration-006-superseded-by-constraint.sql | fragment_links CHECK adds superseded_by |
| 007 | migration-007-link-weight.sql | fragment_links.weight column |
| 008 | migration-008-morpheme-dict.sql | Morpheme dictionary table (morpheme_dict) |
| 009 | migration-009-co-retrieved.sql | fragment_links CHECK adds co_retrieved |
| 010 | migration-010-ema-activation.sql | fragments.ema_activation/ema_last_updated columns |
| 011 | migration-011-key-groups.sql | Key groups (per-group fragment sharing) |
| 012 | migration-012-quality-verified.sql | quality_verified |
| 013 | migration-013-search-events.sql | search_events table |
| 014 | migration-014-ttl-short.sql | TTL short-lived tier |
| 015 | migration-015-created-at-index.sql | created_at index |
| 016 | migration-016-agent-topic-index.sql | agent/topic index |
| 017 | migration-017-episodic.sql | episodic type (1000 chars, context_summary, session_id) |
| 018 | migration-018-fragment-quota.sql | Fragment quota (default 5000) |
| 019 | migration-019-hnsw-tuning.sql | HNSW ef_construction 128, ef_search=80 |
| 020 | migration-020-search-layer-latency.sql | search_events layer latency columns |
| 021 | migration-021-oauth-clients.sql | OAuth clients table |
| 022 | migration-022-temporal-link-type.sql | Temporal link type CHECK constraint |
| 023 | migration-023-link-weight-float.sql | fragment_links.weight real type (float weights) |
| 024 | migration-024-workspace.sql | fragments.workspace VARCHAR(255) NULL |
| 025 | migration-025-case-id-episode.sql | fragments case_id + structured episode columns |
| 026 | migration-026-case-events.sql | case_events + case_event_edges + fragment_evidence tables |
| 027 | migration-027-v25-reconsolidation-episode-spreading.sql | search_events/case_events key_id type, fragment_links reconsolidation columns + link_reconsolidations table, case_events idempotency_key, fragments.keywords GIN index |
| 028 | migration-028-v253-improvements.sql | (agent_id, topic, created_at DESC) composite index, (key_id, agent_id, importance DESC) WHERE valid_to IS NULL partial index. Drops search_events.rrf_used and fragments.superseded_by columns |
| 029 | migration-029-search-param-thresholds.sql | search_param_thresholds table (SearchParamAdaptor online learning store) |
| 030 | migration-030-search-param-thresholds-key-text.sql | Unifies search_param_thresholds.key_id to the same TEXT type as fragments.key_id. The sentinel value is stored as the string '-1' |
| 031 | migration-031-content-hash-per-key.sql | 2 partial unique indexes on content_hash block cross-tenant ON CONFLICT paths. Master-only (key_id IS NULL) `uq_frag_hash_master`, API key (key_id IS NOT NULL) composite `uq_frag_hash_per_key` |
| 032 | migration-032-fragment-claims.sql | Symbolic Memory Layer fragment_claims table |
| 033 | migration-033-symbolic-hard-gate.sql | api_keys.symbolic_hard_gate BOOLEAN (symbolic hard gate opt-in) |
| 034 | migration-034-v2.16.0-bundle.sql | api_keys.default_mode TEXT NULL (per-key Mode preset default), fragments.affect TEXT DEFAULT 'neutral' CHECK 6-enum, fragments.idempotency_key TEXT NULL + 2 partial UNIQUE indexes |
| 035 | migration-035-morpheme-indexed.sql | fragments.morpheme_indexed BOOLEAN NOT NULL DEFAULT false + partial index, backfills existing fragments |
| 036 | migration-036-split-attempt-failed-at.sql | `fragments.split_attempt_failed_at TIMESTAMPTZ NULL` column + partial index, used for splitLongFragments failure backoff |
| 037 | migration-037-hnsw-index-rename.sql | Aligns the HNSW index name (idx_frag_embedding), applies ef_construction=128 |
| 038 | migration-038-fragment-versions-case-fields.sql | Adds `resolution_status`, `outcome`, and `phase` to `fragment_versions`, preserving the pre-amend case state in history |
| 039 | migration-039-feedback-instrumentation.sql | Adds `outcome`, `evaluator`, `evidence`, `unmet_requirements` (+ CHECK constraints on `outcome` and `evaluator`) to `task_feedback` and `irrelevance_reason` (+ CHECK constraint and partial index `idx_tf_irrelevance`) to `tool_feedback`. Existing rows are not backfilled, so NULL means "unreported" |

---

## Mode Preset Configuration

Locks the session operation scope to a preset. Three configuration paths are available, applied in the following priority order:

1. **Per-request header** (highest priority): `X-Memento-Mode: <preset>`
2. **initialize parameter**: `{ "method": "initialize", "params": { "mode": "<preset>" } }`
3. **Per-key default** (admin console): `api_keys.default_mode` column (migration-034)

| Preset | Description | Representative excluded_tools | Recommended context |
|--------|-------------|-------------------------------|---------------------|
| `recall-only` | Read-only. Write tools blocked | remember, batch_remember, amend, forget, link, reflect, memory_consolidate | Shared API keys with read-only grants; read-only dashboard integrations |
| `write-only` | Write-only. Search tools blocked | recall, context, reconstruct_history, graph_explore, fragment_history, search_traces, memory_stats | CI/cron jobs that only record results. Minimizes token consumption by hiding unnecessary retrieval tools |
| `onboarding` | New-user guidance. All tools exposed + beginner guide injected | (none — excluded_tools: []) | Auto-entered when fragment count is below 50; automatically transitions to normal mode once the threshold is exceeded |
| `audit` | Audit/compliance. Master key only. All writes blocked | remember, batch_remember, amend, forget, link, reflect | Operational audits, history reconstruction, memory statistics. `requiresMaster: true` |

Each preset's `fixed_tools` (explicit exposure list), `skill_guide_override` (tool guide override), and `requiresMaster` fields are defined in `lib/memory/modes/<preset>.json`.

When mode is unset or NULL, only the existing RBAC-based permission system applies.

See also: [API Reference — Mode Preset](api-reference.en.md#mode-preset)

---

## MCP Connection Settings

### Token-Based Session Reuse

Even if a client reconnects without `Mcp-Session-Id`, the server automatically recovers the existing session as long as the same Bearer token is presented. Useful when a session ID is lost or when reconnecting after a network interruption.

- Operates transparently on the client side: no additional configuration required
- On recovery, session context is preserved: keyId, groupKeyIds, workspace, permissions, etc.
- Valid only within the token TTL (`OAUTH_TOKEN_TTL_SECONDS`)

---

## Tests

### Full test suite (no DB required)
```bash
npm test          # Jest (tests/*.test.js) + node:test (tests/unit/*.test.js) sequential. tests/unit/ is node:test exclusive and excluded from Jest.
```

Individual runs:
```bash
npm run test:jest        # Jest -- tests/*.test.js
npm run test:unit:node   # node:test -- tests/unit/*.test.js
npm run test:integration # node:test -- tests/integration/*.test.js + tests/e2e/*.test.js
```

### E2E tests (PostgreSQL required)

Local Docker environment (recommended):
```bash
npm run test:e2e:local   # Starts test DB via docker-compose then runs
```

Using an existing DB connection:
```bash
DATABASE_URL=postgresql://user:pass@host:port/db npm run test:e2e
```

### Full CI (DB + Redis required)
```bash
npm run test:ci          # npm test && npm run test:integration
```

---

## Related Documents

- [Local Embedding Setup](embedding-local.md) — Detailed switching procedure for `EMBEDDING_PROVIDER=transformers`
- [Integration/E2E Tests](../tests/integration/README.md) — Test environment setup and execution
- [API Reference](api-reference.en.md) — MCP tool parameters and Mode preset details
- [Architecture](architecture.en.md) — Component dependencies and DB schema

### queryProfiles (intent-based search profiles)

Classifies a query as `EXACT_SYMBOL`, `CONCEPT_INTENT`, or `HYBRID` and switches several search knobs together: RRF layer weights, the semantic similarity threshold, the morpheme probe adoption condition, and the lexical weights used in final re-ranking. Configured in the `queryProfiles` block of `config/memory.js`; set `MEMENTO_QUERY_PROFILE_ENABLED=false` to disable.

| Profile | Trigger | l2 | l3 | minSimilarityDelta |
|-|-|-|-|-|
| `EXACT_SYMBOL` | code identifiers, paths, env vars, 3+ digit numbers | 1.6 | 0.9 | 0.0 |
| `CONCEPT_INTENT` | interrogatives, cause/method/procedure wording, no identifiers | 0.9 | 1.5 | -0.20 |
| `HYBRID` | mixed or undecidable | 1.0 | 1.1 | -0.06 |

The large threshold shift for `CONCEPT_INTENT` follows from the measured similarity distribution. With text-embedding-3-small, paraphrase pairs mixing Korean queries with English technical terms measured around 0.26 cosine, while the distribution against arbitrary fragments was p50 0.228 / p95 0.335. Keeping the 0.40 default kept correct fragments out of the candidate set entirely.

`ranking.importanceWeight` / `recencyWeight` / `semanticWeight` must sum to 1.0 and are enforced at startup, so they are not part of any profile.

### syntheticQuery (synthetic reverse-query augmentation)

Generates the questions a user is likely to ask when recalling a fragment and indexes them as auxiliary vectors. Body embeddings alone fail to surface a fragment when the stored wording and the recall wording diverge; this path closes that gap. Generation is delegated to the existing LLM chain (`LLM_PRIMARY` + `LLM_FALLBACKS`) with no separate provider or key.

| Key | ENV | Default | Description |
|-|-|-|-|
| `enabled` | `MEMENTO_SYNTHETIC_QUERY_ENABLED` | `false` | Generation. Off by default; set `true` to start the worker |
| `searchEnabled` | `MEMENTO_SYNTHETIC_QUERY_SEARCH` | `true` | Search use. `false` stops querying already stored auxiliary vectors |
| `minImportance` | `MEMENTO_SYNTHETIC_QUERY_MIN_IMPORTANCE` | `0.8` | Minimum importance for generation |
| `types` | `MEMENTO_SYNTHETIC_QUERY_TYPES` | `error,procedure,decision` | Eligible fragment types (comma separated) |
| `maxCallsPerMinute` | `MEMENTO_SYNTHETIC_QUERY_RPM` | `20` | LLM calls per minute, `0` for unlimited |
| `adoptLimit` | `MEMENTO_SYNTHETIC_QUERY_ADOPT` | `5` | Max fragments merged through the auxiliary path per search |
| `similarityDecay` | - | `0.85` | Decay applied to auxiliary hit similarity |

The two switches are independent: generation can be off while stored vectors are still searched, and vice versa.

Behaviour contract:

- Generation failures never affect fragment storage. Enqueue failures are swallowed and recovered by the worker's backfill collector.
- A generated query is accepted only if it preserves at least one proper noun, identifier, or number from the source. Queries introducing Han or kana characters absent from the source are discarded as language drift.
- The auxiliary probe runs in parallel with the body vector search. Running it sequentially would add a second vector query to every search and roughly double p95 latency.
- Auxiliary hits join with decayed similarity and skip fragments the body path already found.

`fragment_synthetic_query` is a separate table from `fragments` because `QuotaChecker` counts `fragments` rows against `fragment_limit`. It holds derived data and is regenerated by backfill if lost.

### consolidate.gate (consolidation safety gate)

Judges each semantic-dedup merge before it happens. Cosine similarity cannot distinguish sentences that differ only in a number or identifier (`max_connections 200` and `500` score above 0.99), so the gate checks that the distinctive tokens of the fragment being removed (numbers, identifiers, paths, versions) survive in the fragment being kept.

| Key | Default | Description |
|-|-|-|
| `enabled` | `true` | `false` restores the previous behaviour |
| `maxLostTokens` | `0` | Number of lost tokens tolerated |

Block reasons are `distinctive_token_loss`, `survivor_shorter`, and `cosine_below_floor`. Counts are exposed as `memento_consolidate_gate_blocked_total` (stage, reason) and `memento_consolidate_gate_allowed_total` (stage). The judgment happens before destruction, so no recovery path is needed.
