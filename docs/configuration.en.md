# Configuration

---

## Environment Variables

### Allowed Ranges

Values accepted by numeric, enumerated and boolean environment variables. Handling of non-numeric or out-of-range values follows the `MEMENTO_CONFIG_STRICT` row. A variable with a replacement value in the table uses that value when the input is out of range.

| Allowed range | Variables |
|-|-|
| Integer, 0 or more | CACHE_DB_TTL, CACHE_SESSION_TTL, DB_CONN_TIMEOUT_MS, DB_IDLE_TIMEOUT_MS, DB_QUERY_TIMEOUT, DB_STATEMENT_TIMEOUT_MS, EMBEDDING_MAX_RETRIES, EMBEDDING_SEM_WAIT_MS, HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, LLM_CB_OPEN_DURATION_MS, LLM_CHAIN_TIMEOUT_MS, LLM_CONCURRENCY_WAIT_MS, LLM_PROVIDER_TIMEOUT_MS, LLM_TOKEN_BUDGET_INPUT, LLM_TOKEN_BUDGET_OUTPUT, QUOTA_NEAR_LIMIT_MARGIN, REDIS_DB, REQUEST_TIMEOUT_MS, RERANKER_EXTERNAL_COOLDOWN_MS, SSE_RETRY_MS, TRUST_PROXY_HOPS |
| Number, 0 or more | MCP_IDLE_REFLECT_HOURS, UPDATE_CHECK_INTERVAL_HOURS |
| Integer, 1 or more | DEFAULT_DAILY_LIMIT, DEFAULT_FRAGMENT_LIMIT, FRAGMENT_DEFAULT_LIMIT, EMBEDDING_CONCURRENCY, EMBEDDING_DIMENSIONS, EMBEDDING_TIMEOUT_MS, LLM_CB_FAILURE_THRESHOLD, LLM_CB_FAILURE_WINDOW_MS, LLM_TOKEN_BUDGET_WINDOW_SEC, NLI_TIMEOUT_MS, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_PER_IP, RATE_LIMIT_PER_KEY, RATE_LIMIT_WINDOW_MS, RERANKER_TIMEOUT_MS, SESSION_TTL_MINUTES, SSE_MAX_HEARTBEAT_FAILURES |
| Integer, 2 or more | DB_MAX_CONNECTIONS |
| Integer, 1000 or more | SSE_HEARTBEAT_INTERVAL_MS |
| Integer, 1 to 65535 | POSTGRES_PORT, DB_PORT, REDIS_PORT |
| Integer, 0 to 65535 | PORT |
| Integer, 0 or more, anything else uses the default | MEMENTO_SHUTDOWN_DEADLINE_MS (60000), MEMENTO_SESSION_KEY_RECHECK_MS (30000), MEMENTO_DCR_MAX_PER_HOUR (100), MEMENTO_SCORE_UPDATE_BATCH (200, values above 10000 are capped at 10000) |
| Integer of at least 1, otherwise the default | MEMENTO_WM_FALLBACK_MAX_ROWS (2000) |
| Integer, 100 to 4500, anything else uses 2000 | MEMENTO_HEALTH_READY_DB_TIMEOUT_MS |
| Integer, 100 to 100000, anything else uses 4000 | MEMENTO_GC_MAX_DELETE_PER_CYCLE |
| Integer, 1000 to 600000, anything else uses 60000 | MEMENTO_GC_TIME_BUDGET_MS |
| Integer, 1 to 100, anything else uses 12 | MEMENTO_OUTBOX_MAX_ATTEMPTS |
| Integer, 1 to 3650, anything else uses 7 | MEMENTO_OUTBOX_RETENTION_DAYS, MEMENTO_OUTBOX_UNHANDLED_DAYS |
| Integer, 1 to 3650, anything else uses 400 | MEMENTO_AUDIT_RETENTION_DAYS |
| Integer, 0 to 720, anything else uses 24 | MEMENTO_KEY_ROTATION_GRACE_HOURS |
| Integer, 0 to 86400, anything else uses 60 | MEMENTO_KEY_LAST_USED_INTERVAL_SEC |
| Integer, 0 to 10, anything else uses 3 | MEMENTO_DB_LOCK_RETRY_MAX |
| Number, 1 or more, anything else uses `SESSION_TTL_MINUTES * 60` | OAUTH_ACCESS_TOKEN_TTL_SECONDS |
| Number, 0 to 1 (above 1 is capped to 1; negative and non-numeric values become 0) | MEMENTO_DECAY_MIN_DELTA, MEMENTO_UTILITY_MIN_DELTA |
| off, warn, enforce (any other value, including a whitespace-only value, behaves as enforce) | MEMENTO_TOOL_ARGS_VALIDATION |
| warn, enforce (any other value is warn) | MEMENTO_SESSION_ID_POLICY, MEMENTO_RESERVED_AGENT_IDS, MEMENTO_OAUTH_REDIRECT_CHECK |
| reflect, observe, allowlist (any other value is observe) | MEMENTO_CORS_MODE |
| allow, deny (any other value is allow) | MEMENTO_SSE_QUERY_KEY |
| deny (any other value adds no header) | MEMENTO_FRAME_OPTIONS |
| 401, 503 (any other value is 401) | MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS |
| inner, outer (any other value is inner) | MEMENTO_SEMANTIC_THRESHOLD_MODE |
| configured, local_only (any other value is configured) | MEMENTO_EGRESS_UNKNOWN_KEY |
| none, all (any other value is none) | MEMENTO_LLM_CLI_TOOL_APPROVAL |
| true, false (any other value is false) | MEMENTO_CONFIG_STRICT |
| true, false (any other value fails startup in `MEMORY_CONFIG` validation) | MEMENTO_AUTO_PROMOTE_ANCHORS (true) |
| on, off (any other value is off) | MEMENTO_ADMIN_AUTH_BACKOFF |
| on, off (any other value is on) | MEMENTO_WRITE_GATE, MEMENTO_OUTBOX, MEMENTO_OUTBOX_WORKER, MEMENTO_WM_PG_FALLBACK, MEMENTO_RANK_BEFORE_BUDGET, MEMENTO_GC_THROUGHPUT, MEMENTO_CONTEXT_ANNOTATE, MEMENTO_PROVENANCE, MEMENTO_REVIEW_QUEUE, MEMENTO_HOOK_ENDPOINTS, MEMENTO_FORGET_CASCADE, MEMENTO_EGRESS_POLICY, MEMENTO_AUDIT_DB |
| mask, reject, off (any other value is mask) | MEMENTO_SENSITIVE_SCAN |
| workspace, key (any other value is workspace) | MEMENTO_DEDUP_SCOPE |
| true, false (any value other than false is true) | MEMENTO_API_KEY_DELETE_GUARD, MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE, LLM_CONCURRENCY_ENABLED, MCP_REJECT_NONAPIKEY_OAUTH |
| true, false (any value other than true is false) | MEMENTO_LOG_STDERR, MEMENTO_REMEMBER_DUPLICATE_GUARD, MEMENTO_REMEMBER_ATOMIC, MEMENTO_WORKSPACE_GATE, MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN, ENABLE_RECONSOLIDATION, ENABLE_SPREADING_ACTIVATION, UPDATE_REQUIRE_SIGNED_TAG, MEMENTO_AUTH_DISABLED, REDIS_ENABLED, REDIS_SENTINEL_ENABLED, MEMENTO_REDIS_SESSION_FAIL_CLOSED, EMBEDDING_SUPPORTS_DIMS_PARAM, MEMENTO_RERANKER_ENABLED, MEMENTO_CASE_BACKPROP_ENABLED, UPDATE_CHECK_DISABLED, ENABLE_OPENAPI, MCP_ALLOW_AUTO_DCR_REGISTER, MCP_STRICT_ORIGIN |
| true, false (any value other than true takes the value of REDIS_ENABLED) | CACHE_ENABLED |

### Switch Report

The name, documented default, purpose and category of each feature switch are in the registry `config/switches.js`. Given an environment, it computes the value that is actually in effect for every switch. The parsing rules are the ones the readers use, and an invalid value is shown as the value the reader applies.

