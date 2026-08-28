# API Reference

For MCP tool details, see [SKILL.md](../SKILL.md).

---

## HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /mcp | Streamable HTTP. JSON-RPC request receiver. MCP-Session-Id header required (except initial initialize) |
| GET | /mcp | Streamable HTTP. Opens SSE stream. For server-side push |
| DELETE | /mcp | Streamable HTTP. Explicit session termination |
| GET | /sse | Legacy SSE. Session creation. Authenticate via `accessKey` query parameter |
| POST | /message?sessionId= | Legacy SSE. JSON-RPC request receiver. Responses delivered via SSE stream |
| GET | /health | Health check. Verifies DB query (SELECT 1), session state, and Redis connection, returning JSON. When `REDIS_ENABLED=false`, Redis shows as `disabled` with 200 returned. DB failure returns 503 |
| GET | /metrics | Prometheus metrics. HTTP request counters, session gauges, etc. collected by prom-client |
| GET | /openapi.json | OpenAPI 3.1.0 spec. Authentication required. Master key returns full paths including Admin REST API; API key returns a spec filtered to tools matching the key's `permissions` array. Enabled via `ENABLE_OPENAPI=true` env var. Returns 404 when disabled. |
| GET | /.well-known/oauth-authorization-server | OAuth 2.0 authorization server metadata |
| GET | /.well-known/oauth-protected-resource | OAuth 2.0 protected resource metadata |
| GET | /authorize | OAuth 2.0 authorization endpoint. PKCE code_challenge required |
| POST | /token | OAuth 2.0 token endpoint. authorization_code exchange |
| GET | /v1/internal/model/nothing | Admin SPA. Serves app shell HTML (no auth required). Data APIs require master key authentication |
| GET | /v1/internal/model/nothing/assets/* | Admin static files (admin.css, admin.js). No authentication required |
| POST | /v1/internal/model/nothing/auth | Master key verification endpoint |
| GET | /v1/internal/model/nothing/stats | Dashboard statistics (fragment count, API call volume, system metrics, searchMetrics, observability, queues, healthFlags) |
| GET | /v1/internal/model/nothing/activity | Recent fragment activity log (10 entries) |
| GET | /v1/internal/model/nothing/keys | API key list |
| POST | /v1/internal/model/nothing/keys | Create API key. Raw key returned in response exactly once |
| PUT | /v1/internal/model/nothing/keys/:id | Change API key status (active <-> inactive) |
| PUT | /v1/internal/model/nothing/keys/:id/daily-limit | Change API key daily call limit. Master key required |
| PATCH | /v1/internal/model/nothing/keys/:id/workspace | Change API key's default_workspace. `{ workspace: "name" }` or `{ workspace: null }` (null=unset) |
| DELETE | /v1/internal/model/nothing/keys/:id | Delete API key |
| GET | /v1/internal/model/nothing/groups | Key group list |
| POST | /v1/internal/model/nothing/groups | Create key group |
| DELETE | /v1/internal/model/nothing/groups/:id | Delete key group |
| GET | /v1/internal/model/nothing/groups/:id/members | Group member list |
| POST | /v1/internal/model/nothing/groups/:id/members | Add key to group |
| DELETE | /v1/internal/model/nothing/groups/:gid/members/:kid | Remove key from group |
| GET | /v1/internal/model/nothing/memory/overview | Memory overview (type/topic distribution, quality unverified, superseded, recent activity) |
| GET | /v1/internal/model/nothing/memory/search-events?days=N | Search event analysis (total searches, failed queries, feedback stats) |
| GET | /v1/internal/model/nothing/memory/fragments | Fragment search/filter (topic, type, key_id, workspace, page, limit) |
| GET | /v1/internal/model/nothing/memory/anomalies | Anomaly detection results |
| GET | /v1/internal/model/nothing/sessions | Session list (activity enrichment, unreflected session count) |
| GET | /v1/internal/model/nothing/sessions/:id | Session detail (search events, tool feedback) |
| POST | /v1/internal/model/nothing/sessions/:id/reflect | Manual reflect execution |
| DELETE | /v1/internal/model/nothing/sessions/:id | Terminate session |
| POST | /v1/internal/model/nothing/sessions/cleanup | Expired session cleanup |
| POST | /v1/internal/model/nothing/sessions/reflect-all | Bulk reflect for unreflected sessions |
| GET | /v1/internal/model/nothing/logs/files | Log file list (with sizes) |
| GET | /v1/internal/model/nothing/logs/read | Log content viewing (file, tail, level, search parameters) |
| GET | /v1/internal/model/nothing/logs/stats | Log statistics (per-level counts, recent errors, disk usage) |
| GET | /v1/internal/model/nothing/memory/graph?topic=&limit= | Knowledge graph data (nodes + edges) |
| GET | /v1/internal/model/nothing/export?key_id=&topic= | Fragment JSON Lines stream export |
| POST | /v1/internal/model/nothing/import | Fragment JSON array import |

### /health Endpoint Policy

| Dependency | Classification | Response when down |
|------------|---------------|-------------------|
| PostgreSQL | Required | 503 (degraded) |
| Redis | Optional | 200 (healthy, with warnings) |

Even when Redis is disabled (`REDIS_ENABLED=false`) or connection fails, the server returns healthy (200). L1 cache and Working Memory are deactivated, but core memory storage/retrieval operates fully on PostgreSQL alone.

Two authentication methods are available. Streamable HTTP authenticates via `Authorization: Bearer <MEMENTO_ACCESS_KEY>` header on the `initialize` request, then maintains the session. Legacy SSE authenticates via `/sse?accessKey=<MEMENTO_ACCESS_KEY>` query parameter.

### HTTP Response Headers — Rate Limit

When an API key with a configured quota (fragment_limit) calls MCP tools, the following headers are included in the response.

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Total allowed fragment count set for the key |
| `X-RateLimit-Remaining` | Current remaining fragment count |
| `X-RateLimit-Resource` | Resource identifier being measured (`fragments`) |

Headers are omitted for master key (keyId=null) or keys with limit=null. Usage cache TTL is 10 seconds.

Client consumption example:
```
HTTP/1.1 200 OK
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4880
X-RateLimit-Resource: fragments
```

### RBAC (Role-Based Access Control)

All MCP tool calls must pass RBAC validation.

- Master key (`MEMENTO_ACCESS_KEY`): treated as `permissions=null`, granting access to all tools.
- API key (`mmcp_xxx`): tool access is restricted based on the `permissions` array specified at key creation time. Requests for tools not included in the array are immediately denied.
- Tools registered in the `TOOL_PERMISSIONS` map require the corresponding permission level. Unregistered tool names are treated as `required=null` and pass the permission check. To bring a new tool into the RBAC boundary, register it explicitly in the `TOOL_PERMISSIONS` map.
- Three permission levels exist: `read` (recall/context/memory_stats etc.), `write` (remember/forget/amend etc.), `admin` (memory_consolidate/apply_update etc.). A key with `admin` permission can invoke tools at all levels.
- When a forget/amend/link request targets a fragment owned by another tenant (different API key), a `"Fragment not found"` error is returned. Isolation is enforced at the SQL level via `key_id` conditions, so the fragment's existence is never exposed.

Accessing a protected resource without authentication returns `401 Unauthorized` with a `WWW-Authenticate: Bearer resource_metadata="</.well-known/oauth-protected-resource URL>"` header.

### Mode Preset

The session behavior mode can be set via the `X-Memento-Mode` header or `params.mode` in the `initialize` request. Setting `api_keys.default_mode` in the admin console pins a per-key default.

| Preset | Description | Allowed Tools |
|--------|-------------|---------------|
| `recall-only` | Read-only session. Blocks memory write/modify tools. For search-only agents. | recall, context, memory_stats, graph_explore, fragment_history, reconstruct_history, search_traces, get_skill_guide, tool_feedback |
| `write-only` | Write-only session. Blocks recall and context. For data ingestion pipelines. | remember, batch_remember, forget, amend, link, reflect |
| `onboarding` | New user guidance session. Forces get_skill_guide as the first exposed tool. | All (get_skill_guide surfaced first) |
| `audit` | Read and trace-only session. Blocks all write tools. For auditing and compliance. | recall, context, memory_stats, graph_explore, fragment_history, reconstruct_history, search_traces |

Via HTTP header:
```
X-Memento-Mode: recall-only
```

Via `initialize` parameters:
```json
{
  "method": "initialize",
  "params": {
    "mode": "recall-only",
    "protocolVersion": "2025-06-18"
  }
}
```

### Session Reuse

Token-based session reuse is enabled. Even when a client reconnects without an `Mcp-Session-Id`, the server automatically recovers the existing session if the same Bearer token is presented. This is transparent to the client and requires no additional configuration.

When session segmentation is active (`MEMENTO_SESSION_SEGMENT`, default true), a fragment's `session_id` may be a derived ID `{transport session ID}#{seq}` that rotates on idle or age thresholds, rather than the raw transport-layer `Mcp-Session-Id`. A rotation triggers an automatic reflect of the previous segment.

### POST /session/rotate

Reissues only the session identifier while preserving all in-flight state, intended for suspected session-ID compromise. Redis-stored session data is retained as-is; only the ID is swapped, so memory fragments and the MCP connection state are unaffected.

Request:

```http
POST /session/rotate HTTP/1.1
Authorization: Bearer <API key or master key>
Mcp-Session-Id: <target sessionId>
Origin: https://example.com
Content-Type: application/json

{ "reason": "suspected_leak" }
```

Response (200):

```json
{
  "ok": true,
  "oldSessionId": "aabbcc11-...-8899ddee",
  "newSessionId": "ffeedd22-...-3344ccbb",
  "reason": "suspected_leak",
  "rotatedAt": "2026-04-21T12:34:56.789Z"
}
```

Policy:

- Auth: `Authorization: Bearer` required; ownership mismatch with the target session returns 403
- CSRF guard: `Origin` header required; missing or non-allowlisted Origin returns 403
- Rate limit: `MEMENTO_ROTATE_RATE_LIMIT_PER_MIN` requests per IP per minute (default 5); exceeding returns 429
- `reason` is an audit-log field (max 128 chars); defaults to `explicit_rotate` when omitted
- Metrics: `mcp_session_rotation_total{reason}` counter + `mcp_rotate_rate_limited_total` counter
- CLI: use `memento-mcp session rotate <sessionId>` for the same capability; see `docs/cli.en.md` for details

### tools/list Response — meta Field

Each tool entry in the `tools/list` response includes a `meta` field.

```json
{
  "name": "recall",
  "description": "...",
  "inputSchema": { ... },
  "meta": {
    "capabilities": ["search", "pagination", "caseMode"],
    "riskLevel": "read",
    "requiresMaster": false,
    "beta": false,
    "idempotent": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `capabilities` | string[] | List of feature tags supported by this tool |
| `riskLevel` | string | Tool risk tier. `read` / `write` / `admin` |
| `requiresMaster` | boolean | Whether the tool requires the master key (MEMENTO_ACCESS_KEY) |
| `beta` | boolean | Whether this is an experimental feature. When true, the interface may change |
| `idempotent` | boolean | Whether repeated calls with the same parameters produce no side effects |

---

## OAuth 2.0

Supports RFC 7591 Dynamic Client Registration and PKCE-based Authorization Code Flow.

### /.well-known/oauth-authorization-server

The server metadata response includes a `registration_endpoint`.

```json
{
  "issuer": "https://{domain}",
  "authorization_endpoint": "https://{domain}/authorize",
  "token_endpoint": "https://{domain}/token",
  "registration_endpoint": "https://{domain}/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"]
}
```

### POST /register

RFC 7591 Dynamic Client Registration. No authentication required.

Request body:

```json
{
  "client_name": "Claude",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"]
}
```

Response 201:

```json
{
  "client_id": "mmcp_...",
  "client_name": "Claude",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": ["authorization_code"],
  "token_endpoint_auth_method": "none"
}
```

> API keys (mmcp_xxx) can be used directly as `client_id`. This applies when reusing an existing API key as an OAuth client in Claude.ai Web Integration.

### GET /authorize

OAuth 2.0 authorization endpoint. PKCE `code_challenge` and `code_challenge_method=S256` are required.

Query parameters: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method`, `state` (optional).

Renders a user consent screen. After consent, returns a 302 redirect to `redirect_uri` with the `code` parameter.

### POST /authorize

Submitted as form data when the user allows or denies on the consent screen.

| Field | Value |
|-------|-------|
| `decision` | `allow` or `deny` |
| `response_type` | Original OAuth parameter |
| `client_id` | Original OAuth parameter |
| `redirect_uri` | Original OAuth parameter |
| `code_challenge` | Original OAuth parameter |
| `code_challenge_method` | Original OAuth parameter |
| `state` | Original OAuth parameter (if present) |

- `decision=allow`: 302 redirect to `redirect_uri?code=<code>&state=<state>`
- `decision=deny`: 302 redirect to `redirect_uri?error=access_denied`

### PUT /v1/internal/model/nothing/keys/:id/daily-limit

Change the daily call limit for an API key. Master key required.

Request body:

```json
{ "daily_limit": 50000 }
```

Response:

```json
{ "success": true, "daily_limit": 50000 }
```

---

## Prompts

Pre-defined guidelines that help AI use the memory system efficiently.

| Name | Description | Primary Role |
|------|-------------|-------------|
| `analyze-session` | Session activity analysis | Guides automatic extraction of decisions, errors, and procedures worth saving from the current conversation |
| `retrieve-relevant-memory` | Relevant memory retrieval guide | Assists in finding optimal context by combining keyword and semantic search for a given topic |
| `onboarding` | System usage guide | Helps AI self-learn when and how to use AnchorMind tools |

---

## Resources

MCP resources for real-time queries on the current state of the memory system.

| URI | Description | Data Source |
|-----|-------------|-------------|
| `memory://stats` | System statistics | Per-type and per-tier counts and utility score averages from the `fragments` table |
| `memory://topics` | Topic list | All unique `topic` labels from the `fragments` table |
| `memory://config` | System configuration | Weights and TTL thresholds defined in `MEMORY_CONFIG` |
| `memory://active-session` | Session activity log | Current session tool usage history recorded in `SessionActivityTracker` (Redis) |

---

## MCP Tool — recall

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| keywords | string[] | - | Keyword search (L1->L2). Without text, an L3 semantic supplement runs in parallel using the synthesized keywords(+contextText) text, recovering fragments whose stored keywords lack the query terms (controlled by `semanticSearch.keywordFallback`, adds an `L3kw:N` searchPath segment). |
| text | string | - | Natural language query (L3 semantic) |
| topic | string | - | Topic filter |
| type | string | - | Type filter (fact, decision, error, preference, procedure, relation, episode) |
| tokenBudget | number | - | Maximum return tokens. Default 1000. |
| includeLinks | boolean | - | Include linked fragments (1-hop, resolved_by/caused_by prioritized). Default true. |
| linkRelationType | string | - | Link relation type filter (related, caused_by, resolved_by, part_of, contradicts) |
| threshold | number | - | Similarity threshold (0-1) |
| includeSuperseded | boolean | - | Include expired (superseded) fragments. Default false. |
| includePeerAgents | boolean | - | When true, includes fragments from other agentIds within the same key/workspace scope (for multi-agent collaboration). Key and workspace boundaries are preserved. Default false. |
| includeKeyName | boolean | - | When true, each fragment carries key_id and key_name (the access key label). Only information within the same key group scope is exposed. Default false. |
| asOf | string | - | ISO 8601. Return only fragments valid at the specified point in time. |
| excludeSeen | boolean | - | Exclude fragments already injected by context(). Default true. |
| includeKeywords | boolean | - | Include each fragment's keywords array in the response |
| includeContext | boolean | - | Include context_summary + adjacent fragments |
| timeRange | object | - | {from, to} time range filter (ISO 8601 or natural language) |
| caseId | string | - | Case ID filter. Returns only fragments belonging to the specified case. |
| resolutionStatus | string | - | Resolution status filter (open / resolved / abandoned) |
| phase | string | - | Work phase filter (planning, debugging, verification, etc.) |
| caseMode | boolean | - | CBR mode. Groups similar fragments by case_id and returns them as (goal, events, outcome) triples. Use when referencing past similar work resolution cases. |
| maxCases | number | - | Maximum number of cases to return in caseMode. Default 5, upper limit 10. |
| depth | string | - | Search depth filter. "high-level" / "detail" / "tool-level". See details below. |
| workspace | string | - | Search scope restriction. When specified, only fragments from the given workspace + global (NULL) fragments are returned. |
| contextText | string | - | Current conversation context text. Proactively activates related fragments (when ENABLE_SPREADING_ACTIVATION=true). |
| cursor | string | - | Pagination cursor |
| pageSize | number | - | Default 20, max 50 |
| agentId | string | - | Agent ID |
| minImportance | number | - | Minimum importance filter (0-1). Only fragments with importance at or above this value are returned. |
| isAnchor | boolean | - | When true, returns only anchor (pinned) fragments. Useful for querying core knowledge. |
| affect | string \| string[] | - | Affect tag filter. Single string or array. Returns only fragments with the matching affect value. Valid values: neutral, frustration, confidence, surprise, doubt, satisfaction |
| fields | string[] | - | Fragment fields to include in the response. Returns all fields if not specified. Supported keys: id / content / type / topic / keywords / importance / created_at / access_count / confidence / linked / explanations / workspace / context_summary / case_id / valid_to / affect / ema_activation |

### Response Fragment Fields (key fields)

Each returned fragment includes a `key_id` field. When called with a master key, fragments owned by other API keys may also be returned, identifiable by their `key_id` value. When called with an API key, only fragments owned by that key (`key_id` match) or group-shared fragments are returned.

`stitched_context` field: returned when `includeContext=true`. Combines surrounding time context and causal links into a single narrative structure. Attached only to the top 3 fragments that actually have material to combine, and trimmed to one item per side when it would exceed 40% of the response token budget.

- `pre` / `post`: fragments stored within 30 minutes before or after the target within the same `session_id`. `delta_min` is the signed minute offset from the target.
- `causal`: `caused_by` / `resolved_by` / `contradicts` / `part_of` links only. Automatically generated `related` / `co_retrieved` / `temporal` links are excluded. Links are followed in both directions, with `direction` marking which way the edge points.

`affect` field: The emotional state tag attached to the fragment at storage time, returned as stored.

`_meta`: A metadata wrapper at the top level of recall/context responses.

```json
{
  "_meta": {
    "searchEventId": 1234,
    "hints": [
      {
        "signal"    : "no_results",
        "suggestion": "이 주제에 대한 기억이 없습니다. 중요한 내용이라면 remember로 저장하세요.",
        "trigger"   : "remember"
      }
    ],
    "suggestion": { "code": "empty_result_no_context", "recommendedTool": "recall" },
    "serverTime": {
      "iso"        : "2026-05-15T06:32:11.000Z",
      "epoch_ms"   : 1747291931000,
      "display_kst": "2026년 5월 15일 (목) 15:32",
      "timezone"   : "Asia/Seoul"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `_meta.searchEventId` | FK value to pass as `search_event_id` when calling tool_feedback. The search event ID persisted by `commitSearchSideEffects`. |
| `_meta.hints` | Array of search signal hints (`no_results`, `topic_mismatch`, `contradiction_pending`, `stale_results`, etc.). `topic_mismatch` fires when the requested topic yields zero fragments while similar topics exist in key scope, and recommends re-running recall with a suggested topic. `contradiction_pending` fires when returned fragments have unresolved contradicts links and recommends cleanup via amend |
| `_meta.suggestion` | RecallSuggestionEngine hint object (null when no issue detected) |
| `_meta.serverTime` | Server time of the response, mitigating LLM clients' training-time fixation. Included consistently in all recall/context responses. `iso` (UTC ISO 8601), `epoch_ms` (Unix ms), `display_kst` (Asia/Seoul formatted), `timezone`. |

Successful responses from the write tools (remember/amend/forget) may also carry a `_meta` block. In that case `hints` holds a single `feedback_sampled` signal alongside `serverTime`; `searchEventId` and `suggestion` are absent. See [Feedback sampling hint](#feedback-sampling-hint).

`_meta.suggestion`: A hint object generated by the RecallSuggestionEngine based on analysis of the current search pattern. `null` when no issue is detected.

```json
{
  "_suggestion": {
    "code": "empty_result_no_context",
    "message": "No results found. Passing contextText with your current work context activates SpreadingActivation to surface related fragments proactively.",
    "recommendedTool": "recall",
    "recommendedArgs": { "contextText": "brief summary of current task context" }
  }
}
```

`_suggestion` detection rules:

| code | Trigger condition | Recommendation |
|------|-------------------|----------------|
| `repeat_query` | A keywords query repeated 3+ times within 5 minutes (counted over search_events whose query_type is keywords or mixed) | Pull the case timeline — `reconstruct_history` when a dominant case_id exists, otherwise `graph_explore` |
| `empty_result_no_context` | 0 results and contextText is absent | Add contextText |
| `large_limit_no_budget` | A `limit` parameter of 50 or more with no tokenBudget. recall's page-size parameter is `pageSize`, so this rule does not fire in practice | Set tokenBudget explicitly to control response size |
| `no_type_filter_noisy` | Called without a type filter while the key scope holds more than 100 fragments (neither this call's result count nor depth is considered) | Add a type filter |

Rules are evaluated in the order above and only the first match is attached to `_meta.suggestion`. The field is omitted when nothing matches.

`explanation` (included only when `MEMENTO_SYMBOLIC_EXPLAIN=true`): Explains why the fragment was included in the search results, using up to 3 reason codes.

```json
{
  "fragment": {
    "id": "...",
    "explanations": [
      { "code": "direct_keyword_match",  "detail": "L2 morpheme/keyword match",  "ruleVersion": "v1" },
      { "code": "graph_neighbor_1hop",   "detail": "graph neighbor 1-hop",        "ruleVersion": "v1" }
    ]
  }
}
```

Reason code list (up to 3):

- `direct_keyword_match` — included via L2 morpheme/keyword matching
- `semantic_similarity` — included via L3 pgvector embedding similarity
- `graph_neighbor_1hop` — included via L2.5 graph neighbor 1-hop
- `temporal_proximity` — included via timeRange filter or ±24h temporal proximity
- `case_cohort_member` — included as a member of the same case_id cohort in caseMode path
- `recent_activity_ema` — included with a score boost due to high ema_activation ranking

### depth enum

| Value | Target Types | Use Case |
|-------|-------------|----------|
| `"high-level"` | decision, episode only | For planners. Strategy formulation and direction decisions. |
| `"detail"` | All (default) | General search. No type restriction. |
| `"tool-level"` | procedure, error, fact only | For executors. Retrieving concrete execution steps and config values. |

### caseMode Response Structure

When `caseMode=true`, a `cases` array is additionally returned alongside the regular fragments.

```json
{
  "caseMode": true,
  "cases": [{
    "case_id": "abc-123",
    "goal": "nginx 502 resolution",
    "outcome": "upstream port mismatch fix",
    "resolution_status": "resolved",
    "events": [
      {"event_type": "error_observed", "summary": "502 Bad Gateway"},
      {"event_type": "fix_attempted", "summary": "nginx.conf modified"},
      {"event_type": "verification_passed", "summary": "200 OK confirmed"}
    ],
    "fragment_count": 5,
    "relevance_score": 3
  }],
  "caseCount": 1
}
```

#### event_type enum

| Value | Description |
|-------|-------------|
| `milestone_reached` | Major milestone achieved |
| `hypothesis_proposed` | Hypothesis proposed |
| `hypothesis_rejected` | Hypothesis rejected |
| `decision_committed` | Decision committed |
| `error_observed` | Error observed |
| `fix_attempted` | Fix attempted |
| `verification_passed` | Verification passed |
| `verification_failed` | Verification failed |

---

## MCP Tool — remember

Fragment-based memory storage. Store exactly one atomic fact in 1-2 sentences. If there is a lot of content, call multiple times to store each fact separately.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| content | string | Y | Content to remember (1-3 sentences, 300 characters recommended). The raw input itself is capped at 4000 characters; exceeding it is rejected with `-32602`. |
| topic | string | Y | Topic (e.g., database, email, deployment, security) |
| type | string | Y | Fragment type. fact, decision, error, preference, procedure, relation, episode. Types other than episode are truncated beyond 300 characters. |
| keywords | string[] | - | Keywords for search (auto-extracted if not provided) |
| importance | number | - | Importance 0-1 (type-specific default if not provided) |
| source | string | - | Source (session ID, tool name, etc.) |
| linkedTo | string[] | - | List of existing fragment IDs to link to |
| scope | string | - | Storage scope. permanent=long-term memory (default), session=session working memory (destroyed on session end) |
| isAnchor | boolean | - | Pin important fragment. When true, excluded from importance decay and expiration deletion. |
| supersedes | string[] | - | List of existing fragment IDs to replace. Specified fragments have their valid_to set and importance halved. |
| contextSummary | string | - | Context/background summary of how this memory arose (1-2 sentences). Returned alongside the fragment on recall to restore context. |
| sessionId | string | - | Current session ID. Used to bundle fragments from the same session by temporal adjacency. |
| workspace | string | - | Workspace name. Key's default_workspace applied if not specified. |
| agentId | string | - | Agent ID (for RLS isolation) |
| caseId | string | - | Case/task identifier this fragment belongs to. Auto-set to the current session_id if not provided. |
| goal | string | - | Goal of the episode fragment (recommended for episode type) |
| outcome | string | - | Outcome of the episode fragment |
| phase | string | - | Work phase (e.g., planning, debugging, verification) |
| resolutionStatus | string | - | Task resolution status (open, resolved, abandoned) |
| assertionStatus | string | - | Fragment confidence level (observed, inferred, verified, rejected). Default: observed |
| affect | string | - | Emotional state tag at the time of storing this memory. Default: neutral. Valid values: neutral, frustration, confidence, surprise, doubt, satisfaction |
| idempotencyKey | string | - | Retry-safe identifier (max 128 characters). Repeated calls with the same value within the same key_id scope return the existing fragment id without creating a new fragment. For client retry and network deduplication. |
| dryRun | boolean | - | When true, returns an execution plan without applying changes. Inspect quota and conflict check results before fragment creation. |

`affect` usage example:
```json
{
  "content": "Confirmed REDIS_SENTINEL_ENABLED was missing as the cause of Redis connection failure.",
  "topic": "redis",
  "type": "error",
  "affect": "frustration"
}
```

### Response

dryRun=true response (no actual storage):
```json
{
  "dryRun": true,
  "simulated": {
    "fragment": { "content": "...", "type": "error", "topic": "redis" },
    "conflicts": [],
    "validation_warnings": [],
    "quota": { "used": 120, "limit": 5000, "remaining": 4880 }
  }
}
```

Normal response:
```json
{
  "fragment": {
    "id": "...",
    "content": "...",
    "type": "decision",
    "importance": 0.8,
    "validation_warnings": []
  }
}
```

`validation_warnings`: Array of PolicyRules soft gating violation rule names (string[]). The field is omitted when there are no violations. When `MEMENTO_SYMBOLIC_POLICY_RULES=false` (default), always omitted. Both the atomic path (`MEMENTO_REMEMBER_ATOMIC=true`) and the non-atomic path share the same `_runPolicyGate` call, so the format is identical on both paths. When enabled, failed predicates accumulate from the following 5:

- `decisionHasRationale` — decision type lacks 2+ linked_to references or rationale keywords
- `errorHasResolutionPath` — error type lacks cause/fix keywords or resolution_status
- `procedureHasStepMarkers` — procedure type lacks numbered/step markers
- `caseIdHasResolutionStatus` — fragment with a case_id has no resolution_status set
- `assertionNotContradictory` — polarity conflict with an existing assertion
- `fragmentHasWorkspace` — workspace could not be resolved from an explicit value or the key default (severity: low)

Warnings are soft gates and do not block storage. When `api_keys.symbolic_hard_gate=true`, fragments triggering warnings are rejected. `fragmentHasWorkspace` is only included in the hard-gate-eligible set when `MEMENTO_WORKSPACE_GATE=true`; by default (`false`) it never blocks storage even on hard-gate-enabled keys.

`workspaceNotAllowed` — recorded when a fragment's workspace falls outside the API key's `allowed_workspaces` set (severity: medium). Evaluated unconditionally, independent of `MEMENTO_SYMBOLIC_POLICY_RULES`. It is a pure warning that never blocks storage and is always excluded from the hard-gate-eligible set.

Fragments also record the resolution source of their workspace as `workspace_source`: `explicit` (workspace given in the request), `key_default` (the API key's default_workspace was applied), or `unscoped` (neither was available).

### Feedback sampling hint

Successful `remember`, `amend`, and `forget` responses carry a `tool_feedback` request hint with a fixed probability. When the call is not sampled, the response shape is unchanged and no `_meta` block is attached.

```json
{
  "success": true,
  "id": "frag-...",
  "_meta": {
    "hints": [
      {
        "signal": "feedback_sampled",
        "suggestion": "방금 remember 결과가 의도한 대로 유용했는지 tool_feedback으로 평가해 주세요. relevant=false인 경우 irrelevance_reason도 함께 보내면 원인별 개선에 반영됩니다.",
        "trigger": "tool_feedback",
        "args": { "tool_name": "remember", "trigger_type": "sampled" }
      }
    ],
    "serverTime": { "iso": "..." }
  }
}
```

Clients receiving the hint should pass `hints[0].args` straight into `tool_feedback` (`trigger_type="sampled"`), adding `irrelevance_reason` when the result is judged irrelevant. The `suggestion` text is served in Korean.

Sampling follows `feedback.sampling` in `config/memory.js`: per-tool rates are remember 0.10, amend 0.25, forget 0.25, capped at 2 hints per session with a 900-second cooldown after the previous hint (the cap and cooldown are skipped when Redis is unavailable). Set `MEMENTO_FEEDBACK_SAMPLING=false` to disable sampling entirely. `remember(dryRun=true)`, `forget(dryRun=true)`, and an `amend` that changed nothing (`updated=false`) are excluded. recall is not sampled because it already has its own hint path.

---

## MCP Tool — batch_remember

Store multiple fragments at once (for bulk memory input). Batch INSERTs up to 200 items in a single transaction, minimizing HTTP round-trips.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| fragments | object[] | Y | Array of fragments to store (max 200). Each item includes content (string, required, max 4000 characters — an item exceeding it is rejected with `-32602`), topic (string, required), type (string, required), importance (number), keywords (string[]), workspace (string), idempotencyKey (string, max 128 chars). |
| workspace | string | - | Batch default workspace. Used for individual fragments without a workspace. Key's default_workspace applied if not specified. |
| agentId | string | - | Agent ID (for RLS isolation) |
| stream | boolean | - | Deprecated: no longer emits SSE progress events. batch_remember returns a standard single JSON response. This parameter is retained for backward compatibility but has no effect on behavior. |
| async | boolean | - | When true, fire-and-forget (async) mode (default false). Performs only schema validation, content_hash dedup, and quota pre-check synchronously, then enqueues accepted fragments to a Redis queue and immediately returns `{async: true, accepted: N, rejected: N, jobId: "..."}`. The actual INSERT is handled by the background worker (BatchRememberWorker). Falls back to synchronous mode when Redis is disabled (REDIS_ENABLED=false). |

### async=true Response Example

```json
{
  "async": true,
  "accepted": 5,
  "rejected": 1,
  "jobId": "batch-1750000000000-a1b2c3d4"
}
```

In synchronous mode (default), a `results[]` array is returned. Use the `batch_status` tool with `jobId` to query processing state. The async worker guarantees at-least-once delivery via ack, retry (up to 3), dead-letter, and startup recovery (RPOPLPUSH reliable queue).

---

## MCP Tool — batch_status

Query the processing state of an async batch job started by `batch_remember(async: true)`. Read-only. Returns `status: null` when Redis is disabled.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jobId | string | Y | The `jobId` from a `batch_remember(async: true)` response |

### Response

| Field | Type | Description |
|-------|------|-------------|
| jobId | string | The queried jobId |
| state | string | `queued` \| `processing` \| `completed` \| `dead` |
| accepted | number | Fragments enqueued |
| processed | number | Fragments successfully processed |
| failed | number | Fragments that failed processing |

### Response Example

```json
{
  "jobId": "batch-1750000000000-a1b2c3d4",
  "state": "completed",
  "accepted": 5,
  "processed": 5,
  "failed": 0
}
```

---

### Permission denials

Calling a tool without the required permission returns JSON-RPC error `-32600` with the message `Internal error`. The actual reason (`Permission denied: '<tool>' requires '<level>' permission`) is recorded in the server log only. A client therefore cannot tell an authorization failure from a server fault by the response alone, which matters when designing retry policy. `memory_consolidate`, `apply_update`, and `check_update` take this path.

### forget response shapes

| Situation | Response | isError |
|-|-|-|
| Deleted | `{success: true, deleted: 1}` | false |
| Permanent tier without `force` | `{success: true, deleted: 0, protected: 1, reason: "..."}` | false |
| Target missing or not permitted | `{success: true, deleted: 0, error: "Fragment not found or no permission"}` | true |

In the third case the payload reports `success: true` while carrying an `error` key, and that key flips the MCP envelope to `isError: true`. Retrying a delete that already succeeded lands here, so clients should read `deleted` rather than treating the envelope as authoritative.

### memory_consolidate execution

Requires `admin`. The full cycle runs 20+ stages and scales with fragment count; around 13,000 fragments it takes roughly 7 minutes. The scheduler runs the same path every 6 hours by default, so manual invocation is for inspection only. The semantic dedup stage is guarded: a merge is blocked when the distinctive tokens of the fragment being removed do not survive in the one being kept.

## MCP Tool — forget

Delete fragment memory. Either id or topic is required. Permanent-tier fragments require the force option.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | string | - | Fragment ID to delete |
| topic | string | - | Delete all fragments with the given topic |
| force | boolean | - | Force-delete permanent fragments (default false) |
| agentId | string | - | Agent ID |
| dryRun | boolean | - | When true, returns target fragment info and connected link count without actually deleting. |

---

## MCP Tool — link

Establish a relationship between two fragments. Specifies causal, resolution, composition, or contradiction relationships.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| fromId | string | Y | Source fragment ID |
| toId | string | Y | Target fragment ID |
| relationType | string | - | Relation type (related, caused_by, resolved_by, part_of, contradicts). Default related. |
| agentId | string | - | Agent ID |
| weight | number | - | Relation weight (0-1, default 1) |
| dryRun | boolean | - | When true, returns cycle and ownership check results without creating the link. |

---

## MCP Tool — amend

Update the content or metadata of an existing fragment. Selectively modifies while preserving ID and links.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Y | Target fragment ID to update |
| content | string | - | New content (truncated beyond 300 characters). The raw input itself is capped at 4000 characters; exceeding it is rejected with `-32602`. |
| topic | string | - | New topic |
| keywords | string[] | - | New keyword list |
| type | string | - | New type (fact, decision, error, preference, procedure, relation) |
| importance | number | - | New importance (0-1) |
| isAnchor | boolean | - | Set anchor (pinned) status |
| supersedes | boolean | - | When true, explicitly supersedes the existing fragment (creates superseded_by link and lowers importance) |
| assertionStatus | string | - | Change fragment assertion status (observed, inferred, verified, rejected). For fragments with a case_id, changes automatically record verification_passed/verification_failed events. |
| resolutionStatus | string | - | Change the case resolution state (open, resolved, abandoned). For fragments with a case_id, switching to resolved automatically records a case_closed event. |
| outcome | string | - | Case closing summary. Recorded together with resolutionStatus='resolved'. |
| phase | string | - | Change the work phase (planning, debugging, implementation, verification, …). |
| agentId | string | - | Agent ID |
| dryRun | boolean | - | When true, returns the expected fragment state after applying the patch without making actual changes. |

---

## MCP Tool — reflect

Persist session learnings as atomic fragments at session end. Each array item is stored as an independent fragment, so include only one fact/decision/procedure per item.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| summary | string \| string[] | - | Session overview fragment list. Array recommended. 1 item = 1 fact (1-2 sentences). |
| sessionId | string | - | Session ID. When provided, reflect synthesizes only fragments from the same session. |
| decisions | string[] | - | Technical/architecture decision list. 1 item = 1 decision. |
| errors_resolved | string[] | - | Resolved error list. 'Cause: X -> Resolution: Y' format recommended. |
| new_procedures | string[] | - | Established procedure/workflow list. 1 item = 1 procedure. |
| open_questions | string[] | - | Unresolved question list. 1 item = 1 question. |
| narrative_summary | string | - | Summarize the entire session as a 3-5 sentence narrative. Stored as an episode fragment contributing to cross-session context continuity. Auto-generated from summary if omitted. |
| agentId | string | - | Agent ID |
| workspace | string | - | Workspace applied to all fragments created by this reflect call. Falls back to each group's own workspace, then the API key's default_workspace, then global (NULL). When set explicitly, it overrides the workspace derived per-group from session synthesis. Recommended in multi-project setups to prevent cross-project session summary injection. |
| task_effectiveness | object | - | Session outcome and tool usage effectiveness assessment. Composed of outcome, evaluator, evidence, unmet_requirements, overall_success, tool_highlights, tool_pain_points. See the table below. |

#### task_effectiveness sub-fields

| Name | Type | Description |
|------|------|-------------|
| outcome | string | Task end state. `completed` (all requirements met), `partial` (only some met), `blocked` (external factor prevents progress), `abandoned` (dropped), `unknown` (undeterminable). Use `unknown` rather than guessing. Values outside the enum are discarded and stored as unreported (NULL). |
| evaluator | string | Who judged the outcome. `agent` (agent self-report), `automatic` (tests/builds), `human` (user confirmation). Stored only when outcome is recorded; defaults to `agent`. |
| evidence | string | Rationale for the outcome judgement. Truncated beyond 1000 characters. |
| unmet_requirements | string[] | Requirements left unmet. Capped at 20 items, each truncated to 200 characters. Spell out what remains for partial/blocked/abandoned. |
| overall_success | boolean | Compatibility field. Stored verbatim when supplied; when omitted it is derived as true only if outcome is `completed`. |
| tool_highlights | string[] | Tools that helped |
| tool_pain_points | string[] | Tools that got in the way |

`task_effectiveness` is written to `agent_memory.task_feedback`; the `outcome`, `evaluator`, `evidence`, and `unmet_requirements` columns were added in migration-039. Aggregates surface in the `evaluation` block of `memory_stats`.

### Response Structure

```json
{
  "count": 5,
  "fragments": [
    { "id": "frag-...", "content": "...", "type": "fact", "keywords": ["..."] }
  ],
  "breakdown": {
    "summary": 2,
    "decisions": 1,
    "errors": 0,
    "procedures": 1,
    "questions": 1,
    "episode": 1
  },
  "groups": [
    { "workspace": "memento-mcp", "topic": "session_reflect", "caseId": "debug-recall-2026-08-16", "fragmentIds": ["frag-...", "frag-..."] }
  ]
}
```

`breakdown` reports the number of fragments stored per category; `episode` is present only when a narrative_summary was produced. Internally all five categories go through a single `batchRememberProcessor` call, but the result is re-tallied per category via `_category` metadata, preserving the breakdown shape.

When `sessionId` is provided, session fragments are synthesized separately per workspace → case_id → topic group. The `groups` field returns one entry per group (`workspace`, `topic`, `caseId`, and `fragmentIds` — the fragments created for that group, including the episode fragment id when a narrative_summary was produced). Groups with different workspaces each stamp their own workspace on their fragments. Without `sessionId`, `params` (summary/decisions/...) itself is treated as a single group (legacy path).

---

## MCP Tool — context

Loads Core Memory + Working Memory + session_reflect separately. Injects preference, error, procedure, decision fragments at session start to maintain context.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| tokenBudget | number | - | Maximum token count (default 2000) |
| types | string[] | - | Types to load (default: preference, error, procedure) |
| sessionId | string | - | Session ID (for Working Memory loading) |
| agentId | string | - | Agent ID |
| workspace | string | - | Workspace filter. When specified, returns only fragments from the given workspace + global (NULL) fragments. Key's default_workspace applied if not specified. |
| structured | boolean | - | When true, returns hierarchical tree structure; when false/omitted, returns existing flat list (default: false) |
| includeKeyName | boolean | - | When true, each fragment carries key_id and key_name (the access key label). Only information within the same key group scope is exposed, and it does not apply to the structured=true tree response. Default false. |

---

## MCP Tool — tool_feedback

Usefulness feedback on tool usage results. Evaluates whether the target tool's results were relevant and sufficient.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| tool_name | string | Y | Name of the tool being evaluated |
| relevant | boolean | Y | Were the results relevant to the request intent |
| sufficient | boolean | Y | Were the results sufficient to complete the task |
| suggestion | string | - | Improvement suggestion (100 characters max) |
| context | string | - | Usage context summary (50 characters max) |
| session_id | string | - | Session ID |
| trigger_type | string | - | Trigger type. sampled=hook sampling or a reply to a write tool's `feedback_sampled` hint, voluntary=AI voluntary (default voluntary) |
| irrelevance_reason | string | - | Why the result was judged irrelevant. `not_stored` (never stored), `search_miss` (stored but not retrieved), `scope_leak` (leaked in from another scope), `topic_mismatch` (wrong subject), `other`. Meaningful only when `relevant=false`; other calls and values outside the enum are discarded and stored as NULL. The distribution is aggregated as `irrelevance_breakdown` in `memory_stats`. |
| search_event_id | integer | - | _meta.searchEventId returned by the most recent recall. Used for search quality analysis. |
| fragment_ids | string[] | - | Fragment ID list for feedback targets. When provided, activation scores of the specified fragments are adjusted based on the feedback. |

---

## MCP Tool — memory_stats

Query fragment memory system statistics. Returns total fragment count, TTL distribution, and per-type statistics.

### Parameters

No parameters.

### Response — `stats.evaluation`

Returns search quality and downstream task outcome indicators. Ratio fields are null when the database is unavailable or no samples exist.

| Field | Type | Description |
|-------|------|-------------|
| rolling_precision_at_5 | number \| null | Rolling Precision@5 over the last 100 sessions |
| sufficient_rate | number \| null | Share of tool_feedback entries with sufficient=true |
| sample_sessions | number | Sessions used to compute precision |
| task_success_rate | number \| null | Share of `overall_success=true` over the last 30 days, denominated by every task_feedback row |
| task_sessions | number | task_feedback rows in the last 30 days |
| task_completed_rate | number \| null | Share of `outcome='completed'` over the last 30 days, denominated only by sessions that actually reported an outcome (unreported sessions are not counted as failures) |
| task_outcome_reported | number | Sessions that reported an outcome |
| task_outcome_counts | object \| null | Outcome distribution: `completed`, `partial`, `blocked`, `abandoned`, `unknown`, `unreported` |
| irrelevance_breakdown | object \| null | Cause distribution for `relevant=false` feedback: `total_irrelevant`, `reported` (entries carrying a reason), and `counts` (`not_stored`, `search_miss`, `scope_leak`, `topic_mismatch`, `other`, `unreported`) |

Within `irrelevance_breakdown.counts`, a `not_stored` majority points at storage habits, `search_miss` at search recall, and `scope_leak` at scope isolation.

### Response — `stats.workspaces`

Returns workspace fill status and per-session fragment distribution.

| Field | Type | Description |
|-------|------|-------------|
| distribution.top | array | Top workspaces by fragment count, `{workspace, count}` (descending) |
| distribution.null_count | number | Fragments with no workspace (NULL, global) |
| distribution.distinct_count | number | Distinct count of non-null workspace values |
| key_fill_rate | array | Per-API-key workspace fill rate, `{key_id, key_name, total, with_workspace, fill_rate}`. `fill_rate` is `with_workspace / total` |
| session_fragment_distribution | object | Fragment-count-per-session distribution over the last 30 days, `{p50, p90, max, sample_sessions}`. `p50`/`p90`/`max` are `null` when there is no sample |

---

## MCP Tool — memory_consolidate

Execute fragment memory maintenance. Performs TTL transitions, importance decay, expiration deletion, and duplicate merging.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| stream | boolean | - | Deprecated. No SSE progress events are emitted any more. Kept in the schema for backward compatibility; it has no effect. |

---

## MCP Tool — session_rotate

Closes the current session and issues a new `sessionId`. Use it when a token leak is suspected or on a rotation schedule. The same `bound_key_id`, `workspace`, and `permissions` carry over to the new session.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| reason | string | - | Rotation reason recorded in the audit log (max 256 characters). Examples: `scheduled_rotation`, `suspected_leak`, `user_request` |

---

## MCP Tool — graph_explore

Traces causal relationship chains starting from an error fragment. Dedicated to RCA (Root Cause Analysis). Follows caused_by, resolved_by relationships for 1-hop to connect error causes with resolution procedures.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| startId | string | Y | Starting fragment ID (error fragment recommended) |
| agentId | string | - | Agent ID |

---

## MCP Tool — fragment_history

Query the complete change history of a fragment. Returns previous versions modified via amend and superseded_by chains.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Y | Fragment ID to query |
| agentId | string | - | Agent ID |
| includePeerAgents | boolean | - | When true, also returns version history for other agentIds within the same API key scope. The tenant (key) boundary is never relaxed. Default false. |

---

## MCP Tool — get_skill_guide

Returns the AnchorMind best practices guide. Comprehensive skill reference covering memory tool usage, session lifecycle, keyword rules, search strategies, experiential memory usage, and more.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| section | string | - | Query a specific section only. Returns full guide if not specified. Possible values: overview, lifecycle, keywords, search, episode, multiplatform, codex, tools, importance, experiential, cbr, triggers, antipatterns |

---

## MCP Tool — reconstruct_history

Reconstruct work history chronologically based on case_id or entity. Restores narrative including causal chains and unresolved branches.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| caseId | string | - | Case identifier to reconstruct |
| entity | string | - | entity_key filter (used when caseId is absent) |
| timeRange | object | - | ISO 8601 time range. Includes from (start time), to (end time). |
| query | string | - | Additional keyword filter |
| limit | number | - | Default 100, max 500 |
| workspace | string | - | Workspace filter. When specified, only fragments from the given workspace + global (NULL) fragments are targeted. |

### Returns

- `ordered_timeline`: fragments in chronological order; each item includes agent_id to identify the contributing agent in multi-agent cases.
- `causal_chains`, `unresolved_branches`.

---

## MCP Tool — search_traces

Search fragments by exact matching (unlike recall's semantic search, uses content/type/case_id text matching). Filter by event_type, entity, and keywords to grep-like scan the full history.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| event_type | string | - | Fragment type to filter (fact, error, decision, etc.) |
| eventType | string | - | camelCase alias for event_type |
| entity_key | string | - | Topic ILIKE filter |
| entityKey | string | - | camelCase alias for entity_key |
| keyword | string | - | Keyword search within content |
| case_id | string | - | Case ID filter |
| caseId | string | - | camelCase alias for case_id |
| session_id | string | - | Session ID filter |
| sessionId | string | - | camelCase alias for session_id |
| time_range | object | - | Time range filter. Includes from (start time, ISO 8601), to (end time, ISO 8601). |
| limit | number | - | Default 20, max 100 |
| workspace | string | - | Workspace filter. When specified, only fragments from the given workspace + global (NULL) fragments are targeted. |

---

## Usage Examples

### Sparse response with fields parameter

Return only id, content, importance to reduce token usage:

```bash
curl -X POST https://anchormind.example.com/mcp \
  -H "Authorization: Bearer $MEMENTO_KEY" \
  -H "Mcp-Session-Id: $SESSION" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{
      "name":"recall",
      "arguments":{
        "keywords":["nginx","502"],
        "fields":["id","content","importance","type"]
      }
    }
  }'
```

### Retry-safe storage with idempotencyKey

No duplicate creation when resending after a network failure:

```json
{
  "method": "tools/call",
  "params": {
    "name": "remember",
    "arguments": {
      "content": "Changed nginx upstream port from 8080 to 15001 to resolve 502 error",
      "topic": "nginx",
      "type": "procedure",
      "importance": 0.8,
      "idempotencyKey": "nginx-fix-2026-04-20-001"
    }
  }
}
```

Re-call response with the same `idempotencyKey`:
```json
{ "success": true, "id": "frag-abc123", "idempotent": true }
```

### Confirm plan before storage with dryRun=true

```json
{
  "method": "tools/call",
  "params": {
    "name": "remember",
    "arguments": {
      "content": "Redis Sentinel connection failure — REDIS_SENTINEL_ENABLED not set",
      "topic": "redis",
      "type": "error",
      "dryRun": true
    }
  }
}
```

Response:
```json
{
  "dryRun": true,
  "simulated": {
    "fragment": { "content": "Redis Sentinel connection failure — REDIS_SENTINEL_ENABLED not set", "type": "error", "topic": "redis" },
    "conflicts": [],
    "validation_warnings": [],
    "quota": { "used": 120, "limit": 5000, "remaining": 4880 }
  }
}
```

---

## Recommended Usage Flow

- Session start -- Call `context()` to load core memories. Preferences, error patterns, and procedures are restored. If unreflected sessions exist, a hint is displayed.
- During work -- Save important decisions, errors, and procedures with `remember()`. Similar fragments are automatically linked at storage time. Use `recall()` to search past experience when needed. After resolving an error, clean up the error fragment with `forget()` and record the resolution procedure with `remember()`.
- Session end -- Use `reflect()` to persist session content as structured fragments. Even without manual invocation, AutoReflect runs automatically on session end/expiration.

---

## Key Environment Variables — Tool Behavior Impact

| Variable | Default | Scope of Impact |
|-|-|-|
| `MEMENTO_REMEMBER_ATOMIC` | `false` | When `true`, the remember path switches to `_rememberAtomic`. Quota re-validation and INSERT are handled atomically within a single BEGIN/COMMIT transaction using `SELECT api_keys FOR UPDATE`. `_runPolicyGate` runs identically on both paths, so the `validation_warnings` format is unchanged. |
| `MEMENTO_CASE_BACKPROP_ENABLED` | `false` | When `true`, amending a fragment with a case_id (specifically changing resolutionStatus) triggers importance backpropagation to all fragments sharing the same caseId. Exported as the `CASE_BACKPROP_ENABLED` constant in `lib/config.js`. Boosts activation scores of related fragments after case resolution, improving subsequent recall precision. |
| `MEMENTO_STORAGE` | `pgvector` | Selects the storage adapter. `pgvector` (default, production PgVectorStore) or `sqlite-vec` (SqliteVecStore). The `transaction(fn)` interface is preserved across adapters, so write-path concurrency semantics remain consistent. |
| `MEMENTO_SYMBOLIC_POLICY_RULES` | `false` | When `true`, `_runPolicyGate` evaluates PolicyRules soft gates and accumulates failed rule names into `validation_warnings`. |
| `MEMENTO_FEEDBACK_SAMPLING` | `true` | Attaches the `feedback_sampled` hint to successful remember/amend/forget responses with a fixed probability. When `false`, no hint is attached and response shapes are unchanged. |

---

## Related Documents

- [Local Embedding Setup](embedding-local.md) -- Detailed instructions for switching to `EMBEDDING_PROVIDER=transformers`
- [Integration/E2E Tests](../tests/integration/README.md) -- Test environment setup and execution
- [Architecture](architecture.en.md) -- Component dependencies and search pipeline
- [Configuration Reference](configuration.en.md) -- Complete environment variable list and MEMORY_CONFIG