- Table output: `npm run switches` (`node scripts/switch-report.mjs`) prints a markdown table with switch, effective value, default, state, whether it differs from the default, category, exception class and purpose. It reads only the process environment and never reads a `.env` file. To report on a specific environment, load that environment into the shell first (`set -a; . <path to .env>; set +a; npm run switches`). The registry holds no keys, tokens or addresses, and an invalid raw value is never printed.
- Release gate: `npm run switches -- --strict` prints the table and then exits with code 1 when any switch has an invalid value (0 otherwise). Without the option the exit code is always 0. The names of the invalid switches go to stderr before exit.
- State column: `on` and `off` say whether a feature is enabled. `mode` marks an enum that selects a method rather than turning something on or off (`MEMENTO_CORS_MODE` and similar). A switch with an invalid value shows `값 오류` (invalid value) in the differs-from-default column and the value the reader applies in the effective-value column.
- Admin API: `switches` in the `GET /v1/internal/model/nothing/stats` response carries `total`, `on`, `off`, `mode`, `nonDefaultCount`, `nonDefault` (names of switches that differ from the default) and `invalid` (names of switches with an invalid value). No values are included.
- Startup log: one line `[Startup] switches: total=N on=N off=N mode=N nonDefault=N (name=on|off|enum value, ...) invalid=N (name, ...)`.
- New switches: a boolean or enum variable read with `envBool` or `envEnum` gets an entry in the registry and a row in `.env.example`, this document and the Korean version. `tests/unit/switch-ledger-structure.test.js` fails when an entry is missing. A variable that only selects a method, without opening or closing a feature, goes into that test's exclusion list with a reason.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 57332 | HTTP listen port |
| MEMENTO_ACCESS_KEY | (none) | Bearer authentication key. With it unset the server refuses to start and exits with code 78. To run without authentication you must also set `MEMENTO_AUTH_DISABLED=true` |
| MEMENTO_AUTH_DISABLED | false | When `true`, completely disables authentication and processes all requests with master privileges. Development/testing only. Only effective when `MEMENTO_ACCESS_KEY` is unset |
| DB_STATEMENT_TIMEOUT_MS | 30000 | Query time limit (ms) for user request paths. 0 means unlimited. Not applied to system and admin maintenance paths |
| REQUEST_TIMEOUT_MS | 60000 | Request receive limit (ms). 0 means unlimited |
| MEMENTO_CONFIG_STRICT | false | Reports problems in numeric, enumerated and boolean environment variables as one startup log line. A non-numeric value falls back to the default; a non-integer or out-of-range value is used as given and only reported (`MEMENTO_HEALTH_READY_DB_TIMEOUT_MS`, `MEMENTO_SHUTDOWN_DEADLINE_MS`, `MEMENTO_SCORE_UPDATE_BATCH`, `MEMENTO_SESSION_KEY_RECHECK_MS` and `MEMENTO_DB_LOCK_RETRY_MAX` fall back to the default when out of range). A whitespace-only value counts as unset. When `true`, startup stops with exit code 78 if any problem is found |
| KEEP_ALIVE_TIMEOUT_MS | 75000 | Keep-Alive connection lifetime (ms). Match the proxy setting |
| HEADERS_TIMEOUT_MS | 76000 | Request header receive limit (ms). Keep it larger than KEEP_ALIVE_TIMEOUT_MS |
| LOG_LEVEL | info (debug when NODE_ENV is not production) | winston log level |
| COMPRESSION_LEVEL | 6 | gzip compression level (0-9) |
| MIN_COMPRESS_SIZE | 1024 | Responses smaller than this many bytes are not compressed |
| MEMENTO_ROTATE_RATE_LIMIT_PER_MIN | 5 | Per-IP calls per minute for /session/rotate |
| MEMENTO_SPLIT_LLM_PRIMARY / MEMENTO_SPLIT_LLM_FALLBACKS | (none) | Dedicated LLM chain for long-fragment splitting. The global chain is used when unset |
| MEMENTO_VECTOR_FORCE_INDEX | (applied) | `off` disables the index-forcing planner hint for vector search |
| MEMENTO_SEMANTIC_THRESHOLD_MODE | inner | `outer` selects max(limit, 80) nearest neighbours first and applies the similarity threshold outside the KNN query |
| MEMENTO_SCORE_UPDATE_BATCH | 200 | Batch size for id-ordered importance decay and utility updates. 0 runs a single UPDATE statement. Only integers of 0 or more are accepted (a negative or non-integer value falls back to the default) and values above 10000 are capped at 10000. The `linked_to` cleanup of `forget` always locks rows in id order regardless of this value |
| MEMENTO_DB_LOCK_RETRY_MAX | 3 | Maximum number of times a write transaction that locks several fragment rows is re-run from the start after a deadlock (40P01) or lock timeout (55P03). The wait before a retry starts at 25 ms, doubles per retry up to 400 ms, and is a random value between half of that bound and the bound. 0 disables retries. Only integers from 0 to 10 are accepted; anything else uses the default. Retries are exposed as `memento_db_deadlock_retries_total` (operation label) |
| MEMENTO_DECAY_MIN_DELTA | 0 | Skips rows whose decay change is below this value; rows last decayed more than 24 hours ago are always updated (rows at the 0.05 floor are therefore rewritten about every fourth cycle). Non-numeric or negative values are treated as 0 with a warning, and values above 1 are capped to 1. Ignored when `MEMENTO_SCORE_UPDATE_BATCH` is 0 |
| MEMENTO_UTILITY_MIN_DELTA | 0 | Skips utility_score rewrites when the stored value differs by at most this value. Non-numeric or negative values are treated as 0 with a warning, and values above 1 are capped to 1. Ignored when `MEMENTO_SCORE_UPDATE_BATCH` is 0 |
| MEMENTO_GC_THROUGHPUT | on | Expired fragment cleanup throughput switch. With `on`, the `expired_delete` stage repeats the candidates in chunks of 100 and stops at whichever comes first: the per-cycle delete cap (`MEMENTO_GC_MAX_DELETE_PER_CYCLE`), the time budget (`MEMENTO_GC_TIME_BUDGET_MS`) or running out of candidates. Each chunk runs in its own transaction that locks the target rows in id order and then deletes only the locked rows (lock wait limit 3 seconds; a deadlock or lock wait timeout re-runs the transaction up to `MEMENTO_DB_LOCK_RETRY_MAX` times). When a chunk fails, the stage returns the number deleted so far and the next cycle continues. When another cycle or a `forget` removes rows in the middle of a chunk, that chunk deletes fewer rows than asked and the cycle may end early (safe; the next cycle continues). The chunk's lock wait limit also bounds the cascade deletes in `fragment_links` and the version rows, and with retries (`MEMENTO_DB_LOCK_RETRY_MAX`) one chunk can wait about 12 seconds beyond the time budget. With `off`, `gc.maxDeletePerCycle` (50) rows are deleted per cycle in one statement. Read at call time |
| MEMENTO_GC_MAX_DELETE_PER_CYCLE | 4000 | Maximum number of expired fragments one cleanup cycle deletes (`CONSOLIDATE_INTERVAL_MS`, default 6 hours). The default is at least twice the 30-day daily average fragment inflow (about 1900). Only integers from 100 to 100000 are accepted; anything else uses the default. Not used when `MEMENTO_GC_THROUGHPUT=off`. Read at call time |
| MEMENTO_GC_TIME_BUDGET_MS | 60000 | Time (ms) within which one expired-cleanup cycle may start new chunks. A chunk always runs to completion. Only integers from 1000 to 600000 are accepted; anything else uses the default. Not used when `MEMENTO_GC_THROUGHPUT=off`. At the end of each cleanup the number of remaining expired candidates (an approximation that stops counting at 100000) is recorded in the `memento_gc_backlog` gauge. The gauge keeps the value of whichever concurrent cleanup cycle wrote last and reads 0 before the first cycle. Read at call time |
| MEMENTO_RUNTIME | (none) | `docker` marks the installation as Docker |
| GITHUB_TOKEN | (none) | GitHub API authentication token for update checks |
| WORKER_ID | single | workerId shown in the health response |
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
| MEMENTO_AUTO_PROMOTE_ANCHORS | true | When `false`, skips only automatic anchor promotion; existing anchors and other stages are unchanged |
| EVALUATOR_MAX_QUEUE | 100 | MemoryEvaluator queue size cap (older jobs dropped on overflow) |
| OAUTH_TRUSTED_ORIGINS | (none) | Additional OAuth redirect_uri trusted domains (comma-separated, origin level). Added on top of default trusted domains (claude.ai, chatgpt.com, platform.openai.com, copilot.microsoft.com, gemini.google.com). Only specify additional origins to allow |
| MCP_STRICT_ORIGIN | false | When `true`, enables strict Origin header validation (DNS rebinding defense). Requests from Origins not in the allowlist (`OAUTH_TRUSTED_ORIGINS` + `ALLOWED_ORIGINS` + default trusted domains) are rejected with 403. Requests without an Origin header (CLI/curl) are always allowed. **opt-in** — defaults to `false` to preserve existing behavior |
| MEMENTO_CORS_MODE | observe | Cross-origin response mode when `ALLOWED_ORIGINS` is unset. `reflect`: echoes the request Origin. `observe` (default): same response as `reflect`, and logs each newly seen Origin as `[CORS] cross-origin request from` (up to 256 per process). `allowlist`: sets `Access-Control-Allow-Origin` only for the default trusted domains and `OAUTH_TRUSTED_ORIGINS`. Responses to requests with an Origin carry `Vary: Origin`. When `ALLOWED_ORIGINS` is set, the list takes precedence regardless of mode. Read at call time, so changes apply without a restart |
| MEMENTO_FRAME_OPTIONS | (none) | When `deny`, every response carries `X-Frame-Options: DENY`. Unset or any other value adds nothing. `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` are always sent on every response |
| MEMENTO_OAUTH_REDIRECT_CHECK | warn | Redirect target check for `/authorize` error responses. `warn` (default): redirects to an unregistered `redirect_uri` and logs an `error redirect target not registered` warning containing only the target host. `enforce`: returns a 400 JSON instead of redirecting. A missing or non-URL `redirect_uri` gets a 400 JSON in both modes |
| MEMENTO_SSE_QUERY_KEY | allow | Legacy SSE `?accessKey=` query key handling. `allow` (default): accepted for the master key only. `deny`: not accepted; returns 401 pointing to the `Authorization` header. Query values are recorded in proxy access logs |
| MCP_REJECT_NONAPIKEY_OAUTH | true | The default `true` rejects authentication with `is_api_key=false` OAuth tokens. `false` permits that authentication only and never grants master privileges. OAuth sessions without an API-key binding receive `-32001` on tool calls. API-key-based OAuth tokens (`is_api_key=true`) and direct Bearer ACCESS_KEY use are unaffected |
| MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS | 401 | Response status for MCP `initialize` and session auto-recovery when an `api_keys` lookup failed and authentication could not be decided. `401` (default) matches the invalid-key response, and session recovery answers 404. `503` adds `Retry-After: 10`. Master key authentication does not depend on the store. Lookup failures are counted in `mcp_auth_store_errors_total{operation}` and `memento_auth_denied_total{reason="store_unavailable"}` |
| MEMENTO_SESSION_ID_POLICY | warn | How MCP session ids are received. `warn` (default): a session id received in the query string (`?sessionId=`, `?mcp-session-id=`) and auto-recovery of an id that is not in the server-issued format (UUID) are logged as `[Session] session id received in query string` and `recovery requested for non-issued id format` warnings and processed normally. `enforce`: a query-string id gets 400, and recovery of a non-UUID id gets 404. UUID sessions sent in the `MCP-Session-Id` header are unaffected by either value. Session ids in logs and the reflect prompt show only the first 8 characters. Sessions recovered with a client-chosen id during the `warn` period keep working after the switch to `enforce` until they expire. Legacy `/message?sessionId=` is required by the protocol and is not covered |
| MCP_ALLOW_AUTO_DCR_REGISTER | false | Set to `true` to allow `/authorize` to auto-register an unregistered `client_id` whose `redirect_uri` is not in the trusted list (default trusted origins, `OAUTH_TRUSTED_ORIGINS`, `OAUTH_ALLOWED_REDIRECT_URIS`, localhost). The default `false` rejects that case with `invalid_client` and requires RFC 7591 `POST /register`. A `redirect_uri` in the trusted list is registered automatically regardless of this value |
| OAUTH_ALLOWED_REDIRECT_URIS | (none) | OAuth redirect_uri exact-match allowed list (comma-separated). Operates independently of OAUTH_TRUSTED_ORIGINS |
| MEMENTO_DCR_MAX_PER_HOUR | 100 | Hourly cap on `/register` (fixed window, per process). Registrations that present a valid API key as Bearer (key-bound registrations) and all other registrations use the same cap value but are counted separately. Above the cap the response is 429 with `Retry-After` set to the seconds remaining in the current window (rounded up, at least 1). `0` disables the cap. Read at call time |
| DEFAULT_DAILY_LIMIT | 10000 | Default daily call limit when creating API keys |
| DEFAULT_PERMISSIONS | read,write | Default permissions when creating API keys |
| DEFAULT_FRAGMENT_LIMIT | (none) | Default fragment quota when creating API keys. Unlimited when unset |
| FRAGMENT_DEFAULT_LIMIT | 5000 | Integer, 1 or more. The value is read and checked at startup but no processing uses it. The default quota for new API keys is set by `DEFAULT_FRAGMENT_LIMIT` |
| DEDUP_BATCH_SIZE | 100 | Semantic deduplication batch size |
| DEDUP_MIN_FRAGMENTS | 5 | Minimum fragment count for dedup. Deduplication is skipped below this threshold |
| COMPRESS_AGE_DAYS | 30 | Memory compression target inactive days |
| COMPRESS_MIN_GROUP | 3 | Minimum compression group size. Groups below this threshold are not compressed |
| MEMENTO_RERANKER_ENABLED | false | Enables the in-process cross-encoder reranker. It is off by default: the default model is English-only, and on a Korean corpus an ablation showed turning it off improves Recall@1 from 74% to 85%, MRR from 0.827 to 0.890, and p50 latency from 561ms to 126ms. External rerankers configured through `RERANKER_URL` work regardless of this switch |
| RERANKER_MODEL | minilm | ONNX model used when the in-process reranker is enabled. `minilm` (default, ~80MB, English-only) or `bge-m3` (~280MB, multilingual). bge-m3 ranks non-English text far better but takes several seconds to rerank 30 candidates on CPU, so use it only behind a GPU-backed external service |
| RERANKER_EXTERNAL_FALLBACK | skip | Policy applied after 3 consecutive external reranker failures. `skip` (default): no switch to in-process — external calls are simply skipped for `RERANKER_EXTERNAL_COOLDOWN_MS`, and original scores (RRF order) are returned as-is. `inprocess`: switches to the ONNX in-process model (opt-in, the previous behavior) |
| RERANKER_TIMEOUT_MS | 5000 | External reranker call timeout (ms) |
| NLI_SERVICE_URL | (none) | External NLI service URL. When unset, the in-process ONNX model is used |
| NLI_TIMEOUT_MS | 5000 | External NLI call timeout (ms) |
| RERANKER_EXTERNAL_COOLDOWN_MS | 60000 | Cooldown duration (ms) when `RERANKER_EXTERNAL_FALLBACK=skip`. After the window expires, the next recall retries the external call once; success resumes normal operation, failure re-enters cooldown |
| QUOTA_NEAR_LIMIT_MARGIN | 10 | Remaining-quota threshold at which `QuotaChecker.check()` switches to the precise FOR UPDATE check. The transaction lock is only acquired when `remaining` is at or below this value; above it, the check passes using the 10-second TTL cache (getUsage) without locking |
| ENABLE_RECONSOLIDATION | false | Enable ReconsolidationEngine. When true, tool_feedback and contradicts detection dynamically update fragment_links weight/confidence |
| ENABLE_SPREADING_ACTIVATION | false | Enable SpreadingActivation. When true, the contextText parameter in recall proactively activates related fragments. Recommended to measure latency impact before enabling |
| ENABLE_PATTERN_ABSTRACTION | (unused) | Reserved for pattern abstraction. No code reads this variable, so setting it has no effect |
| MEMENTO_METRICS_DEFAULT | (none) | Set to `off` to skip prom-client default metrics (CPU, memory, …). Any other value keeps collection on |
| MEMENTO_ADMIN_AUTH_BACKOFF | `off` | When `on`, after 5 consecutive admin authentication failures each further failure delays the next attempt by 1, 2, 4 seconds and so on up to 60 seconds. While the delay is active even the correct master key receives 429 (Retry-After) for the delay duration on `POST /auth` and the admin API routes. The admin UI shell and the image paths keep returning 401 while the delay is active. Existing cookie sessions are not affected. Failed Bearer requests against admin routes that present a key other than the master key, such as an ordinary API key, count as failures. After 60 seconds without a failure the counter starts over, and a successful authentication also clears it. Failure records are written regardless of this value, and the state lives in process memory |
| MEMENTO_ADMIN_METRICS_SAMPLING | (none) | Set to `off` to disable admin console metric sampling. Any other value keeps sampling on |
| UPDATE_CHECK_DISABLED | false | Set to `true` to skip new-version checks |
| UPDATE_CHECK_INTERVAL_HOURS | 24 | New-version check interval (hours) |
| UPDATE_REQUIRE_SIGNED_TAG | false | When `true`, the install step of a git-based update runs `git verify-tag <target tag>` before checkout. The update stops if verification fails |
| TRUST_PROXY_HOPS | (unset) | Number of trusted reverse-proxy hops. The Nth entry from the right of the `X-Forwarded-For` chain is taken as the client address; `0` ignores the header and uses the socket address. Unset keeps the previous behavior (first entry); in that state the first `X-Forwarded-For` header received logs a one-time `[Proxy]` warning and adds `trust_proxy_hops_unset` to `healthFlags` in the admin `/stats`. At startup one `[Startup] Recommended settings not applied:` line lists the recommended settings that are missing. It must equal the real proxy count; a larger value makes a client-supplied entry win. Use `1` behind a single nginx |
| MEMENTO_TOOL_ARGS_VALIDATION | warn | Mode for checking tools/call arguments against the tool inputSchema. `off`: skip, `warn`: log violations as `[ToolArgs]` warnings (with caller fields `key=`, `sid=` first 8 characters, `ua=` first 64 characters) and continue, `enforce`: reject with JSON-RPC `-32602`. An empty string counts as unset (`warn`), but a whitespace-only value is invalid and applies `enforce` (with `MEMENTO_CONFIG_STRICT=true` startup exits with code 78). Read at call time, so changes apply without a restart |
| MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN | false | When `true`, fields absent from the schema are not counted as violations. Use it under `enforce` to accept clients that send alias fields |
| MEMENTO_LLM_CLI_ENV_PASSTHROUGH | (unset) | Comma-separated environment variable names to pass to CLI provider child processes (gemini-cli, codex-cli, copilot-cli, qwen-cli, agy-cli, opencode-cli) in addition to base variables such as PATH and HOME and the per-CLI credential variables |
| MEMENTO_LLM_CLI_TOOL_APPROVAL | none | Tool execution approval mode for gemini-cli, copilot-cli and opencode-cli (`none`, `all`). Read at call time; any other value is treated as `none` and recorded as a config issue. `none`: gemini runs without `-y`, copilot adds `--deny-tool=shell`, `--deny-tool=write`, `--deny-tool=url`, `--disable-builtin-mcps` and `--no-custom-instructions` (it keeps `--allow-all-tools`, which non-interactive mode requires; deny rules always take precedence), opencode receives `OPENCODE_PERMISSION={"*":"deny"}`, and gemini gets `GEMINI_CLI_TRUST_WORKSPACE=true` in its child environment to mark the temp directory as a trusted workspace. All three run in an empty temp directory instead of the server working directory (for opencode the `--dir` value is the caller-supplied `cwd` when given). `all`: gemini uses `-y`, copilot uses `--allow-all-tools` only, opencode gets no approval-related setting, and the server working directory is used. Deployments that use gemini-cli, copilot-cli or opencode-cli get a restricted invocation by default; `all` selects the invocation without approval restrictions. Not applied to codex-cli, qwen-cli or agy-cli |
| MEMENTO_REMEMBER_ATOMIC | false | When true, atomizes the quota check + INSERT in remember() into a single transaction. Sequence: BEGIN → api_keys FOR UPDATE (quota re-validation) → INSERT → COMMIT, fully eliminating TOCTOU. false (default) performs only a pre-check and is appropriate for environments with low concurrent request volume |
| MEMENTO_REMEMBER_DUPLICATE_GUARD | false | When `true`, a remember call that resolves to an existing fragment returns `existing` and `duplicate` (same_scope, other_workspace, closed, unknown) without post-processing, TTL changes or re-indexing of that fragment. When two identical stores race, the existing row can still have its importance raised to the larger value and its access time refreshed by the insert's conflict path. A same-scope hit (same workspace or a global fragment) carries `duplicate_of` (the existing fragment id) in the response regardless of this value. `other_workspace` only occurs under key-scope detection (`MEMENTO_DEDUP_SCOPE=key` or while the key-scope index remains) |
| MEMENTO_API_KEY_DELETE_GUARD | true | Refuses API key deletion with 409 while the key still owns fragments or link reconsolidation records. `false` deletes without the check |
| MEMENTO_CASE_BACKPROP_ENABLED | false | When true, enables CaseRewardBackprop, which back-propagates tool_feedback reward signals along case_id fragment chains. Adjust importance scores of cause fragments based on outcome quality |
| MEMENTO_STORAGE | pgvector | Storage backend name. Currently `pgvector` only; this value does not affect behavior. |
| MEMENTO_RANK_BEFORE_BUDGET | on | recall budget selection switch. With `on`, the search layer returns candidates without a token budget cut, recall merges linked fragments, scores every item with the final score (`computeRecallScore`) and then selects within `tokenBudget`. When the exact token sum of the candidates fits the budget, all are kept without any cap (counting stops as soon as the running sum in search order exceeds the budget, so a binding budget costs roughly one budget of counting). When the budget binds, the candidates are the top 200 in search order plus the fragments the search-order cut keeps beyond them, and selection uses token estimates (an exact count made in the same request, the stored `estimated_tokens`, otherwise content length / 4 rounded up). The estimates depend only on the request input and never on token counts cached by earlier requests, so the same request gives the same result across pages and repeated calls. The stored token counts are read with one query per binding recall for the ids of the first 600 items in search order (`getStoredTokenCounts`, one primary key lookup). Selection: for each section (exact match, keyword supplement, linked, other) one item that fits the remaining budget and has a final score above 0 is taken first (highest final score), then the rest is filled in order of MMR gain (relevance weight 0.7) per token; of the solution that starts empty and the solution that starts from the search-order cut computed with the same estimates, the one with the larger final score sum (summed in id order) is used. With more than 210 candidates (200 plus the linked fragment limit), no solution is built and the search-order cut is used as is (the selection function itself is capped at 600 items). The items of the search-order cut are counted exactly and fitted to the budget, which gives the verified baseline. The selected items are then counted exactly; if their sum exceeds the budget, items outside the verified baseline are dropped first, smallest final score per token first (ties: lower score, then larger id). When the exact final score sum of the selection is below that of the verified baseline, the verified baseline is used. The guarantee depends on the query class: for untagged queries (no exact keyword or supplement tags) the cut boundary is counted exactly including superseded fragments, so the verified baseline equals the `off` cut and the final score sum is at least that of `off`. Tagged queries are only guaranteed to be at least the verified baseline; in seeded tests with mixed stored token counts about 1.2% of them (8 of 692, all with superseded fragments included) scored below the `off` cut. Stored token counts are used for selection only, never returned, and not read on the `off` path. Linked fragments are looked up from the candidates the search-order cut keeps and are selected within the budget too. The number of items that entered budget selection and the number kept are recorded in `search_events.candidate_count` and `budget_kept` (migration 051). With `off`, the search layer cuts the budget in search order with exact token counts and linked fragments are added outside the budget. When all candidates fit the budget, `on` and `off` return the same result; the differences otherwise are: when the budget binds, candidates past search rank 200 that the search-order cut does not keep are not considered; linked fragments count against the budget, so when the search candidates fit but the linked fragments do not, `on` drops some items while `off` returns more than the budget; a superseded fragment that arrived through the cache is not counted in `totalTokens` with `on` (`off` counts the tokens of that fragment although it is not returned); with `MEMENTO_SYMBOLIC_CBR_FILTER` and a `caseId`, the linked lookup starts from the candidates before the CBR filter (`off`: after it). Apply migration 051 before or together with the code. Until it is applied, search events are recorded without the two columns (one warning, the columns are checked again every 5 minutes), and once it is applied the columns are filled without a restart. Read at call time |
| MEMENTO_KEYWORD_SEMANTIC_FALLBACK | true | Set `false` to disable the L3 semantic supplement for keywords-only recall queries without text. When active, one embedding of the normalized keywords text runs in parallel with L2, recovering fragments whose stored keywords lack the query terms via content matching |
| MEMENTO_KEYWORD_FALLBACK_TIMEOUT_MS | 1500 | Upper bound (ms, clamped 100-60000) for the keyword-supplement L3 run. On timeout it resolves to an empty result and leaves `L3kw:timeout` in searchPath |
| MEMENTO_CONTEXT_ANCHOR_LIMIT | 20 | Overall maximum number of anchor (isAnchor) fragments always included in context responses. The default changes from 10 to 20. Clamped to 1-30; falls back to 20 on parse failure. Anchors are not trimmed by tokenBudget, so this count cap is the only injection limit. Set 10 to retain the prior injection count |
| MEMENTO_CONTEXT_ANNOTATE | on | context injection line annotation switch. With `on`, each memory line of `injectionText` (anchor, core, learning, working) ends with ` (YYYY-MM-DD, assertion)`. The date is the UTC storage date (`created_at`, the time the item was added for working memory items); relative dates are not used. The assertion is shown only when the stored `assertion_status` is one of `observed`, `inferred`, `verified`, `rejected`; otherwise only the date is shown. Header strings (`[ANCHOR MEMORY]`, `[CORE MEMORY]` and so on) and the `- ` line prefix do not change. The date changes at UTC midnight, so a memory stored between 00:00 and 08:59 KST shows the previous date (there is no time zone setting). With `on`, non-anchor selection adds a fixed annotation cost of 6 per memory line (the longest annotation, 23 characters, as characters / 4 rounded up; with `MEMENTO_PROVENANCE=on` 11, for 41 characters including the origin tail `, external_content` of 18 characters) within `tokenBudget`, so fewer fragments may be selected than with `off` for the same budget. Anchors and the minimum guaranteed slots are included regardless of the budget. `totalTokens` counts content only. The fields of the anchor fragments in the response are unchanged. With `off`, lines end with the content. Read at call time |
| MEMENTO_CONTEXT_WORKSPACE_ANCHOR_RESERVE | 10 | Slots reserved first for the highest-importance anchors in the effective workspace. When unset, derived as `floor(total / 2)` (capped at 10): 10 for the default total of 20 and 5 for a custom total of 10. An explicit value must be an integer from 0 through the total or startup validation fails. Not applied when no workspace is effective |
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
| MEMENTO_SESSION_KEY_RECHECK_MS | 30000 | Interval (ms) at which a session re-reads its API key state. Sessions of inactive, deleted, revoked or expired keys, session requests from an address outside the key's allowed blocks (`allowed_cidrs`), and sessions created before the overlap end of a key rotation are closed (legacy SSE sessions included); permission changes reach open sessions. `0` disables the recheck. Only integers of 0 or more are accepted, anything else falls back to the default |
| MEMENTO_KEY_ROTATION_GRACE_HOURS | 24 | Hours the previous key keeps authenticating after a key rotation (`POST /keys/:id/rotate`) whose body has no `graceHours`. `0` refuses the previous key at once. Read at call time. Integer from 0 to 720, any other value uses 24 |
| MEMENTO_KEY_LAST_USED_INTERVAL_SEC | 60 | An API key's `last_used_at` and `last_used_ip_hash` (an HMAC fingerprint of the request address keyed with the master key) are written at most once per this interval (seconds) per key. The daily usage (`api_key_usage`) is still added on every request. `0` writes on every request. Counted per process. Read at call time. Integer from 0 to 86400, any other value uses 60 |
| MEMENTO_SEGMENT_IDLE_MS | 2700000 | When session idle time exceeds this value (ms), the segment rotates on the next tool call. Default 45 minutes |
| MEMENTO_SEGMENT_MAX_AGE_MS | 43200000 | When a segment's age exceeds this value (ms), it rotates regardless of idle state. Default 12 hours |
| MEMENTO_SEGMENT_MIN_ACTIVITY | 3 | Minimum activity (fragments + tool calls) required in the previous segment for AutoReflect to fire on segment rotation |
| MEMENTO_WORKSPACE_GATE | false | When `true`, includes `fragmentHasWorkspace` violations (workspace could not be resolved from an explicit value or the key default) in the hard-gate-eligible set. By default only a warning is recorded and storage is not blocked. Actual blocking still requires `MEMENTO_SYMBOLIC_POLICY_RULES` to be enabled and the key to have `api_keys.symbolic_hard_gate=true` |
| MEMENTO_WRITE_GATE | on | Semantic write gate switch. With `on`, remember, amend, batch_remember, reflect-derived writes, AutoReflect, admin import, CLI import, the CLI remember local mode and consolidation split children all pass the same gate (normalization, sensitive data masking, per-type length limit, PolicyRules, workspace permission, anchor permission) outside any transaction. Violations are kept as `validation_warnings` and only keys with `api_keys.symbolic_hard_gate=true` are rejected. With `off`, each entry point applies only its base steps (remember: all, amend: input size limit and keyword normalization, batch_remember, reflect and CLI remember: normalization, masking and truncation, imports and consolidation split children: none). `off` does not change the write path of imports and the CLI remember local mode (FragmentWriter duplicate detection, the per-type importance cap and the full sha256 content_hash apply regardless of the switch). Read at call time |
| MEMENTO_SENSITIVE_SCAN | mask | Detection mode for secrets and personal data in written values. Scanned fields are content, topic, contextSummary, goal, outcome (context_summary on amend) and the keywords array; keywords are scanned as given, before lowercasing. With `mask`, values matching the rule table (sk-ant-, sk-proj-, generic sk-, GitHub ghp_ gho_ github_pat_, AWS AKIA ASIA, Slack xox tokens, JWT, PEM private key blocks, mmcp_ keys, Bearer tokens, Korean resident registration numbers, card numbers, email addresses, password fields, mobile phone numbers) are replaced by markers before storage. Email addresses and phone numbers are only masked; every other detection keeps only the rule name and field names in `validation_warnings` (`sensitive.<rule>`). The matched text is never recorded, and the persisted `validation_warnings` column of a stored fragment also holds rule names only. `sensitive.*` warnings are informational: the server has already masked the text, so do not retry. Keys with `api_keys.symbolic_hard_gate=true` reject the write on high-confidence rules (every rule except email addresses and phone numbers: password fields, API key patterns, tokens, private keys, resident registration numbers, card numbers) with `-32003`. Deployments that use hard gate keys should check, before upgrading, that clients handle `sensitive.*` violations in `-32003`, and turn `symbolic_hard_gate` off for keys that should only mask. A resident registration number is detected when its check digit matches; as an exception to the check digit requirement, the hyphenated form with gender digit 3 or 4 and a birth date from 2020-10-01 up to today is also detected (numbers issued from that date are random and carry no check digit). A card number is 13 to 19 digits with a known issuer prefix that pass the Luhn check; a contiguous digit run needs a card word (card, 카드, visa, mastercard, amex, cvc, cvv, 신용) within 24 characters before or after it, and 13-digit barcodes (starting with 880 or with a matching EAN-13 check digit) are excluded. A PEM private key is masked only when at least 40 base64 characters of key material follow the header (including a one-line key whose newlines became spaces or escaped `\n`); without a closing line, only the header and the base64 lines that follow are masked. With `reject`, every key (master key included) rejects on the same high-confidence detections (dryRun does not reject and returns the rule names). With `off`, the new rules and the checks outside content are disabled and only the legacy rules (API key, email, password field, mobile phone number) apply to content, on every write path (the gate, session-scope remember, reflect items, split creation). With `MEMENTO_WRITE_GATE=off` the scan behaves as `off` regardless of this value. Log masking uses the log entries of the same rule table. Read at call time |
| MEMENTO_PROVENANCE | on | Fragment provenance and trust tier switch. With `on`, the semantic write gate stores on every created fragment `origin` (the source claimed by the client: `user_stated`, `agent_inferred`, `tool_output`, `external_content`, `consolidation`, `import`), `observed_client` (the initialize `clientInfo.name` observed by the server, reduced to a token of at most 64 characters of ASCII letters, digits, spaces and `. _ : + -`, and the write entry name, for example `claude-code/remember`) and `trust_tier` (0 quarantined, 1 low, 2 normal, 3 high). A client claim is accepted only through the `origin` argument of remember and of batch_remember items; imports get `import`, consolidation split and AutoReflect get `consolidation` from the server. The tier is the smaller of the claimed origin tier (user_stated 3, external_content 1, others 2, no claim 2) and the key cap. The key cap is 3 when the key permission list contains `trusted_origin` or for the master key, otherwise 2. `assertionStatus` (verified included) does not affect the tier and amend does not change it. Fragments with tier 1 or lower are left out of the ANCHOR and CORE injection of context. Recall response fragments carry `origin` and `trust_tier`, the answer pack opening line carries `origin=`, and the context injection line annotation carries the origin value (only when a value exists). Core also leaves out fragments whose tier could not be confirmed (lookup failure, ids missing from the lookup result) and reports them in `_meta.coreSelection` and `memento_context_core_trust_excluded_total{reason}`. Consolidation split children get the parent tier, and contradiction audit fragments get the lower tier of the two source fragments (1 when it cannot be confirmed), as the key cap. AutoReflect and reflect-derived fragments do not inherit. Existing rows with a NULL `trust_tier` are read as 2 and are not backfilled. Migration-057 adds the columns. With `off`, the three columns are neither written nor read, so responses and injection are the same as before the switch. Read at call time |
| MEMENTO_REVIEW_QUEUE | on | Non-blocking review queue switch. With `on`, the semantic write gate does not reject writes of remember, batch_remember, reflect and amend that match a review rule; it stores them with `review_state='pending'` and `review_reason` (the list of reasons). Only synchronous rules decided before the response are used: agent instruction override phrases in content, context summary, goal, outcome or topic (narrow rules such as ignoring previous instructions, redefining the system prompt and chat template markers; ordinary procedural sentences are not targeted, `instruction_override`), anchors, preferences and procedures with trust tier 1 or lower (`low_trust_directive`, creation only), and anchor requests without permission that the anchor permission warn period stores as regular fragments (`anchor_unauthorized`). The reasons also appear in the response `validation_warnings` as `review.<reason>` and are not hard gate rejections. A pending fragment is visible in the writing key's recall with the markers `pending_review: true` and `low_trust: true`, and is left out of other keys' (key groups included) and the master key's recall, id lookups, supersession chains, link expansion and topic suggestions, of the ANCHOR, CORE and working memory injection, automatic anchor promotion and contradiction resolution. Rejected fragments follow the same rule, so even `includeSuperseded` lookups show them to the writing key only (`review_rejected: true`). The `review_off` marker in a key's permission list turns flags off for that key and `review_all` puts every write of that key into review (`mode_all`). Keys without a marker and the master key use the flagged mode. Secrets and personal data are not review items: the sensitive data step masks or rejects them first, so no pending fragment keeps an original. The admin API `/review` approves (`approved`) or rejects (`rejected`, sets `valid_to`) and records the decision in `memory_review_decisions` and the audit log. Approval applies a held anchor request only when the decision-time check passes (the key permission list holds `anchor` or `admin`; the master key is allowed), and an unauthorized anchor request (`anchor_unauthorized`) only when the admin passes `applyAnchor: true`. Fragments left undecided for 30 days are rejected automatically. Migrations 057 and 058 add the columns and the table. `off` only stops flagging new writes. The visibility predicates for fragments already pending or rejected (rows with a NULL review_state always pass), the 30-day automatic rejection and the anchor hold on pending fragments stay active. A full rollback is a code revert; the earlier version rejects permission edits of keys that carry `review_off` or `review_all`, so remove those markers before reverting. Read at call time |
| MEMENTO_WM_PG_FALLBACK | on | Working memory PostgreSQL fallback switch. With `on`, while Redis is not ready, `remember(scope=session)` passes the same semantic write gate and is stored as a working memory row in `fragments` (`source=wm-fallback`, `ttl_tier=short`, `session_id` set, written already excluded from live queries). The WORKING section of `context`, session synthesis (`reflect` with `sessionId`), removal of consumed items and agent deletion read and delete the same rows. Even when Redis is ready, rows of the same session are merged with the Redis items when they exist (an item whose Redis write failed and went to a row, or items written during an outage after Redis came back). When merging, items with the same id, or the same text for the same agent and key, appear once. The extra cost of this read is one lookup using `idx_fragments_session_id`; with no rows the result equals the Redis-only result. The rows do not appear in `recall` (including reads that include closed fragments), graph exploration, consolidation, quota counts, admin console totals and lists, CLI `stats`, exports or startup check figures; reads see only rows created within 24 hours, and the cleanup cycle deletes rows older than 24 hours, 100 rows per separate transaction (lock wait 3 seconds, at most 50 chunks per run). A cleanup failure does not stop the ordinary fragment cleanup. Session synthesis (`reflect` with `sessionId`) collects and evicts only items of the calling key (items without `key_id` when there is no key) and agent scope (that agent and default) even when the session id is shared (Redis items likewise). This holds for the master key too: the WORKING section of `context` shows master the items of every key in the session, while session synthesis collects only items without `key_id`. `memory_stats` and remote CLI `stats` figures do not count these rows either. Nothing deletes the rows when a session ends (same as the Redis path): items consumed by `reflect` are removed and the rest are cleaned up after 24 hours. Retained amount per session is limited by the same token cap (500) as the Redis path and a row cap (100); the per-key cap is set by `MEMENTO_WM_FALLBACK_MAX_ROWS`; rows are counted first and only the excess, oldest first, is deleted. Because working memory lives in the database, it is shared by all server processes and survives restarts. The response reports the storage path in `working_memory` (`redis`, `postgres-fallback`, `none`) and carries the `working_memory_fallback` hint in `_meta.hints` on the fallback path. With `off`, `scope=session` writes are not stored while Redis is not ready and the response reports `working_memory=none` with the `working_memory_unavailable` hint. With `on`, a database write that is not accepted (no pool) gives the same `none` and hint, stating that the item was not stored. Read at call time |
| MEMENTO_WM_FALLBACK_MAX_ROWS | 2000 | Per-key row cap of the working memory fallback. When the rows of one key (requests without a key form one group) reach this value, the oldest rows of that key are deleted before a new row is written (writes are not refused). Concurrent writes can briefly exceed it by a few rows. Only integers of at least 1 are accepted; anything else is the default. Read at call time |
| MEMENTO_DEDUP_SCOPE | workspace | Scope of same-content (content_hash) duplicate detection. With `workspace`, detection is per key (no key for master) and workspace: the same key writing the same content to another workspace stores a separate fragment, and an existing fragment with the same content in the same workspace or a global (no workspace) fragment returns that id. With `key`, detection is per key and returns the id of an existing fragment in another workspace. Applies to remember, amend, batch_remember and imports alike. A key path whose key-scope unique index (`uq_frag_hash_per_key`, `uq_frag_hash_master`, or `fragments_new_key_id_content_hash_idx`, `fragments_new_content_hash_idx` with the same definition) still exists (including an invalid one) is detected per key regardless of the value. Both new installs and production databases reach the workspace scope only after `scripts/ops/finish-dedup-scope.mjs --confirm` drops those indexes (rollout: [operations/online-migration.md](operations/online-migration.md#중복-판정-범위-전환)). After those indexes are gone, `key` relies on the pre-insert lookup alone, so concurrent writes of the same content to two workspaces can both be stored. Read at call time |
| MEMENTO_FORGET_CASCADE | on | forget deletion cascade switch. With `on`, the transaction in which `forget` (id or topic) deletes fragments locks, in ascending id order, the targets (within the key scope) and the server-written contradiction resolution fragments (topic `contradiction_audit`, no `key_id`) whose `linked_to` holds a target, deletes them together, and in the same statement sets `summary` to `[삭제됨]` on the `case_events` rows whose `source_fragment_id` is a deleted fragment. Event rows, types, order and edges remain. After commit the `fragment_links` rows and other fragments' `linked_to` references for every deleted id are removed. The response carries `purged` (`case_summaries`: summaries replaced, `audit_fragments`: resolution records deleted along with the targets), on responses that reached the deletion step only (not on not found, no permission or permanent protection responses). New contradiction resolution records hold the ids of the two fragments instead of their content. The summary lookup uses `idx_ce_source_fragment_id` (migration-054). With `off`, `forget` deletes only the fragment rows and links, the summaries and resolution records remain, resolution records hold the first 80 characters of both fragments, and the response has no `purged`. Summaries whose source fragment no longer exists (left by `forget` while the switch is off, expiry cleanup or merges) are cleaned up with `scripts/purge-orphan-case-summaries.js` ([cli.en.md](cli.en.md)). A target that is itself a resolution record deletes only its own row, and the cascade does not spread through `linked_to` between resolution records (same-topic auto links). Resolution records written while the switch is off hold the first 80 characters and are deleted when a fragment they point to is deleted; a resolution record whose fragment was already deleted no longer has that id in `linked_to`, cannot be found, and keeps its copy. Read at call time |
| MEMENTO_LOG_STDERR | false | When `true`, console logs of every level go to stderr. The CLI (`bin/memento.js`) sets it to `true` for every command except `serve` when it is not set, so stdout carries only the command result. Read when the logger is first loaded |
| EPISODE_CONTINUITY_CACHE_TTL_MS | 5000 | TTL (ms) of the in-memory cache EpisodeContinuityService keeps per scope (`agentId:keyId:scopeType:scopeValue`) for the most recent milestone event ID. Insertion-order LRU, tracking up to 1000 scopes |

#### Migration Linting

| Variable | Default | Description |
|----------|---------|-------------|
| MIGRATION_LINT_FROM | (unset) | Override for the `npm run lint:migrations` cutoff. Only migrations numbered at or above this value are checked. When unset, every file is checked |

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
| MEMENTO_SYMBOLIC_TIMEOUT_MS | 50 | - | Symbolic evaluation timeout setting (ms). No code currently reads this value |
| MEMENTO_SYMBOLIC_MAX_CANDIDATES | 32 | - | Symbolic candidate count cap setting. No code currently reads this value |

The `api_keys.symbolic_hard_gate` column (migration-033) enables per-key hard gate switching. Defaults to false. When set to true, PolicyRules violations or high-confidence `sensitive.*` detections (`MEMENTO_SENSITIVE_SCAN`) cause the remember() call to be rejected with a JSON-RPC **protocol-level** error `-32003` (not an MCP tool error; `error.data.violations: string[]` included). Master keys (keyId=NULL) are excluded. Cache TTL is 30 seconds. The value is changed through the ACCESS POLICY card in the admin console key detail or `PATCH /v1/internal/model/nothing/keys/:id/policy`; the change clears this process's cache, and a lookup already in flight can still write the old value, so it is effective within about 30 seconds at the latest.

#### LLM Provider Fallback Chain

Automatic fallback to 17 providers beyond Gemini CLI. Existing behavior is fully preserved with default settings.

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
| LLM_CB_FAILURE_THRESHOLD | 5 | The provider moves to OPEN state when failures within `LLM_CB_FAILURE_WINDOW_MS` reach this count. A success clears the failure record |
| LLM_CB_OPEN_DURATION_MS | 60000 | OPEN state duration (ms). Automatically transitions to CLOSED after this interval |
| LLM_CB_FAILURE_WINDOW_MS | 60000 | Failure count window (ms) |

When REDIS_ENABLED=true, state is stored in Redis; otherwise in-memory.

##### LLM Concurrency Control

| Variable | Default | Description |
|----------|---------|-------------|
| LLM_CONCURRENCY_ENABLED | true | When false, bypasses the semaphore and sends requests to all providers without concurrency limits |
| LLM_CONCURRENCY_WAIT_MS | 30000 | Slot wait timeout (ms). On timeout the provider is recorded as failed and the chain moves to the next fallback |
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

##### Egress Policy

Every call that sends memory content to an LLM provider (contradiction escalation `contradiction`, AutoReflect `auto_reflect`, quality evaluation `evaluate`, long fragment split `split`, synthetic queries `synthetic_query`, LLM morpheme analysis `morpheme`) passes the gate in `lib/llm/EgressGate.js`. The gate filters the provider chain with the policy of the call context (stage, key, workspace), sends a prompt masked by `SensitiveScanner` to external providers, and records an audit event in the outbox before sending (`audit.llm.egress`: key, provider, stage, bytes, number of masked rules, workspaces; no content). When the audit write fails, the gate does not send to that provider and moves on to the next one.

| Variable | Default | Description |
|----------|---------|-------------|
| MEMENTO_EGRESS_POLICY | on | `on` runs the gate above. `off` skips policy lookup, provider filtering, masking before transfer, audit events and egress metrics, and uses the configured chain as is (rollback). Read at call time |
| MEMENTO_EGRESS_UNKNOWN_KEY | configured | Decision for calls whose key is unknown (no key context). `configured` uses the stage default, `local_only` uses local providers only. Master key calls are calls with a known key and are not affected. Read at call time |
| MEMENTO_EGRESS_LOCAL_HOSTS | (none) | Host names treated as local providers (comma separated, case insensitive). Loopback addresses (`localhost`, `127.0.0.0/8`, `::1`) are local without being listed. Entries are compared as is with the host of the endpoint, so use a name, an IPv4 address or a bracketed IPv6 address (`[fd00::1]`). An entry with a port, scheme or path, or an IPv6 address without brackets, can never match; it is recorded once at startup as a config issue (`entry_never_matches`) and left out of the comparison. DNS names are trusted as given: whether a name really points inside the operator's network is the operator's responsibility. Example: an Ollama host on the same network |

Provider classification: an HTTP provider is local when the host of its endpoint (`baseUrl`) is loopback or listed in `MEMENTO_EGRESS_LOCAL_HOSTS`; anything else (including no address or an unparsable one) is external. CLI providers (`gemini-cli`, `agy-cli`, `codex-cli`, `copilot-cli`, `qwen-cli`, `opencode-cli`) are always external. The classification looks at where this process connects; a relay on a local address that forwards elsewhere is classified as local.

The policy lives in `api_keys.egress_policy` (jsonb, migration-055) and is changed through the `egress_policy` field of `PATCH /v1/internal/model/nothing/keys/:id/policy`.

```json
{
  "local_only": false,
  "approved_providers": ["codex-cli", "ollama"],
  "workspaces": { "private-notes": { "local_only": true } }
}
```

- Every field is optional. `null` means no policy. A value comes from the workspace override, then the key value, then the stage default.
- Stage default: without a policy the six stages above (`EXTERNAL_DEFAULT_STAGES`, a fixed list that does not grow) keep using the configured providers (only the transfer audit is added). A new egress feature adds its stage to `KNOWN_STAGES` in `lib/llm/EgressPolicy.js` with the `local_only` default. Such stages, unregistered stages and calls that do not name a stage use local providers only. An explicit `local_only: false` on the key or workspace lets such stages use external providers.
- Decision: local providers are always allowed. When `local_only` is true every external provider is denied. When `approved_providers` is `null` (omitted) every configured external provider is allowed; when it is a list only the listed external providers are allowed. When the context carries more than one workspace (the two fragments of a contradiction check), a denial for any of them denies.
- Failure policy: when no provider is left after filtering, the stage is skipped without falling back to an external provider (`EgressSkippedError`). The stage is also skipped when the policy cannot be read or the stored value does not follow the rules. A failing local provider does not fall back to an external one.
- Key context: caller modules pass the key of the data they process (the fragment `key_id`, the session key, the key of the search request). AutoReflect uses the key recorded in the session activity log when the session record is gone. Master key calls use the stage default without a policy. Calls whose key is still unknown (topic name comparison in LLM morpheme analysis, admin console reflect of a session without an activity record) follow `MEMENTO_EGRESS_UNKNOWN_KEY`.
- A skipped contradiction check, including one skipped because the policy could not be read (`policy_unavailable`), is handled like any other LLM failure: it counts as "no contradiction" and the detection watermark advances, so the pair is not checked again in the next cycle.
- Scope: the gate covers generative LLM calls in `lib/llm` only. Embedding (`EMBEDDING_*`), reranker (`MEMENTO_RERANKER_*`) and NLI classifier sends are outside the gate and `local_only` does not block them; their destination is set by their own address settings.
- With `MEMENTO_OUTBOX=off` the gate sends without an audit row and the metric outcome is `sent_unaudited`.
- Policy lookups are cached per key for 30 seconds. A change clears this process's cache at once and reaches other instances within about 30 seconds.

Metrics: `memento_llm_egress_calls_total{stage,provider,provider_class,outcome}` (outcome: `sent`, `sent_unaudited`, `denied`, `audit_failed`), `memento_llm_egress_bytes_total{stage,provider_class}`, `memento_llm_egress_skipped_total{stage,reason}` (reason: `local_only`, `not_approved`, `policy_unavailable`, `policy_invalid`), `memento_llm_egress_masked_total{stage}` (number of sensitive rule kinds that matched per call; several matches of one rule count as 1). A provider the gate did not send to (audit failure, refusal right before the call) is not counted as a failure in `memento_llm_provider_calls_total`.

Audit event consumption: the default handler for `audit.llm.egress` (`lib/llm/egress-audit-handler.js`) is registered at startup and writes one `llm_egress` line per event to the audit log file (`LOG_DIR/audit-<date>.log`): key id, stage, provider, class, bytes, masked rule count, workspace count and event id, no content. A redelivery of the same event in the same process does not write the line again; a redelivery in another process is distinguishable by the event id.

##### Token Usage Cap

| Variable | Default | Description |
|----------|---------|-------------|
| LLM_TOKEN_BUDGET_INPUT | (none) | Input token cap. When set, requests exceeding the cap are rejected. When unset, observation only |
| LLM_TOKEN_BUDGET_OUTPUT | (none) | Output token cap |
| LLM_TOKEN_BUDGET_WINDOW_SEC | 86400 | Reset interval (seconds). Default 1 day |

##### Supported Providers

gemini-cli, **agy-cli**, anthropic, openai, gemini, groq, openrouter, xai, ollama, vllm, deepseek, mistral, cohere, zai, **codex-cli**, **copilot-cli**, **qwen-cli**, **opencode-cli**

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

**copilot-cli**: Wraps GitHub Copilot CLI (`copilot -p <prompt> --output-format text`). Requires the `copilot` binary and a Copilot subscription:
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

**Morpheme auxiliary search (morphemeIndex.minSimilarity / fallbackThreshold / fallbackLimit)**: An auxiliary search based on the morpheme mean vector runs in parallel with L3 semantic search. Morpheme mean vectors have systematically lower cosine similarity than sentence embeddings, so a dedicated threshold `morphemeIndex.minSimilarity` (default 0.15) is used instead of reusing `semanticSearch.minSimilarity` (default 0.4). The auxiliary results are adopted only when the default L3 result count is at or below `fallbackThreshold` (default 5), and up to `fallbackLimit` (default 5) of them are merged. The probe itself runs in parallel, so whether it is adopted does not affect response latency.

**GEMINI_TIMEOUT_MS**: The LLM chain call timeout in `lib/memory/processors/AutoReflect.js` is fixed at 30,000 ms (the `GEMINI_TIMEOUT_MS = 30_000` code constant, with no `process.env` reference). Changing it requires editing the constant in that file. It is separate from `geminiTimeoutMs` in MorphemeIndex (config/memory.js, default 60000).

**buildChain ordering logic** (`lib/llm/index.js` `buildChain()`): An entries array is constructed from `LLM_PRIMARY` followed by `LLM_FALLBACKS` in declaration order. A `seen` Set removes duplicate providers, and each provider's `isAvailable()` check determines whether it is included in the chain. If `LLM_PRIMARY` also appears in `LLM_FALLBACKS`, the fallback config object takes precedence. A provider that fails `isAvailable()` is excluded from the chain and the next provider is tried immediately. The resulting chain order corresponds 1:1 with the env variable declaration order.

For detailed operational guidance, see `docs/operations/llm-providers.md`.

#### OAuth Token TTL

OAuth token TTLs are linked to the session TTL.

| Variable | Default | Description |
|----------|---------|-------------|
| OAUTH_ACCESS_TOKEN_TTL_SECONDS | (unset) | OAuth access token TTL (seconds, positive integer). When unset, `SESSION_TTL_MINUTES * 60` (default 2592000, 30 days). Does not change the refresh token TTL |
| OAUTH_REFRESH_TTL_SECONDS | 5184000 | OAuth refresh token TTL (seconds). Not read from the environment; it is set to `SESSION_TTL_MINUTES * 60 * 2`. Default 60 days |

Sliding window: each time an OAuth-authenticated request arrives, the Redis TTL for that access token is reset to `OAUTH_TOKEN_TTL_SECONDS`. The token never expires as long as tools continue to be used.

#### Response Headers and Connection Policy

Recommended production settings are shown below. They assume a deployment used only by clients that send no browser Origin (CLI, desktop MCP clients, server-to-server calls), so check your own client mix before applying them. The defaults keep the responses unchanged.

```bash
ALLOWED_ORIGINS=https://memento.example.com
MEMENTO_CORS_MODE=allowlist
MEMENTO_FRAME_OPTIONS=deny
MEMENTO_OAUTH_REDIRECT_CHECK=enforce
MEMENTO_SSE_QUERY_KEY=deny
MEMENTO_TOOL_ARGS_VALIDATION=enforce
```

- Put only the service's own origin in `ALLOWED_ORIGINS`. When it is set, requests carrying an Origin outside the list end with 403, so the origin of the browser-based admin console must be in the list. Using `MEMENTO_CORS_MODE=allowlist` without a list omits `Access-Control-Allow-Origin` for Origins outside the default trusted domains (the request itself is still processed).
- Before switching, check actual use with the `[CORS] cross-origin request from` log of `observe`, the `error redirect target not registered` log of `warn`, and the count of `GET /sse?` requests in the access log.
- HSTS (`Strict-Transport-Security`) is not sent by the application. Set it on the reverse proxy that terminates TLS. In nginx, a single `add_header` inside a location block stops the server-level `add_header` directives (including HSTS) from being inherited, so repeat HSTS in that location when adding headers there.

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
| MEMENTO_HEALTH_READY_DB_TIMEOUT_MS | How long `GET /health/ready` waits for the primary DB, in ms. Default 2000, only integers from 100 to 4500 are accepted and any other value uses 2000. Keep it below the 5 second watchdog curl limit |
| MEMENTO_SHUTDOWN_DEADLINE_MS | Upper bound for the whole SIGTERM/SIGINT shutdown sequence, in ms. Forces exit code 1 when exceeded. Default 60000, 0 means no limit. Only integers of 0 or more are accepted; a negative or non-integer value uses 60000 |
| DB_BACKGROUND_MAX_CONNECTIONS | Primary pool connections that schedulers and workers may hold at once. Default 40% of DB_MAX_CONNECTIONS (min 1). Capped at DB_MAX_CONNECTIONS-1. Excess acquisitions wait in FIFO order |
| DB_BACKGROUND_WAIT_MAX_MS | Background slot wait limit (ms). Default 120000. Only the waiting job fails and retries on the next cycle |
| PGVECTOR_SCHEMA | Schema where the pgvector extension is installed. Detected automatically at startup when unset |
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

### outbox

Events are written to `agent_memory.outbox_events` (migration-052) inside the changing transaction, and a worker (`OutboxWorker`) delivers them to per-topic handlers. Consumer modules register handlers with `registerOutboxHandler(topic, handler, { maxAttempts })` (`lib/outbox/OutboxHandlers.js`), and a worker claims only topics that have a handler registered in its process. The producer and consumer contract is in [internals.en.md](internals.en.md#outbox-producer-and-consumer-contract).

| Variable | Default | Description |
|-|-|-|
| MEMENTO_OUTBOX | on | Switch for the whole feature. With `on`, `enqueue(client, event)` writes the row inside the caller's transaction and the worker starts. With `off`, `enqueue`, `enqueueStandalone` and `enqueueAutocommit` write nothing and return `null`, and the worker does not start. Events produced while the switch is `off` are lost for good; they are not written later. Rows that were already pending are kept and delivered after the switch is turned back `on`. Connection and event checks run regardless of the switch, so producer contract errors also surface with `off`. Read at call time (whether the worker starts is decided at startup) |
| MEMENTO_OUTBOX_WORKER | on | Per-process switch for running the worker. With `off`, writes from this process continue. When several instances share one database, keep it `on` only on the instances that should run the worker and `off` on the others; with all of them `on`, no event is processed by two of them at once. When every instance is `off`, pending rows accumulate until one of them is turned back on. Only processes that run the worker update the pending, dead-letter and lag gauges |
| MEMENTO_OUTBOX_MAX_ATTEMPTS | 12 | Claim limit per event. Integer from 1 to 100, any other value uses 12. A handler's registered `maxAttempts` takes precedence |
| MEMENTO_OUTBOX_RETENTION_DAYS | 7 | Days to keep processed rows. Integer from 1 to 3650, any other value uses 7 |
| MEMENTO_OUTBOX_UNHANDLED_DAYS | 7 | Days after which a pending row that was never claimed and whose topic has no handler registered in the worker process moves to dead-letter (`last_error = 'no_handler'`). Counted from the due time (`available_at`). Evaluated by each worker process against its own registered handlers. Integer from 1 to 3650, any other value uses 7 |

Behavior

- Writing: `enqueue(client, event)` accepts only a connection borrowed with `pool.connect()` on which `BEGIN` has run. A pool object, a connection outside a transaction block and a connection in a failed transaction are rejected with `OutboxTransactionRequiredError` without any query (the pg client's `getTransactionStatus()` must be `T`). The row commits or disappears with the caller's transaction. Events that must be kept without a business change (gate rejections, authentication failures) are written by `enqueueStandalone(pool, event)` in a short separate transaction, and a single latency-sensitive event (hook intake) is written by `enqueueAutocommit(pool, event)` as one INSERT statement (autocommit). `event` has `topic` (lowercase segments separated by dots, at most 64 characters), `aggregateId` (optional, at most 200 characters), `payload` (a plain object, at most 131072 bytes when serialized; it carries hashes and lengths instead of memory content; only the hook reflect topic `hook.reflect` carries a masked summary candidate of at most 1000 characters) and `delayMs` (optional, at most 30 days).
- Claiming: every second (without pause while there is work) the worker claims up to 50 pending rows in `(available_at, id)` order with `FOR UPDATE SKIP LOCKED`, and in the same statement increments `attempts` and moves `available_at` to the lease expiry (60 seconds later). It holds no transaction or row lock while handlers run. When several processes run workers at the same time, no event is handled by two workers while its lease is valid.
- Delivery guarantee: at least once. The same event is delivered again in these cases. When a worker dies while processing, another worker claims the row again after the lease expires. A handler must finish within 15 seconds; otherwise its `signal` is aborted and the attempt is recorded as a failure, but the handler itself is not stopped and can keep running, overlapping its retry. Complete and fail writes also pass the background pool gate, so with a saturated pool they can wait up to `DB_BACKGROUND_WAIT_MAX_MS`; if the lease ends meanwhile another worker delivers the event again (the late write is not applied and is counted by `memento_outbox_lease_lost_total`). Consumers absorb duplicates with the `idempotencyKey` (`topic:id`) passed to the handler.
- Stopping a batch: when less than 20 seconds of lease remain (15 second handler limit plus 5 seconds margin) or shutdown is requested, the worker starts no further event and releases the remaining claims. When a complete or fail write ends with an error, the claims not yet started are released and the round ends as failed. The event whose write failed is not released because its outcome is unknown; it is claimed again after the lease expires (that claim is already counted in `attempts`).
- Ordering: a batch is processed one event at a time in claim order. There is no ordering across batches, across workers or among events of the same aggregate, and a failed event can be delivered after later events.
- Retries and dead-letter: a failure is claimed again after a random delay between half and all of an interval that starts at 1 second and doubles per failure (capped at 30 minutes). A failure at the claim limit and an `OutboxPermanentError` thrown by the handler move the event to dead-letter (`dead_at`); it is not claimed again and not deleted automatically.
- Topics without a handler: a worker claims only topics with a handler in its own process, so rows of other topics are never claimed by it and every claim query scans them. Every 5 minutes a worker process moves pending rows whose topic is not in its own registered list, that were never claimed (`attempts = 0`) and whose due time passed more than `MEMENTO_OUTBOX_UNHANDLED_DAYS` days ago to dead-letter (`last_error = 'no_handler'`) in batches of 500, at most 5000 per run, and counts them in `memento_outbox_unhandled_total`. The rule is evaluated per worker process: every instance that runs the worker must register every consumer's handler, because rows of a topic missing on one instance can move to `no_handler` after this period even when another instance has the handler, unless that instance claimed them first. A process with no registered handlers at all skips the rule. `no_handler` rows can be returned to pending with the SQL below.
- Retention: every 5 minutes processed rows past the retention period are deleted in batches of 500, at most 5000 per run.
- Status: every 15 seconds the pending and dead-letter counts and the delay in seconds of the oldest pending row whose due time has passed (rows not yet due, such as retries waiting for their backoff and rows postponed by `delayMs`, and claimed rows are excluded) are published as gauges (`memento_outbox_pending`, `memento_outbox_dead_letter`, `memento_outbox_lag_seconds`) and in `schedulerJobs.outbox` of the admin `/stats` response, and the update time is kept in `memento_outbox_stats_updated_seconds` (Unix seconds). Counters are `memento_outbox_{enqueued,processed,failed,dead_letter}_total{topic}`, `memento_outbox_lease_lost_total`, `memento_outbox_cleaned_total` and `memento_outbox_unhandled_total`, and the histogram `memento_outbox_delivery_seconds{topic}` measures from the due time before the claim to the complete write. The topic label is a topic with a registered handler, and `other` for anything else.

After fixing the cause, return dead-letter rows (including `no_handler`) to pending.

```sql
UPDATE agent_memory.outbox_events
   SET dead_at = NULL, attempts = 0, available_at = now(), last_error = NULL
 WHERE dead_at IS NOT NULL AND topic = '<topic>';
```

Rows to discard instead are deleted by id. For topics whose records must be kept, such as audit events, export the rows before deleting them (`COPY (SELECT ...) TO` or `psql \copy`).

```sql
DELETE FROM agent_memory.outbox_events
 WHERE dead_at IS NOT NULL AND id IN (<id>, ...);
```

### Hook endpoints

`POST /hooks/{client}/{event}` is called by Claude Code and Codex hooks. `client` is `claude-code` or `codex`, `event` is `SessionStart`, `Stop` or `SessionEnd`; any other path is 404. Setup examples are in [getting-started/hooks.en.md](getting-started/hooks.en.md).

| Variable | Default | Description |
|-|-|-|
| MEMENTO_HOOK_ENDPOINTS | on | Hook endpoint switch. With `off`, requests under `/hooks/` get 404 before authentication. Reflect events already recorded in the outbox are still processed by the consumer with `off` (the consumer is registered regardless of the switch). Read at call time |

Behavior

- Authentication and permissions: `Authorization: Bearer <key>` is checked through the same authentication path as `/mcp`, and failures are counted in `memento_auth_denied_total` as well. Authentication failure is 401; an authentication store outage is 503 when `MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS` is 503. `SessionStart` needs the read permission, `Stop` and `SessionEnd` need write (403). A result authenticated with an API key is reused, looked up by a hash of the key string, for `MEMENTO_SESSION_KEY_RECHECK_MS` (default 30000; 0 disables the cache). On reuse the key state cache still checks that the key is active and supplies its permissions, and usage is counted every time. The key state cache is invalidated immediately only when an admin route in the same process changes the key. When a key is deactivated by a direct database change or through an admin route in another process, this process can keep accepting hooks for the deactivated key for up to `MEMENTO_SESSION_KEY_RECHECK_MS` (default 30 seconds). This is the same window as the key recheck of MCP sessions, and the reflect consumer checks the key again before reflect, so events of an inactive key write no memory and go to dead-letter. The daily limit (`daily_limit`) is checked only on full authentication, so on the hook path it takes effect up to that interval late.
- Rate limits: the endpoint has its own limiters and shares no bucket with `/mcp`, `/token` or `/authorize`. Authenticated requests use only a per-key bucket (`RATE_LIMIT_PER_KEY`; the master key is one bucket); the IP bucket (`RATE_LIMIT_PER_IP`) counts only requests that failed authentication. An IP that reached the failure limit gets 429 before authentication until the window passes (`Retry-After`). The bucket is per IP, so users behind one public IP (NAT, corporate proxy) share it: after `RATE_LIMIT_PER_IP` failed requests with wrong keys from that IP, requests with a valid key from the same IP also get 429 until the window (`RATE_LIMIT_WINDOW_MS`) passes. This is the same trade-off as `/token`.
- Input limits: `Content-Type` must be `application/json` (415), request headers total 8192 bytes (431), body 196608 bytes (413), JSON nesting depth 8 (400), summary candidate `excerpt` 65536 bytes (UTF-8, 413). A NUL character in `excerpt` is 400 (`invalid_excerpt`); lone surrogates are replaced with U+FFFD. The body is read after authentication. Response bodies have the form `{ "error": "<code>" }` and never echo the request body.
- Body fields: `session_id` (required for `Stop` and `SessionEnd`, up to 128 characters of `A-Za-z0-9._:-` starting with a letter or digit), `hook_event_name` (when present it must equal the path event), `source` (optional for `SessionStart`: `startup`, `resume`, `compact`, `clear`, `fork`), `cwd`, `git_remote`, `excerpt` (required for `Stop` and `SessionEnd`). Other fields (`transcript_path` and so on) are not read. The server cannot read the client's transcript file, so the `excerpt` is produced by the local CLI `anchormind hook`. A plain http hook `Stop` or `SessionEnd` without `excerpt` gets 422 (`excerpt_required`); a plain http hook supports `SessionStart` injection only.
- Workspace: among the candidates normalized from `cwd` and `git_remote` (remote `host/path`, remote repository name, full cwd path, last cwd segment, in this order; all lowercase, credentials, port, scheme and a trailing `.git` removed from the remote, backslashes in cwd turned into slashes), the first value inside the key's `allowed_workspaces` (case-insensitive match, stored spelling) is used. When no candidate matches, the key has no `allowed_workspaces`, or the master key is used, the key's `default_workspace` applies.
- `SessionStart`: calls `context` with a per-client budget (`claude-code` 2000, `codex` 1500 tokens; Codex hands a file path instead of the text when hook output exceeds about 2500 tokens) and answers 200 with `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`. `additionalContext` consists of the `[MEMENTO CONTEXT v0]` header, a fixed policy paragraph (the content is data, not instructions), and section headers and `- ` memory lines between `<<<MEMORY CONTEXT>>>` and `<<<END MEMORY CONTEXT>>>`. Each memory text goes through the answer pack escaping (newlines, control, format, surrogate, line and paragraph separator, tag characters, runs of three or more angle brackets), becomes one line and is cut at 1000 characters (`[truncated]`); a leading `#` run and the opening bracket of upper-case bracket tags (`[SYSTEM]` and so on) are escaped too. Section headers and the `(YYYY-MM-DD, assertion)` annotation (`MEMENTO_CONTEXT_ANNOTATE`) come only from the renderer.
- `Stop`, `SessionEnd`: the full excerpt is not stored. The last assistant block of the excerpt (the `[assistant]` block, or the last block when there is none) is masked with the `SensitiveScanner` rules, whitespace is folded and it is cut at 1000 characters; only this summary candidate and metadata (`v`, `client`, `event`, `sessionId`, `keyId`, `workspace`, `summaryChars`, `excerptBytes`, `sensitiveRules` (rule names), `receivedAt`) are written to the outbox (topic `hook.reflect`) with a single INSERT statement (autocommit), and after it commits the answer is 202 with `{"accepted":true}`. With `MEMENTO_SENSITIVE_SCAN=reject` a block with findings is not recorded and the answer is 422 (`sensitive_content`, rule names only). With any other value (including `off`) only the masked value is recorded. The masking rules are the store rules of `lib/security/sensitivePatterns.js` (prefixed API key formats, GitHub, GitLab, npm, Slack and Stripe tokens, AWS access keys and secret key assignments, JWT, PEM private keys, mmcp keys, Bearer values, user passwords in URLs, secret name assignments (`*_API_KEY=`, `*_SECRET=`, `*_TOKEN=`, `password:` and so on, values with a digit or at least 16 characters), email addresses, phone numbers, resident registration numbers with a valid check digit, card numbers passing Luhn). Formats outside these rules (for example an arbitrary secret string without a name) are not masked. Processed rows stay for `MEMENTO_OUTBOX_RETENTION_DAYS`. When the outbox is off and nothing is recorded, the answer is 503.
- Duplicates and pending cap: the same key, session id and event is reflected once. When this process accepted the key within the last 10 minutes or `idempotency_records` has a claim or completion for it, nothing is recorded and the answer is 202 with `{"accepted":true,"duplicate":true}`. When the key has 500 pending `hook.reflect` events, the answer is 429 (`queue_full`, `Retry-After: 60`). The reflecting event is `SessionEnd`. `Stop` runs after every response in Claude Code and Codex, so only the first `Stop` of a session is recorded and later ones end right away as duplicates; `Stop` is an auxiliary path for sessions that never send `SessionEnd`.
- Reflect consumer: when the worker delivers a `hook.reflect` event, the consumer confirms the key again (an inactive key or a key without write permission goes to dead-letter without retry), claims the idempotency key (SHA-256 of key, client, session id and event) in `idempotency_records` (tool `hook_reflect`), runs `reflect` with one episode narrative built from the summary candidate, and marks the claim done. The completion record stays for 30 days, during which the same session and event is not reflected again. When reflect fails the claim is released and the outbox retries. Reflect and the completion record are not one transaction: if the process ends after reflect and before the completion record, the claim stays for 5 minutes and the next delivery then takes it over and runs reflect again (the same narrative folds by content_hash, so no extra episode appears). No scheduled task deletes expired `idempotency_records` rows yet (`IdempotencyStore.purgeExpired` is not registered in the scheduler); hook rows are at most two per session.
- Metrics: `memento_hook_calls_total{client,event,outcome}` (client and event outside the allow-list become `other`; outcome is `context`, `accepted`, `duplicate`, `queue_full`, `not_found`, `invalid`, `sensitive_rejected`, `unauthorized`, `forbidden`, `rate_limited`, `unavailable`, `error`), `memento_hook_reflect_total{outcome}` (`reflected`, `duplicate`, `busy`, `rejected`, `failed`).
- Logs: only client, event, status code and error name and code are logged; the excerpt, summary candidate, key and session id are not.
- Response time: on a disposable test database (pool of 20 connections), 10 rounds of 50 concurrent requests (real key authentication, admission check and write) measured p50 53 to 59 ms, p95 78 to 91 ms, p99 80 to 93 ms, sequential p50 5 ms (`scripts/measure-hook-latency.mjs`). Results depend on the production database and pool size.

#### Variables read by the hook runner (not server settings)

`anchormind hook` is a local command run by the harness and reads neither the server `.env` nor the `.env` of the repository it runs in (cwd). The server URL and key come only from the `--remote`, `--key` arguments or the process environment variables below, and the URL and key are always taken as a pair from the same source. These variables are not listed in `.env.example`.

| Variable | Source | Description |
|-|-|-|
| CLAUDE_PLUGIN_OPTION_SERVER_URL, CLAUDE_PLUGIN_OPTION_API_KEY | Claude Code (set by the harness) | The AnchorMind plugin's userConfig `server_url` and `api_key`. Claude Code puts them only into plugin hook processes. Do not set them yourself. Used only when both are present, ahead of the MEMENTO_CLI_* pair. When only one is present both are ignored with a warning and the MEMENTO_CLI_* pair is used |
| MEMENTO_CLI_REMOTE, MEMENTO_CLI_KEY | User shell environment | Common remote CLI variables ([cli.en.md](cli.en.md#remote-access-environment-variables)). The hook uses them when the plugin pair is absent |

Plugin installation is described in [getting-started/plugins.en.md](getting-started/plugins.en.md).

### Audit table

Audited actions write a topic `audit.record` event to the outbox, and the audit promotion consumer (`lib/logging/audit-consumer.js`) moves it into `agent_memory.admin_audit_events` (migration-056) as one sequential hash chain. The file audit log (`LOG_DIR/audit-YYYY-MM-DD.log`) keeps being written. A 30-day period of comparing both records is recommended; file log files are not deleted automatically.

| Variable | Default | Description |
|-|-|-|
| MEMENTO_AUDIT_DB | on | With `on`, audit events are written to the outbox and the processes that run the outbox worker register the audit promotion handler. With `off`, nothing is written and no handler is registered (the file audit log continues). Actions taken while it is `off` are not in the table. Pending `audit.record` rows become a topic without a handler and may move to `no_handler` dead-letter after `MEMENTO_OUTBOX_UNHANDLED_DAYS`; after turning it back `on`, requeue them with the SQL above. With `MEMENTO_OUTBOX=off`, nothing is written regardless of this value. Whether to write is read at call time, handler registration at startup |
| MEMENTO_AUDIT_RETENTION_DAYS | 400 | Days to keep audit rows (by `recorded_at`). Every 6 hours the leading part older than this is deleted in batches of 10000, at most 50000 per run. Each batch writes a retention checkpoint row (`audit.retention.prune`) at the end of the chain in the same transaction. The last row is never deleted. Integer from 1 to 3650, any other value uses 400 |

Recorded actions

| Action | Producer | Target | detail |
|-|-|-|-|
| `admin.*` | Admin API requests other than GET, and export GETs, recorded when the response finishes. Action names follow the declarations in `lib/admin/admin-audit-actions.js`; a request without a declaration is `admin.request` | First path variable (key, group, fragment id, first 8 characters of a session id) or the id of a resource the handler created | `method`, `path` (without query string, UUID segments shortened to 8 characters), `status`, and values reported by the handler (`changed`, `before`, `after` for key policy, `after` for key numbers and status) |
| `admin.auth` | Admin login success (`success`) and failure (`denied`) | none | `channel` (form, bearer). The attempted value is never recorded |
| `memory.remember`, `memory.amend`, `memory.forget`, `memory.link` | Memory tool handlers. Failures are recorded as `failure`; dryRun calls are not recorded | Fragment id (`topic` for a forget by topic) | Content only as `contentSha256` and `contentLength`, failures only as `errorCode` (no error messages) |
| `memory.anchor` | Storing an anchor, or an amend that changes `isAnchor` | Fragment id | `isAnchor` |
| `gate.block` | The write gate (`WriteGate`) rejects a write (hard gate, `MEMENTO_SENSITIVE_SCAN=reject`, hard gate lookup failure) | none | `entry`, `op`, `rule`, `fragmentType`. The actor is the key (master for user entry points without a key, system for internal server jobs) |
| `memory.batch_remember` | One event per batch_remember call. Failures are recorded; dryRun calls are not | none | `total`, `inserted`, `skipped`, `anchors` (items that set an anchor), `async`. No content |
| `memory.reflect` | reflect | none | `count` |
| `memory.consolidate` | memory_consolidate (master) | none | Top-level numbers of the result (`expiredDeleted` and so on) |
| `system.update.apply` | apply_update when it really applies (not dryRun) | none | `step`, `targetVersion`, `installType` |
| `llm.egress` | The audit promotion consumer moves the external transfer audit topic `audit.llm.egress` | Provider (`llm_provider`) | `stage`, `providerClass`, `bytes`, `maskedRules`, `workspaceCount`. Workspace names are not recorded |
| `audit.retention.prune` | Retention cleanup (actor system) | Chain (`audit_chain`, boundary seq) | `boundarySeq`, `boundaryHash` (seq and `row_hash` of the last deleted row), `deleted`, `retentionDays` |

Of the writing tools, `tool_feedback` (usage signals only) and `session_rotate` (session id rotation, recorded in `session-audit.log`) write no audit event. Every writing tool lists its audit actions or the reason for the exemption in `TOOL_AUDIT_COVERAGE` of `lib/tools/memory-audit.js`, checked by `tests/structure/tool-audit-coverage.test.js`. Audit queries (`GET /audit`) are reads and are not recorded; export and verification requests are. Review decisions are written by the producer of that feature with the same functions (`recordAudit`, or `enqueueAudit` inside a transaction).

detail rules: an event whose key names point at content or secrets (containing `content`, `body`, `text`, `summary`, `token`, `secret`, `password`, `authorization`, `cookie`, `credential`, `api_key`, `private_key`, `raw`, or equal to `code`, `otp`, `key`, `session`, `pin`; names that merely contain them such as `errorCode` and `keyId` are accepted) is not created. Keys ending in `Sha256` and `Length` are accepted only as 64 hex characters and non-negative integers. String values have secret formats replaced with markers (`SensitiveScanner`) and are cut to 200 code points. Target ids and workspaces also have secret formats replaced. Every string value (actor, target, workspace, detail) is made well-formed Unicode (lone surrogates become U+FFFD) and then cut by code points, so surrogate pairs are never split and the hashed value equals the value stored in the database. Events that break the rules and outbox write failures never block the business response; they are recorded as a warning log and `memento_audit_enqueue_failed_total`.

Chain

- Row hash: `row_hash = sha256(prev_hash + "\n" + canonical JSON of the row values)`. The first row's `prev_hash` is 64 zeros. Canonical JSON sorts keys, writes seq as a decimal string and times as millisecond ISO strings (`lib/logging/audit-chain.js`).
- Sequence: the consumer locks the table in `SHARE ROW EXCLUSIVE` mode, reads the last row and writes `seq = last + 1` in the same transaction (lock wait limit 10 seconds). Several workers never fork the chain. When `source_event` (the outbox idempotency key) already exists, no new row is written. seq is the write (commit) order and can differ from the `occurred_at` (occurrence time) order; sort by `occurred_at` to see occurrence order.
- Verification checks seq continuity, the `prev_hash` link and the recomputed `row_hash` in that order. A changed row reports `row_hash_mismatch`, a missing row `seq_gap`, a broken link `prev_hash_mismatch`, each with the first broken seq. A chain that still starts at seq 1 uses 64 zeros (`genesis`). A chain whose leading part was removed is anchored at a retention checkpoint (`checkpoint`) only when a checkpoint row has the seq just before the remaining first row as `boundarySeq` and its `boundaryHash` equals that row's `prev_hash`; the checkpoint row itself is checked as part of the chain. A prefix removed without a checkpoint, or a row removed after the checkpoint boundary, reports `prefix_mismatch`. With `fromSeq`, a missing row just before it reports `seq_gap`. Rows removed after the last row cannot be detected from the chain alone, so keep the `headHash` of a verification result outside the database and compare it.

Query and verification

- Admin API: `GET /v1/internal/model/nothing/audit` (filters `action`, `actor`, `target_type`, `target_id`, `outcome`, `workspace`, `from`, `to`, `before`, `limit`), `GET .../audit/export?format=jsonl` (same filters, seq ascending, `prevHash` and `rowHash` on every line), `POST .../audit/verify` (optional body `{ "fromSeq": n, "maxRows": n }`). Formats are in [api-reference.en.md](api-reference.en.md#audit).
- Console: the Audit Log screen in the sidebar runs filtered queries, loads more, exports JSONL and verifies the chain.
- CLI: `memento-mcp audit verify [--from-seq N] [--max-rows N] [--json]`. Exit code 1 when the chain is broken.
- Metrics: `memento_audit_enqueue_failed_total`, `memento_audit_recorded_total` (newly written rows), `memento_audit_cleaned_total`. Promotion lag and failures are visible as `memento_outbox_*{topic="audit.record"}`.

### Redis

| Variable | Default | Description |
|----------|---------|-------------|
| REDIS_ENABLED | false | Enable Redis. When false, L1 search and caching are disabled |
| REDIS_SENTINEL_ENABLED | false | Use Sentinel mode |
| REDIS_HOST | localhost | Redis server host |
| REDIS_PORT | 6379 | Redis server port |
| REDIS_PASSWORD | (none) | Redis authentication password |
| REDIS_DB | 0 | Redis database number |
| MEMENTO_REDIS_SESSION_FAIL_CLOSED | false | Fail the request when Redis session persistence fails. When false, warn and continue with the in-memory session |
| MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE | true | Transition compatibility for API-key non-default agentId claims. Each use emits a warning and increments `mcp_legacy_unbound_agent_scope_total`. It does not authenticate agents sharing a key; migrate clients, confirm no further increments, then set false for strict mode. includePeerAgents always requires master authentication |
| MEMENTO_RESERVED_AGENT_IDS | warn | Handling of agentIds reserved for internal work (system, admin). Inputs that normalize to either value (for example `SYSTEM`, `sy.stem`) are covered. warn lets the request through and only logs `[AgentScope] reserved agentId requested: key=<first 8 chars of key> mode=warn`. enforce rejects API-key requests with FORBIDDEN (-32001). Master keys are always allowed. Switch to enforce once the warning stops appearing |
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
| EMBEDDING_API_KEY | (none) | Generic embedding API key. When unset, `GEMINI_API_KEY`, `CF_API_TOKEN` (or `CLOUDFLARE_API_TOKEN`), then `OPENAI_API_KEY` are used in that order |
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

### Watchdog

Environment variables read by `memento-watchdog.sh`. They come from the environment of the cron job that runs the watchdog, not from the server `.env`. Values in seconds are integers of 0 or more. The operating procedure is in [maintenance.md](operations/maintenance.md).

| Variable | Default | Description |
|-|-|-|
| MEMENTO_WATCHDOG_BASE_URL | `http://127.0.0.1:57332` | Address that is checked |
| MEMENTO_WATCHDOG_SERVICE | `memento-mcp.service` | Name of the systemd service to restart |
| MEMENTO_WATCHDOG_STATE_FILE | `/tmp/memento-watchdog.state` | State file path. Holds the consecutive restart count, the last restart time and the last ready response code on one line |
| MEMENTO_WATCHDOG_LOCK_FILE | state file path plus `.lock` | Lock file that prevents concurrent runs |
| MEMENTO_WATCHDOG_STARTUP_GRACE_SEC | 120 | No restart within this many seconds after the service started, even without a response |
| MEMENTO_WATCHDOG_BACKOFF_BASE_SEC | 60 | First wait (seconds) between consecutive restarts |
| MEMENTO_WATCHDOG_BACKOFF_MAX_SEC | 1800 | Upper bound (seconds) of the wait between consecutive restarts |
| MEMENTO_WATCHDOG_RESTART_CMD | (none) | When set, runs this command instead of `sudo systemctl restart` |
| MEMENTO_WATCHDOG_NOW | current time (epoch seconds) | Time injection. For tests |
| MEMENTO_WATCHDOG_SERVICE_AGE_SEC | (none) | Injects the seconds since the service started. For tests |
| MEMENTO_WATCHDOG_ACTIVE_ENTER_TIMESTAMP | (none) | Injects the service start time. For tests |

### Backup

Environment variables read by `scripts/ops/backup.sh`. They come from the environment of the shell or cron job that runs the backup, never from the server `.env`, and the server does not read them. Invalid values are rejected with exit code 2. The procedure is in [backup-restore.md](operations/backup-restore.md).

| Variable | Default | Description |
|-|-|-|
| MEMENTO_BACKUP_DIR | `$XDG_STATE_HOME/memento-mcp/backups`, otherwise `$HOME/.local/state/memento-mcp/backups` | Backup destination. Must be a path outside the repository (a path inside the repository, the filesystem root and the home directory itself are rejected). The `--dir` argument takes precedence |
| MEMENTO_BACKUP_KEEP_DAYS | 14 | Number of days to keep. Integer from 1 to 9999. The `--keep` argument takes precedence |

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
    l1WeightFactor: 2.0,  // Weight multiplier for L1 Redis results (highest priority injection)
    graphWeightFactor     : 1.5,  // Weight multiplier for L2.5 graph neighbor results
    candidateMinImportance: 0.1   // Importance floor for non-anchor RRF candidates
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
      learning   : 3,
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
    maxDeletePerCycle      : 50,     // Deletions per cycle when MEMENTO_GC_THROUGHPUT=off
    chunkSize              : 100,    // Rows per expired-delete chunk
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
    maxImportance    : 0.55,     // Below this = deletion candidate
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
| `mode` | `MEMENTO_PROACTIVE_RECALL_MODE` | `"auto"` | `"auto"`: runs automatically when conditions are met. `"legacy"`: links by keyword overlap alone and only skips workspace mismatches (symbolic gate and caseIdPolicy are not applied). `"off"`: disabled |
| `keywordOverlapMin` | `MEMENTO_PROACTIVE_KW_OVERLAP_MIN` | `0.5` | Minimum keyword overlap ratio. The ratio of common keywords between the stored fragment and a candidate must reach this threshold for a link to be created |
| `requireSameWorkspace` | - | `true` | Fragments from a different workspace are excluded from ProactiveRecall |
| `caseIdPolicy` | `MEMENTO_PROACTIVE_CASE_POLICY` | `"strict-or-adjacent"` | `"both-required"`: both fragments must share the same case_id. `"strict-or-adjacent"`: when both fragments have a case_id they must match (a mismatch is `cohort_mismatch`), and when either lacks one it requires the same sessionId, creation within adjacencyWindowMs, or the same workspace. `"loose"`: case_id mismatches are allowed |
| `adjacencyWindowMs` | - | `86400000` (24h) | Time window (ms) within which a different case is considered adjacent under the `"strict-or-adjacent"` policy |
| `requireSameTopicOrType` | - | `false` | A setting only; nothing currently reads this value |

The `proactive-gate.js` symbolic gate evaluates `workspace_mismatch` and `case_policy` block reasons. It runs in `auto` mode only when both `MEMENTO_SYMBOLIC_ENABLED=true` and `MEMENTO_SYMBOLIC_PROACTIVE_GATE=true` are set.

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

### consolidate.autoPromoteAnchors

`MEMENTO_AUTO_PROMOTE_ANCHORS` is an opt-out for the automatic anchor-promotion stage. When unset or empty it defaults to `true`, preserving the existing behavior. When set to `false`, `promote_anchors` returns `status="skipped"` with `reason="disabled_by_config"` and performs no promotion UPDATE. Other non-empty values are rejected as configuration errors. It does not demote existing anchors or disable any other consolidation stage. Restart the server after changing the setting.

A stage with its flag set to `false` emits `status: "skipped"` and proceeds to the next stage. `compressOldFragments` defaults to `false` because it modifies original fragment content.

### fragmentSplit

Controls the details of the `splitLongFragments` stage. Configured in the `fragmentSplit` block of `config/memory.js`.

| Key | Default | Description |
|-|-|-|
| `lengthThreshold` | `300` | Fragments longer than this (characters) become split candidates |
| `batchSize` | `10` | Maximum fragments processed per cycle |
| `minItems` | `2` | The original is replaced only when the LLM separates it into at least this many items |
| `maxItems` | `8` | Maximum number of items requested from the LLM |
| `timeoutMs` | `30000` | LLM timeout per fragment (ms) |
| `minChildLength` | `20` | Child pieces shorter than this are discarded by the quality gate |
| `excludeMetaTopics` | `["session_reflect","consolidation","reflection"]` | Topics excluded from splitting |
| `failureBackoffHours` | `24` | Fragments are excluded from reselection for this many hours after a failed split (`split_attempt_failed_at` column, migration-036) |
| `requireSubjectAnchor` | `true` | Discards a child that carries none of the parent's subject anchors. ENV: `MEMENTO_SPLIT_SUBJECT_GATE` |
| `rejectIntroducedModality` | `true` | Discards a child that introduces a modality absent from the parent. ENV: `MEMENTO_SPLIT_MODALITY_GATE` |
| `subjectAnchorMax` | `12` | Maximum subject anchors extracted from the parent body |

Split child quality gate (`split-gate.js`): a child is rejected when it is shorter than `minChildLength`, contains the replacement character (`�`), mixes in CJK/kana characters (relative to a Hangul body), or starts with a pronoun or meta token. A fact-type child whose importance is below 0.4 after clamping is not stored.

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
- `embeddingWorker.batchSize`, `embeddingWorker.intervalMs`, `pagination.defaultPageSize`, `pagination.maxPageSize`, `gc.maxDeletePerCycle`, `gc.chunkSize` are positive integers

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
| 040 | migration-040-workspace-audit-columns.sql | `fragments.workspace_source TEXT` (CHECK explicit / key_default / inferred / unscoped, NULL means not recorded), `fragments.quality_rationale TEXT` |
| 041 | migration-041-workspace-backfill-inference.sql | `fragments.workspace_inferred`, `inference_confidence` (0.0 to 1.0 CHECK), `backfill_batch_id`. Records inference results separately from the workspace column |
| 042 | migration-042-api-keys-allowed-workspaces.sql | `api_keys.allowed_workspaces TEXT[]`. NULL is unlimited. An empty array judges every workspace claim to be outside the set and records a `workspaceNotAllowed` warning; a write is rejected only when `MEMENTO_WORKSPACE_GATE=true` and the key's hard gate is on. A write without a workspace always passes. Edited through `PATCH /v1/internal/model/nothing/keys/:id/policy` (at most 64 entries, 128 characters each) |
| 043 | migration-043-fragment-synthetic-query.sql | `fragment_synthetic_query` table (synthetic queries and embeddings, HNSW index, agent isolation policy) |
| 044 | migration-044-idempotency-records.sql | `idempotency_records` table (retry responses of `amend` and `tool_feedback`, default 7-day expiry) |
| 045 | migration-045-fragment-rls.sql | Enables RLS and isolation policies on `fragments` and `fragment_links`. `FORCE ROW LEVEL SECURITY` is not applied |
| 047 | migration-047-agent-scope-audit.sql | `search_events.effective_agent_scope`, `include_peer_agents`, and `agent_id`, `workspace` snapshot columns on `fragment_versions` and `case_events` |
| 048 | migration-048-case-events-case-closed.sql | Adds `case_closed` to the `case_events.event_type` CHECK |
| 049 | migration-049-align-synthetic-query-embedding.sql | History marker. The DDL that aligns the `fragment_synthetic_query.embedding` dimension with `fragments.embedding` is applied by `scripts/migrate.js` after the numbered migrations |
| 050 | migration-050-dedup-scope-workspace.sql | Adds the per key and workspace content_hash unique indexes `uq_frag_hash_ws_per_key` and `uq_frag_hash_ws_master`. Production databases create them first with `scripts/ops/online-index.mjs`; the key-scope indexes are dropped in an operational step ([operations/online-migration.md](operations/online-migration.md#중복-판정-범위-전환)) |
| 051 | migration-051-search-events-budget.sql | `search_events.candidate_count`, `budget_kept` (candidate count and kept count of recall budget selection, nullable). Searches that do not go through budget selection record NULL |
| 052 | migration-052-outbox-events.sql | `outbox_events` table (transactional outbox: topic, aggregate_id, payload, available_at, attempts, processed_at, last_error, dead_at, claim_token) with partial indexes for pending, processed and dead-letter rows |
| 054 | migration-054-case-events-source-fragment.sql | Partial index `idx_ce_source_fragment_id` on `case_events(source_fragment_id)` (lookup for the forget deletion cascade and orphan summary cleanup). Production databases create it first with `scripts/ops/online-index.mjs` ([operations/online-migration.md](operations/online-migration.md)) |
| 055 | migration-055-api-keys-egress-policy.sql | `api_keys.egress_policy JSONB` (LLM egress policy, NULL means no policy). Edited through `egress_policy` of `PATCH /v1/internal/model/nothing/keys/:id/policy`. See "Egress Policy" for the decision rules |
| 056 | migration-056-admin-audit-events.sql | `admin_audit_events` table (audit hash chain: seq, source_event, occurred_at, recorded_at, action, outcome, actor, target, workspace, detail, prev_hash, row_hash) with time, action, actor and target indexes |
| 057 | migration-057-fragment-provenance.sql | `fragments.origin`, `observed_client`, `trust_tier` (smallint), `review_state`, `review_reason` (all nullable without defaults, no table rewrite) and CHECK constraints on `origin` and `trust_tier` (NOT VALID, applied to newly written rows only). Existing rows are not backfilled and a NULL `trust_tier` is read as 2 in code (`MEMENTO_PROVENANCE`). `origin` is the origin claimed by the client and differs in role from `source` (label) and `assertion_status` (verification state) |
| 058 | migration-058-review-decisions.sql | `memory_review_decisions` table (review decision records: `fragment_id`, `decision` (approve, reject, auto_reject), `reviewer`, `note`, `idempotency_key` (partial unique index), `key_id`, `review_reason`, `decided_at`; no fragment content) and the `fragments_review_state_check` constraint (`review_state` is NULL, pending, approved or rejected; NOT VALID, applied to newly written rows only). A key's review mode is not an api_keys column but a permission list marker (`review_off`, `review_all`) (`MEMENTO_REVIEW_QUEUE`) |

---

## Mode Preset Configuration

Locks the session operation scope to a preset. Three configuration paths are available, applied in the following priority order:

1. **Per-request header** (highest priority): `X-Memento-Mode: <preset>`
2. **initialize parameter**: `{ "method": "initialize", "params": { "mode": "<preset>" } }`
3. **Per-key default** (the ACCESS POLICY card in the admin console key detail, or `PATCH /v1/internal/model/nothing/keys/:id/policy`): `api_keys.default_mode` column (migration-034). Master-only presets (`audit`) cannot be assigned to an API key. Applies to sessions opened after the change

| Preset | Description | Representative excluded_tools | Recommended context |
|--------|-------------|-------------------------------|---------------------|
| `recall-only` | Read-only. Write tools blocked | remember, batch_remember, amend, forget, link, reflect, memory_consolidate | Shared API keys with read-only grants; read-only dashboard integrations |
| `write-only` | Write-only. Search tools blocked | recall, context, reconstruct_history, graph_explore, fragment_history, search_traces, memory_stats | CI/cron jobs that only record results. Minimizes token consumption by hiding unnecessary retrieval tools |
| `onboarding` | New-user guidance. All tools exposed + beginner guide injected | (none, excluded_tools: []) | A new-user session. Set through the header, the initialize parameter, or the key default |
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
npm test          # node:test, tests/unit/*.test.js + tests/unit/*/*.test.js (no DB required)
```

Individual runs:
```bash
npm run test:integration # node:test, tests/integration/*.test.js + tests/e2e/*.test.js
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
| `intervalMs` | `MEMENTO_SYNTHETIC_QUERY_INTERVAL_MS` | `5000` | Worker queue polling interval (ms) |
| `maxCallsPerMinute` | `MEMENTO_SYNTHETIC_QUERY_RPM` | `20` | LLM calls per minute, `0` for unlimited |
| `batchSize` | `MEMENTO_SYNTHETIC_QUERY_BATCH` | `5` | Items taken from the queue per cycle |
| `backfillBatch` | `MEMENTO_SYNTHETIC_QUERY_BACKFILL` | `20` | Ungenerated fragments collected when the queue is empty |
| `adoptLimit` | `MEMENTO_SYNTHETIC_QUERY_ADOPT` | `5` | Max fragments merged through the auxiliary path per search |
| `similarityDecay` | - | `0.85` | Decay applied to auxiliary hit similarity |
| `llmTimeoutMs` | `MEMENTO_SYNTHETIC_QUERY_TIMEOUT_MS` | `20000` | Generation call timeout |

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
