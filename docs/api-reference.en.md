# API Reference

For MCP tool details, see [SKILL.md](../SKILL.md).

---

## HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /mcp | Streamable HTTP. JSON-RPC request receiver. MCP-Session-Id header required (except initial initialize) |
| GET | /mcp | Streamable HTTP. Opens SSE stream. For server-side push |
| DELETE | /mcp | Streamable HTTP. Explicit session termination |
| GET | /sse | Legacy SSE. Session creation. Authenticate with the `Authorization: Bearer` header. The `?accessKey=` query is a master-key-only compatibility path; `MEMENTO_SSE_QUERY_KEY=deny` returns 401. Subject to a per-client-IP request limit (`RATE_LIMIT_PER_IP`, default 30 per minute) that shares one bucket with `/token`, `/register`, `/authorize` and `initialize`; above it the server answers 429 with `Retry-After` |
| POST | /message?sessionId= | Legacy SSE. JSON-RPC request receiver. Responses delivered via SSE stream |
| GET | /health | Health check. Verifies DB query (SELECT 1), session state, and Redis connection, returning JSON. When `REDIS_ENABLED=false`, Redis shows as `disabled` with 200 returned. DB failure returns 503. Without master key authentication the body is only `{status, timestamp}`; services and worker details are included when authenticated |
| GET | /health/live | Process liveness. Always 200 `{status: "alive", uptime}` without authentication. Does not check the DB or Redis |
| GET | /health/ready | Readiness. 200 `{status: "ready"}` when the primary DB responds within `MEMENTO_HEALTH_READY_DB_TIMEOUT_MS` (default 2000), otherwise 503 `{status: "not_ready", reason}` where `reason` is `db_timeout` or `db_error`. No authentication |
| GET | /metrics | Prometheus metrics. HTTP request counters, session gauges, etc. collected by prom-client. Requires the master key when `MEMENTO_ACCESS_KEY` is set (otherwise 401) |
| GET | /openapi.json | OpenAPI 3.1.0 spec. Authentication required. Master key returns full paths including Admin REST API; API key returns a spec filtered to tools matching the key's `permissions` array. Enabled via `ENABLE_OPENAPI=true` env var. Returns 404 when disabled. |
| GET, HEAD | /.well-known/oauth-authorization-server | OAuth 2.0 authorization server metadata |
| GET, HEAD | /.well-known/oauth-protected-resource | OAuth 2.0 protected resource metadata |
| GET | /authorize | OAuth 2.0 authorization endpoint. PKCE code_challenge required |
| POST | /token | OAuth 2.0 token endpoint. authorization_code exchange and refresh_token renewal |
| POST | /authorize | OAuth 2.0 consent form submission (allow/deny) |
| POST | /register | RFC 7591 dynamic client registration. A per-IP rate limit and a per-process hourly registration cap (`MEMENTO_DCR_MAX_PER_HOUR`, default 100, 0 means no cap) apply. Key-bound registrations and other registrations are counted separately. Above the cap the server answers 429 with `Retry-After` set to the seconds remaining in the current window |
| POST | /session/rotate | Reissue the session ID. See the section below |
| POST | /hooks/{client}/{event} | Harness hooks. `client` is `claude-code` or `codex`; `event` is `SessionStart` (200 with context as `hookSpecificOutput.additionalContext`), `Stop` or `SessionEnd` (records the summary candidate in the outbox and answers 202). Bearer API key authentication; 404 with `MEMENTO_HOOK_ENDPOINTS=off`. Limits and response codes are in [configuration.en.md](configuration.en.md#hook-endpoints), setup examples in [getting-started/hooks.en.md](getting-started/hooks.en.md) |
| GET | /v1/internal/model/nothing | Admin SPA. Serves app shell HTML after master key authentication; unauthenticated requests receive 401 and the login page. Data APIs require master key authentication |
| GET | /v1/internal/model/nothing/assets/* | Admin static files (admin.css, admin.js). No authentication required |
| GET | /v1/internal/model/nothing/images/* | Admin image files. Master key authentication required |
| POST | /v1/internal/model/nothing/auth | Master key verification endpoint (admin account login: see "Admin Accounts" below). Per-IP rate limit applies (as for `/keys` POST, `/import` POST, `/me` GET and `/me/explain` GET). With `MEMENTO_ADMIN_AUTH_BACKOFF=on`, after 5 consecutive failures the next attempt is delayed 1, 2, 4 seconds and so on up to 60 seconds, and during the delay even the correct key receives 429 with `Retry-After` |
| GET | /v1/internal/model/nothing/stats | Dashboard statistics (fragment count, API call volume, system metrics, searchMetrics, observability, queues, healthFlags, switches) |
| GET | /v1/internal/model/nothing/activity | Recent fragment activity log (10 entries) |
| GET | /v1/internal/model/nothing/metrics-summary | Dashboard metrics summary |
| GET | /v1/internal/model/nothing/keys | API key list. Includes the policy columns (`default_mode`, `allowed_workspaces`, `symbolic_hard_gate`) and the lifecycle columns (`expires_at`, `description`, `owner`, `kind`, `allowed_cidrs`, `revoked_at`, `revoked_by`, `revoke_reason`, `access_reviewed_at`, `access_reviewed_by`, and the rotation overlap end `rotation_overlap_until`) |
| POST | /v1/internal/model/nothing/keys | Create API key. Raw key returned in response exactly once. `permissions` is an array with at least one of `read` and `write`, optionally with the marker permissions (provenance trust marker `trusted_origin`, anchor designation permission `anchor`), and defaults to `DEFAULT_PERMISSIONS` when omitted; an empty array, `null`, an array with only marker permissions or any other value returns 400. It may also carry one review queue mode marker: `review_off` (no review flags for that key) or `review_all` (every write of that key goes into review). The lifecycle columns (`expires_at`, `description`, `owner`, `kind`, `allowed_cidrs`) may be given as well (rules in the key lifecycle section below) |
| PUT | /v1/internal/model/nothing/keys/:id | Change API key status (active <-> inactive). Activating a revoked key returns 409 `key_revoked` |
| PATCH | /v1/internal/model/nothing/keys/:id | Change the API key lifecycle columns (`expires_at`, `description`, `owner`, `kind`, `allowed_cidrs`). See the key lifecycle section below |
| POST | /v1/internal/model/nothing/keys/:id/rotate | Issue a new raw key (returned once). The previous key stays valid for `graceHours`. See the key lifecycle section below |
| POST | /v1/internal/model/nothing/keys/:id/revoke | Revoke the key and all of its secrets. Body `{ "reason": "..." }` is required. Cannot be undone |
| POST | /v1/internal/model/nothing/keys/:id/access-review | Record an access review signature (review time and actor) |
| GET | /v1/internal/model/nothing/keys/:id/stats | Per-key usage statistics |
| PUT | /v1/internal/model/nothing/keys/:id/daily-limit | Change API key daily call limit. Master key required |
| PUT | /v1/internal/model/nothing/keys/:id/permissions | Change API key permissions. Accepted values are the same as for POST (at least one of `read` and `write`, optionally the marker permissions `trusted_origin`, `anchor`, `review_off`, `review_all`). An empty array and an array with only marker permissions return 400. Only keys with `anchor` can designate anchors (`MEMENTO_ANCHOR_PERMISSION`). A key with `trusted_origin` can reach trust tier 3 through the `origin` claim of remember; other keys are capped at 2 (`MEMENTO_PROVENANCE`). At most one of the review mode markers `review_off` and `review_all` may be present; both return 400 (`MEMENTO_REVIEW_QUEUE`). The permissions before and after the change are written to the audit log |
| PUT | /v1/internal/model/nothing/keys/:id/fragment-limit | Change API key fragment quota |
| PATCH | /v1/internal/model/nothing/keys/:id/workspace | Change API key's default_workspace. `{ workspace: "name" }` or `{ workspace: null }` (null=unset) |
| PATCH | /v1/internal/model/nothing/keys/:id/policy | Change API key policy columns. The body carries at least one of `default_mode`, `allowed_workspaces`, `symbolic_hard_gate`, `egress_policy`. See the section below |
| DELETE | /v1/internal/model/nothing/keys/:id | Delete API key (204 on success). A key that has stored fragments or reconsolidation history is not deleted and the server answers 409 `key_in_use` (`MEMENTO_API_KEY_DELETE_GUARD=false` skips the check). Disabling or deleting a key closes that key's sessions in this process immediately |
| GET | /v1/internal/model/nothing/review | Pending review fragments, oldest first. Query `key_id` (`master` for fragments written by the master key), `limit` (1 to 200, default 50), `cursor` (`nextCursor` of the previous response). Items carry `id`, `key_id`, `key_name`, `agent_id`, `workspace`, `type`, `topic`, `content_preview` (500 characters), `review_reasons`, `origin`, `trust_tier`, `is_anchor`, `created_at`, `auto_reject_at` (30 days after creation). Invalid values return 400 with `field` |
| POST | /v1/internal/model/nothing/review/:id/approve | Approve a pending fragment. Body `note` (at most 500 characters, stored with sensitive data masked), `idempotencyKey` (or the `Idempotency-Key` header, 1 to 128 characters of `[A-Za-z0-9._:-]`) and `applyAnchor` (boolean). Sets `review_state` to `approved`. A held anchor request (`anchor_requested`) is applied only when the decision-time check passes (`anchor` or `admin` in the key permission list; the master key is allowed); an unauthorized anchor request (`anchor_unauthorized`) only with `applyAnchor: true`; `applyAnchor: false` never applies it. The response carries `decisionId`, `fragmentId`, `decision`, `reviewer`, `keyId`, `decidedAt`, `replayed` (true for a repeated request with the same idempotency key, concurrent ones included), `anchorApplied` and `anchorReason` (`not_requested`, `permitted`, `master`, `permission`, `explicit`, `explicit_required`, `declined`). A missing fragment returns 404, a fragment that is not pending 409 (`state`), an idempotency key used for a different decision 409 (`field: idempotencyKey`) |
| POST | /v1/internal/model/nothing/review/:id/reject | Reject a pending fragment. Body and response as for approve. Sets `review_state` to `rejected` and `valid_to`, so the fragment becomes expired. The decision is stored in `memory_review_decisions` and one `admin review_decision` audit line is written |
| GET | /v1/internal/model/nothing/groups | Key group list |
| POST | /v1/internal/model/nothing/groups | Create key group |
| DELETE | /v1/internal/model/nothing/groups/:id | Delete key group |
| GET | /v1/internal/model/nothing/groups/:id/members | Group member list |
| POST | /v1/internal/model/nothing/groups/:id/members | Add key to group |
| DELETE | /v1/internal/model/nothing/groups/:gid/members/:kid | Remove key from group |
| GET | /v1/internal/model/nothing/memory/overview | Memory overview (type/topic distribution, quality unverified, superseded, recent activity) |
| GET | /v1/internal/model/nothing/memory/search-events?days=N | Search event analysis (total searches, failed queries, feedback stats) |
| GET | /v1/internal/model/nothing/memory/fragments | Fragment search/filter (topic, type, key_id, workspace, page, limit) |
| POST | /v1/internal/model/nothing/memory/fragments | Create fragment |
| GET | /v1/internal/model/nothing/memory/fragments/:id | Fragment detail |
| GET | /v1/internal/model/nothing/memory/fragments/:id/history | Fragment change history |
| PATCH | /v1/internal/model/nothing/memory/fragments/:id | Update fragment |
| DELETE | /v1/internal/model/nothing/memory/fragments/:id | Delete fragment |
| GET | /v1/internal/model/nothing/memory/anomalies | Anomaly detection results |
| POST | /v1/internal/model/nothing/search | Key-scoped recall proxy (key_ids, keywords, text, type, topic, pageSize) |
| GET | /v1/internal/model/nothing/search-events | Search event list |
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
| GET | /v1/internal/model/nothing/export?key_id=&topic= | Fragment JSON Lines stream export (format version 2, with links and optional history). See "Export and import" below |
| POST | /v1/internal/model/nothing/import | Fragment import (JSON body or an export file as is). See "Export and import" below |
| GET | /v1/internal/model/nothing/audit | Audit record list (newest first). See "Audit" below |
| GET | /v1/internal/model/nothing/audit/export?format=jsonl | Audit record JSON Lines export (seq ascending, hashes on every line) |
| POST | /v1/internal/model/nothing/audit/verify | Audit hash chain verification |
| GET | /v1/internal/model/nothing/me | Kind, roles, capabilities and ranges of the requesting principal. See "Admin Authorization" below |
| GET | /v1/internal/model/nothing/me/explain?cap=&workspace= | Decision and per-step reasons for one capability. See "Admin Authorization" below |
| POST | /v1/internal/model/nothing/auth/totp | Completes admin account TOTP enrollment `{ enrollToken, code }`. On success returns 10 recovery codes (once) and session cookies. See "Admin Accounts" below |
| POST | /v1/internal/model/nothing/auth/logout | Revokes the admin account session family and clears the cookies. For the master key principal it changes nothing and returns 200 |
| GET | /v1/internal/model/nothing/admin-users | Admin account list (capability `admin_user.manage`) |
| POST | /v1/internal/model/nothing/admin-users/bootstrap | Creates the first owner (master key principal, only with zero accounts) |
| POST | /v1/internal/model/nothing/admin-users | Creates an account `{ username, password, roles }` |
| PATCH | /v1/internal/model/nothing/admin-users/:id | Changes status (`active`, `disabled`) and password |
| DELETE | /v1/internal/model/nothing/admin-users/:id | Deletes an account |
| PUT | /v1/internal/model/nothing/admin-users/:id/roles | Replaces role bindings `{ roles: [{ role, workspace? }] }` |
| POST | /v1/internal/model/nothing/admin-users/:id/totp-reset | Resets TOTP and recovery codes, revokes sessions |
| DELETE | /v1/internal/model/nothing/admin-users/:id/sessions | Revokes every session of the account |

### Export and import

Format versions and compatibility rules are defined in the [API and Export Format Version Policy](api-versioning.en.md).

Export `GET /export`

| Query parameter | Description |
|-|-|
| `key_id`, `key_ids`, `group_id` | Scope. One is required; everything is exported only with `confirm=full` |
| `topic`, `type` | Topic (partial match) and type filters |
| `format_version` | `2` (default) or `1`. Without it the `version` parameter of `Accept` is used, otherwise `2`. A value that cannot be produced gets 406 `unsupported_export_version` with the supported list |
| `include_links` | `false` leaves out link lines (version 2) |
| `include_versions` | `true` adds amendment history lines (version 2) |

The response is `application/x-ndjson` with `X-Memento-Export-Format-Version` and `Vary: Accept` headers. In version 2 the first line is the header and the last line is the end line. An error after lines were sent closes the connection without the end line, and import reports a file without an end line with a `trailer_missing` warning. Fragments are read in id ordered batches.

Import `POST /import`

| Query parameter | Description |
|-|-|
| `key_id` | Target key. Without it the scope is master (`key_id` NULL). An unknown key gets 404. The `key_id` of a file row is never read |
| `dryRun` | `true` processes through the same path and rolls back at the end. The counts equal those of a real run and no gate metrics are recorded. It is one transaction and holds the locks of the rows it wrote until it ends, so run it when no other work writes the same fragments and split files into about 5000 fragment lines each |
| `restore` | `trusted` restores stored values (format version 2 files only, recorded in the audit log). Any other value gets 400 |

The body is JSON `{"fragments": [...], "links": [...], "versions": [...]}` (`links` and `versions` are optional and make it a version 2 file) or an export file as is with `Content-Type` `application/x-ndjson` or `application/jsonl`. The JSON body limit is 2 MiB; larger imports use ndjson bodies, accepted up to 64 MiB. An ndjson body is read completely and then split into lines, so memory use at the maximum size is about 3 times the body size. The response is sent after the import ends, so raise the read timeout of the proxy in front (`proxy_read_timeout` in nginx and similar) to fit the file size or split the file. A fragment line needs `content` and `topic`; `type` defaults to `fact`. Every line goes through the semantic write gate and is written by FragmentWriter, with one transaction per fragment line. Newly written fragments are queued for embedding.

Response (field structure):

```json
{
  "dryRun": false,
  "restore": false,
  "format": { "version": 2 },
  "lines": 12,
  "imported": 9, "duplicates": 2, "skipped": 2, "rejected": 1, "errors": 0,
  "rejected_by_reason": { "input_invalid": 1 },
  "fragments": { "imported": 9, "duplicates": 2, "rejected": 1, "errors": 0 },
  "links": { "imported": 5, "duplicates": 0, "rejected": 0, "errors": 0 },
  "versions": { "imported": 0, "duplicates": 0, "rejected": 0, "errors": 0 },
  "transformed": 0,
  "transformed_by_reason": {},
  "ignored": { "key_id": 0, "is_anchor": 0 },
  "embedding_queued": 9,
  "warnings": [],
  "rejected_samples": [{ "entity": "fragments", "reason": "input_invalid", "line": 4, "detail": "..." }],
  "error_samples": []
}
```

- Top level `imported`, `duplicates`, `rejected` and `errors` are the fragment counts, and `skipped` equals `duplicates`. A row falls in exactly one of imported, duplicates, rejected and errors.
- Reasons in `rejected_by_reason`: `invalid_json` (the line is not JSON), `invalid_record` (unknown record kind, or a link or version line in a version 1 file), `invalid_row` (no `content` or `topic`), `input_invalid` (gate rejection: below minimum quality, over 4000 characters, malformed keywords), `policy_violation` (policy violation on a hard-gate key), `id_conflict` (same id with different content; the same content created a moment ago by a concurrent import is checked once more and counted as a duplicate), `idempotency_conflict` (an `idempotency_key` used by another row), `database_rejected` (the database rejected the values), `link_invalid`, `link_endpoint_missing`, `version_fragment_missing`. Every rejection is counted and `rejected_samples` holds at most 20.
- `duplicates` are rows whose content is already stored (within the key scope). Importing the same file again makes every row a duplicate.
- `errors` are database failures that are not about the row. The request then gets 500 and the counts so far are in `partial`.
- `transformed` is the number of newly written rows whose values differ from the file, and `transformed_by_reason` counts them per reason. `content` is the gate changing the content (storage length cut, masking, trimming) and `importance` is the per-type cap lowering the value on storage. A row with both reasons counts once in `transformed` and once per reason.
- `ignored` counts the `key_id` values in the file that were not applied and the `is_anchor` values ignored when the path is not the owner path.
- A format version that cannot be read gets 400 `unsupported_format_version`, input with no header line, no end line and no recognizable record gets 400 `no_valid_records` (counts in `partial`), a malformed JSON body gets 400, and an oversized body gets 413. A JSON body of the form `{"fragments": [...]}` is handled as a version 2 structured request body and not as a file: it carries no version 1 deprecation marker and does not accept `restore=trusted`.

### Audit

Admin requests other than GET, admin logins, memory writes (remember, amend, forget, link), anchors and write gate rejections are recorded in the `admin_audit_events` hash chain. Scope, detail rules, chain structure and switches are in [configuration.en.md](configuration.en.md#audit-table).

List `GET /audit`

| Query parameter | Description |
|-|-|
| `action` | Action name (`admin.key.policy_update`) or a prefix ending in `.*` (`admin.*`, `memory.*`) |
| `actor` | `master`, `anonymous`, `system` or a key id |
| `target_type`, `target_id` | Target type (`api_key`, `key_group`, `fragment`, `topic`, `session`) and id |
| `outcome` | `success`, `failure`, `denied` |
| `workspace` | Workspace name |
| `from`, `to` | Occurrence time range (ISO times, `to` excluded) |
| `before` | Only rows with a smaller seq (load-more cursor) |
| `limit` | 1 to 200, default 50 |

The response is `{ "events": [...], "nextBefore": n | null }`. Rows carry `seq`, `sourceEvent`, `occurredAt`, `recordedAt`, `action`, `outcome`, `actorKind`, `actorKeyId`, `actorSession` (first 8 characters), `actorIp`, `targetType`, `targetId`, `workspace`, `detail`, `prevHash`, `rowHash`. `nextBefore` is the `before` value of the next page when the page is full. A malformed parameter gets 400 with `field`; without the audit table (migration-056 not applied) the answer is 503.

Export `GET /audit/export?format=jsonl` streams the rows matching the same filters (without `limit`) in seq order, one per line (`application/x-ndjson`, `audit-events.jsonl`). `format` accepts only `jsonl`. Every line carries `prevHash` and `rowHash`, so an unfiltered export can be verified outside the server with the same rules.

Verification `POST /audit/verify` takes an optional body (`{ "fromSeq": n, "maxRows": n }`, `maxRows` default and limit 1000000). Example response (field structure):

```json
{
  "ok": false, "checked": 41, "firstSeq": 1, "lastSeq": 41,
  "anchor": "genesis", "anchorHash": "000...0", "headHash": null,
  "complete": false, "broken": { "seq": 42, "reason": "row_hash_mismatch" }
}
```

`anchor` is `genesis` (starting at seq 1), `checkpoint` (boundary hash of the checkpoint row written by retention cleanup) or `previous_row` (the row just before `fromSeq`). `broken.reason` is `row_hash_mismatch`, `prev_hash_mismatch`, `seq_gap` or `prefix_mismatch` (leading part removed without a checkpoint). `complete` is `true` when the check reached the end and `false` when it stopped at `maxRows`. The export and verification requests themselves are recorded as `admin.audit.export` and `admin.audit.verify`; list queries (`GET /audit`) are not recorded. Rows are ordered by seq (write order), which can differ from the `occurredAt` order.

### Admin Authorization

Every admin API request is decided against the route table (`lib/admin/admin-route-table.js`), which declares the required capability of each route. Enforcement is always on. The master key (Bearer or a master key login session) is owner and passes every route. A path that is not in the route table requires the owner-only capability (`system.update`). A denial is 403 `{ "error": "Forbidden", "cap", "deniedAt", "reason" }`, and a denied non-GET request is recorded in the audit log as `denied`.

The capabilities are `mem.read`, `mem.write`, `mem.anchor`, `mem.delete.soft`, `mem.delete.hard`, `mem.bulk`, `mem.merge`, `review.decide`, `export.data`, `import.data`, `key.manage`, `key.policy`, `egress.policy`, `ws.create`, `ws.quota`, `retention.manage`, `legal_hold.manage`, `erasure.request`, `erasure.execute`, `job.dry_run`, `job.apply`, `audit.read`, `audit.export`, `webhook.manage`, `usage.read`, `quality.read`, `logs.read`, `oauth_client.manage`, `admin_user.manage`, `system.update`. `logs.read` reads the server log files (which carry request paths, client addresses and raw error messages) and is held only by owner and admin. A role is a capability bundle (preset); there are 6 Core presets. Mode O is the whole binding range, W is limited to the bound workspace, M is metadata only (content as hash and length), S is limited to the key scope.

| Preset | Capabilities |
|-|-|
| owner | all (O) |
| admin | all except `legal_hold.manage`, `erasure.execute`, `admin_user.manage`, `system.update` (O) |
| reviewer | `mem.read` (W), `review.decide` (W) |
| auditor | `mem.read` (M), `export.data` (M), `audit.read`, `audit.export`, `usage.read`, `quality.read` (O) |
| viewer | `mem.read`, `usage.read`, `quality.read` (W) |
| service | `mem.read`, `mem.write`, `mem.anchor`, `mem.delete.soft` (S) |

Decision table:

1. Principal: the master key is owner, an admin session is the union of its role bindings, an API key holds the capabilities its `permissions` convert to within the service preset (`read` is `mem.read`, `write` is `mem.write` and `mem.delete.soft`, `anchor` is `mem.anchor`).
2. The capability set is the union of the binding presets minus explicit denials. Denial wins.
3. The workspace range is the intersection of the workspaces of the bindings that grant the capability (a global binding is everything), the key `allowed_workspaces` (API keys; NULL means no restriction), and scope rows (if any row exists, combinations without a row are denied).
4. Allowed when the capability is held and the target workspace is in range. A request without a target workspace (global target) is allowed only when the range is everything. A denial records the step it stopped at (`principal`, `capability`, `deny`, `workspace`) and a reason.

The mode of an allowed decision is the widest one among the bindings that cover the target (bindings on the target workspace and global bindings; for a global target only global bindings). The query scope (`scope`) is everything only when a binding that gives that mode is global and the range is everything; otherwise it is the target workspace alone. For example, a principal that is viewer on workspace A and a global auditor receives a `workspace=A` list filtered to A in clear, and other workspaces and global targets masked.

Required capability per route: `/stats`, `/metrics-summary`, `/sessions`, `/sessions/:id` need `usage.read`; `/activity`, `/memory/overview`, `/memory/fragments` (list, detail, history), `/memory/graph`, `POST /search` need `mem.read`; `/memory/search-events`, `/memory/anomalies`, `/search-events` need `quality.read`; `/logs/*` needs `logs.read`; fragment create and update need `mem.write`; fragment delete needs `mem.delete.hard`; key and group listing, creation, status change, deletion and per-key stats need `key.manage`; daily limit, permissions, fragment quota, workspace and policy changes need `key.policy`; session cleanup, reflect-all, manual reflect and session close need `job.apply`; `/audit` and `POST /audit/verify` need `audit.read`; `/audit/export` needs `audit.export`; `/export` needs `export.data`; `/import` needs `import.data`. Routes whose scope kind is workspace (`/memory/overview`, `/memory/fragments` list and detail, `/memory/graph`) use the `workspace` query parameter as the target; the others (including fragment history and `/export`) have a global target. Handlers that call memory paths outside the admin modules (MemoryManager, search aggregates, export, import, session reflect) return 403 `full_scope_required` unless the query scope is everything. Session id routes (`/sessions/:id`, `/sessions/:id/reflect`) accept only the session id format (UUID); any other value is decided as a path that is not in the route table (owner only).

Queries in admin handlers that read memory tables (fragments, fragment_links, search_events, tool_feedback and others) carry the decision range predicate (`lib/admin/ScopeFilter.js`). The whole range is `TRUE`, a workspace list is `workspace = ANY($n)`, `fragment_links` keeps only links whose two end fragments are both in the list, other tables without a workspace column are `TRUE` only for the whole range, and a request that did not pass the decision gets `FALSE` (empty result). For metadata-only decisions (auditor `mem.read`, `export.data`) the response keeps only allow-listed values: numbers, booleans, null, values that match the format of identifier fields (`id`, `fragment_id`, `from_id`, `to_id`, `key_id`), enum fields (`type`, `kind`, `relation_type`, `direction`, `ttl_tier`, `assertion_status`, `resolution_status`, `query_type`) and time fields (`created_at` and others), and numeric strings of aggregate fields. Every other string becomes `{ "redacted": true, "sha256", "length" }`, and an object key that is not identifier-shaped becomes `redacted_<12 hex>`.

`GET /me` returns the requesting principal itself.

```json
{
  "principal": { "kind": "api_key", "id": "<key id>", "roles": ["service"] },
  "capabilities": [ { "cap": "mem.read", "mode": "S", "range": { "all": false, "workspaces": ["team-a"] } } ]
}
```

`GET /me/explain?cap=<capability>&workspace=<name>` returns the decision-table result. Fields are `allowed`, `cap`, `workspace`, `principal`, `mode`, `redact`, `range`, `deniedAt`, `reason`, `steps` (per-step `ok` and reasons; for API keys including `permissions`). A missing or unknown `cap` is 400 `field: "cap"`; a `workspace` longer than 128 characters or containing control characters is 400 `field: "workspace"`. Both routes accept the master key and an API key Bearer and only carry the requesting principal's own decision. An API key Bearer is an admin API principal only on these two routes; other admin routes return 401. During the admin auth delay (`MEMENTO_ADMIN_AUTH_BACKOFF`) both routes return 429 without a key lookup; otherwise they perform one API key lookup whether or not the token is the master key, and a wrong Bearer counts as an admin auth failure as on the other admin routes. An active API key authentication does not clear the delay counter.

### Admin Accounts

With `MEMENTO_ADMIN_USERS=on` (default) and at least one account, admins can log in with an account. Without accounts, or with `off`, only the master key is accepted.

- Login: `POST /auth` without an Authorization header, with `Content-Type: application/json` and `{ "username", "password", "totp" }` (or `"recoveryCode"`). Success is 200 `{ ok, user: { id, username }, csrf }` with the cookies `mmcp_admin` (HttpOnly, SameSite=Strict) and `mmcp_csrf`. Any failure is 401 `{ "error": "Invalid credentials" }`; during a delay 429 with `Retry-After`. When an owner or admin account has not enrolled TOTP yet the answer is 200 `{ enrollRequired: true, enrollToken, secret, otpauthUri, expiresInSec }`, completed with `POST /auth/totp`. Without a sealing key the answer is 503 `totp_seal_key_missing`. A present `Origin` must be an allowed origin (403 `csrf_origin_mismatch`).
- Session requests authenticate with the cookie. Requests other than GET, HEAD and OPTIONS need `Origin` (own origin or `ADMIN_ALLOWED_ORIGINS`) and `X-CSRF-Token: <mmcp_csrf value>`; otherwise 403 `csrf_origin_missing`, `csrf_origin_mismatch`, `csrf_token_missing` or `csrf_token_mismatch`.
- Principal: an account session shows `principal.kind = "admin_session"`, `roles` (binding roles) and `username` in `GET /me`. Capabilities and ranges come from the role bindings through the decision table in "Admin Authorization" (a global binding covers everything, a workspace binding that workspace).
- Account management errors: input errors 400 `{ field, reason }` (`password`: `too_short`, `too_long`, `blank`, `control_char`; `username`: `format`; `roles`: `unknown_role`, `owner_must_be_global`, `workspace_format`), 409 `last_owner`, `username_taken`, `bootstrap_required`, `already_bootstrapped`, 404 for an unknown account, 503 when the hash queue is full.
- Account values in responses carry no password hash and no TOTP secret (`id`, `username`, `status`, `roles`, `totpEnabled`, `createdAt`, `updatedAt`, `lastLoginAt`, `createdBy`). Settings and operating rules are in [configuration.en.md](configuration.en.md#admin-accounts).

### /health Endpoint Policy

| Dependency | Classification | Response when down |
|------------|---------------|-------------------|
| PostgreSQL | Required | 503 (unhealthy) |
| Redis | Optional | 200 (degraded). With `REDIS_ENABLED=false`: 200 (healthy, redis=disabled) |

When Redis is disabled (`REDIS_ENABLED=false`) the server returns healthy (200); when the Redis connection fails it returns degraded (200). L1 cache and Working Memory are deactivated, but core memory storage/retrieval operates fully on PostgreSQL alone.

Two authentication methods are available. Streamable HTTP authenticates via `Authorization: Bearer <MEMENTO_ACCESS_KEY>` header on the `initialize` request, then maintains the session. Legacy SSE also authenticates with the `Authorization: Bearer` header by default. The `/sse?accessKey=<MEMENTO_ACCESS_KEY>` query parameter is a master-key-only compatibility path and can be turned off with `MEMENTO_SSE_QUERY_KEY=deny`. Query values are recorded in proxy access logs.

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

- Master key (`MEMENTO_ACCESS_KEY`): identified by explicit trusted `isMaster=true`, granting access to all tools. Neither `permissions=null` nor `keyId=null` alone implies master authentication.
- API key (`mmcp_xxx`): tool access is restricted based on the `permissions` array specified at key creation time. Requests for tools not included in the array are immediately denied.
- Only tools registered in the `TOOL_PERMISSIONS` map can be called. A tool name missing from the map is refused for every caller, including the master key. Register every new tool in `TOOL_PERMISSIONS`.
- Three permission levels exist: `read` (recall/context etc.), `write` (remember/forget/amend etc.), and `admin` (memory_consolidate/apply_update etc.). The `admin` permission does not bypass tools that require explicit master authentication.
- Calling a tool without the required permission returns JSON-RPC error `-32001` whose `message` carries the reason (`Permission denied: '<tool>' requires '<level>' permission`). Master-only tools (memory_stats, memory_consolidate, check_update, apply_update) called with an API key return `-32001` with `Permission denied: '<tool>' requires master authentication`, and they are absent from that key's tools/list.
- When an API key has `allowed_workspaces`, the read tools (recall, context, graph_explore, fragment_history, reconstruct_history, search_traces) and resources/read read only the listed workspaces and global (no workspace) fragments. The check applies to the request's effective workspace (the explicit `workspace`, else the key's default workspace, else global). With `MEMENTO_WORKSPACE_READ_AUTHZ=enforce`, a request outside the list is not processed and ends with `-32001` and `Permission denied: the requested workspace is outside the key's allowed_workspaces` (`the key's default workspace is outside ...` when the key's default workspace is outside the list, `... could not be determined` when the list lookup fails). The default `warn` processes the request and only records `memento_workspace_read_authz_total{outcome="would_deny"}` and a warning log.
- When a forget/amend/link request targets a fragment owned by another tenant (different API key), a `"Fragment not found or no permission"` error is returned. Isolation is enforced at the SQL level via `key_id` conditions, so the fragment's existence is never exposed.

Accessing a protected resource without authentication returns `401 Unauthorized` with a `WWW-Authenticate: Bearer resource_metadata="</.well-known/oauth-protected-resource URL>"` header.

### Mode Preset

The session behavior mode can be set via the `X-Memento-Mode` header or `params.mode` in the `initialize` request. Setting `api_keys.default_mode` through `PATCH /v1/internal/model/nothing/keys/:id/policy` (the ACCESS POLICY card in the admin console key detail) pins a per-key default. Master-only presets (`audit`) cannot be assigned to an API key. When a non-master session requests a master-only preset through the header, `params.mode` or the key `default_mode`, `MEMENTO_WORKSPACE_READ_AUTHZ=enforce` rejects it with HTTP 403 and `-32001` (`Permission denied: mode preset 'audit' requires master authentication`) without creating a session. The default `warn` ignores the preset, lists all tools and records would_deny.

| Preset | Description | Tools removed from tools/list |
|--------|-------------|---------------|
| `recall-only` | Read-only session. Removes memory write/modify tools. For search-only agents. | remember, batch_remember, amend, forget, link, reflect, memory_consolidate |
| `write-only` | Write-only session. Removes recall and context. For data ingestion pipelines. | recall, context, reconstruct_history, graph_explore, fragment_history, search_traces, memory_stats |
| `onboarding` | New user guidance session. All tools stay exposed and get_skill_guide returns the beginner guide. | none |
| `audit` | Read and trace session. Removes write tools. For auditing and compliance. Applies to master sessions only; ignored for API-key sessions | remember, batch_remember, amend, forget, link, reflect |

Presets filter the tools/list response only. tools/call does not consult the preset, so what can be called is decided by RBAC permissions.

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

Send the session ID in the `MCP-Session-Id` header. `MEMENTO_SESSION_ID_POLICY` (`warn`, `enforce`, default `warn`) governs session IDs received in the query string and automatic recovery of IDs that are not in the server-issued format (UUID). `warn` logs a warning and proceeds; `enforce` answers 400 for a query-string ID and 404 for recovery of a non-UUID ID. UUID sessions sent in the header and `/message?sessionId=` are unaffected.

A session opened with an API key rereads the key state on use at the `MEMENTO_SESSION_KEY_RECHECK_MS` interval (default 30000 ms, `0` disables). The session of an inactive or deleted key is closed and receives 404 `Session not found` (JSON-RPC `-32000`); permission changes apply to open sessions. Disabling or deleting a key through the admin API closes that key's sessions in this process immediately. When an API key store lookup fails and authentication cannot be decided, `initialize` and automatic session recovery answer 401 by default, or 503 with `Retry-After: 10` when `MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS=503`. Requests above the per-IP limit on repeated `initialize` receive 429 with `Retry-After`.

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
  "oldSessionId": "aabbcc11-...-8899ddee",
  "newSessionId": "ffeedd22-...-3344ccbb",
  "expiresAt": 1776774896789,
  "reason": "suspected_leak"
}
```

Policy:

- Auth: `Authorization: Bearer` required (401 on failure). Missing `Mcp-Session-Id` returns 400, unknown session 404, expired session 401, ownership mismatch 403, session persistence unavailable 503
- Origin check: without an `Origin` header only loopback-socket requests are accepted. localhost/127.0.0.1 origins are always accepted. When both `ALLOWED_ORIGINS` and `ADMIN_ALLOWED_ORIGINS` are empty any Origin is accepted; otherwise only origins in those lists. Anything else returns 403
- Rate limit: `MEMENTO_ROTATE_RATE_LIMIT_PER_MIN` requests per client address per minute (default 5); exceeding returns 429 with `Retry-After`. The client address follows `TRUST_PROXY_HOPS`
- `reason` is an audit-log field (max 128 chars); defaults to `explicit_rotate` when omitted
- Metrics: `mcp_session_rotation_total{outcome}` counter (outcome: `rotated`, `not_found`, `expired`, `forbidden`, `unavailable`, `error`) + `mcp_rotate_rate_limited_total` counter
- CLI: use `memento-mcp session rotate <sessionId>` for the same capability; see `docs/cli.en.md` for details

### tools/list response fields

Each entry carries `name`, `title`, `annotations`, `description`, and `inputSchema`. `annotations` holds the MCP standard hints (`readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint`). The server-side registry (`lib/tool-registry.js`) keeps per-tool `riskLevel` (`safe`, `caution`, `destructive`) and `requiresMaster`; these are not sent in tools/list.

Tools appear in the order `recall`, `context`, `remember`, followed by the rest in ascending name order. The relative order of the exposed tools is the same for every session and key. Every tool declares all four hints as booleans.

| Tool | title | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
|-|-|-|-|-|-|
| `recall` | Recall: 저장 기억 회상(검색) | Y | N | Y | N |
| `context` | Context: 세션 시작 기억 주입 | Y | N | Y | N |
| `remember` | Remember: 기억 저장 | N | N | N | N |
| `amend` | Amend: 기억 갱신 | N | Y | N | N |
| `apply_update` | Apply Update: 업데이트 적용 | N | Y | N | Y |
| `batch_remember` | Batch Remember: 대량 기억 저장 | N | N | N | N |
| `batch_status` | Batch Status: 일괄 저장 상태 조회 | Y | N | Y | N |
| `check_update` | Check Update: 업데이트 확인 | Y | N | Y | Y |
| `forget` | Forget: 기억 삭제 | N | Y | Y | N |
| `fragment_history` | Fragment History: 파편 변경 이력 조회 | Y | N | Y | N |
| `get_skill_guide` | Get Skill Guide: 활용 가이드 조회 | Y | N | Y | N |
| `graph_explore` | Graph Explore: 인과 체인 추적 | Y | N | Y | N |
| `link` | Link: 파편 관계 설정 | N | N | Y | N |
| `memory_consolidate` | Memory Consolidate: 기억 유지보수 | N | Y | N | N |
| `memory_stats` | Memory Stats: 기억 통계 조회 | Y | N | Y | N |
| `reconstruct_history` | Reconstruct History: 작업 히스토리 재구성 | Y | N | Y | N |
| `reflect` | Reflect: 세션 학습 영속화 | N | N | N | N |
| `search_traces` | Search Traces: 정확 매칭 탐색 | Y | N | Y | N |
| `session_rotate` | Session Rotate: 세션 교체 | N | N | N | N |
| `tool_feedback` | Tool Feedback: 도구 유용성 피드백 | N | N | N | N |

- A tool with `readOnlyHint` `Y` does not change the content of stored memory. `recall` is marked `readOnlyHint` `Y` although it updates `access_count`, `accessed_at` and `ema_activation` on the fragments it returns, updates `accessed_at` on co-retrieved neighbor fragments, and writes one search event. This is bounded bookkeeping, not a change to memory content. `check_update` refreshes the local check-result cache.
- Tools with `destructiveHint` `Y` are `forget` (deletes fragments), `amend` (overwrites content and metadata in place; the archived previous-version row omits `is_anchor` and `assertion_status`, and no tool restores versions), `memory_consolidate` (expiry deletion and merging), and `apply_update` (updates the installation).
- `remember` and `batch_remember` are `destructiveHint` `N`. Adding new fragments is their primary use; only a call that names `supersedes` closes the target's `valid_to` and halves its `importance`. That change leaves no archive row, and an expired fragment cannot be amended. The effect happens only when the caller opts in explicitly.
- `openWorldHint` is `Y` only for tools that reach systems outside the server (`check_update`, `apply_update`).

### ping

A `ping` request on an authenticated session returns the empty object `{}` as its result. Sent as a notification, it is accepted without a response.

### Tool argument validation and error responses

`tools/call` arguments are compared with the tool's `inputSchema`. The check covers top-level fields and array items for type, `enum`, range, `maxLength`, `maxItems`, `pattern`, `oneOf`, required fields and fields absent from the schema. `MEMENTO_TOOL_ARGS_VALIDATION` (`off`, `warn`, `enforce`, default `warn`) sets the behavior. `warn` only logs a warning and proceeds; `enforce` rejects a violation with JSON-RPC `-32602` and an `Invalid arguments for <tool>: <reason>` message. With `MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN=true`, fields absent from the schema are not violations.

Internal exceptions raised while a tool runs (DB driver, runtime errors) leave the server as `Internal error`; the original text stays in the server log and audit records. When an enum argument of `remember`, `batch_remember` (item `type`), `amend`, `link` or `tool_feedback` does not fit the storage constraint, the response is `{ "success": false, "error": "Invalid arguments for <tool>: <param>: must be one of a|b|c", "code": "INVALID_ARGUMENT" }`. Tools whose definition does not declare the parameter return `Internal error`. Argument errors from constraint violations carry the string code `INVALID_ARGUMENT` in the tool result (`isError`), while schema validation in `enforce` mode uses JSON-RPC `-32602`. With `MEMENTO_PROVENANCE=on` (the default), an `origin` of `remember` or of a `batch_remember` item outside the accepted values (user_stated, agent_inferred, tool_output, external_content, consolidation, import) is rejected by the write gate with `-32602` regardless of `MEMENTO_TOOL_ARGS_VALIDATION` (in a batch only that item fails).

The internal agent IDs (`system`, `admin`) are governed by `MEMENTO_RESERVED_AGENT_IDS` (`warn`, `enforce`, default `warn`). `warn` only logs a warning (including the first 8 characters of the key) when an API-key request uses one; `enforce` rejects it with FORBIDDEN (`-32001`). The master key is allowed in both modes.

Tool-call audit records carry the actor (`key=`, `sid=` first 8 characters, `ip=`). Admin API mutating requests (anything but GET) and admin authentication successes and failures are recorded as `admin <METHOD> <path>` and `admin_auth`.

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
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
  "scopes_supported": ["mcp"],
  "service_documentation": "https://{domain}/docs"
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

> API key binding: sending `Authorization: Bearer <API key>` with the registration registers the client under a URL-safe `client_id = "<name>_<keyIdHex8>"`, and the response reports `token_endpoint_auth_method` as `client_secret_post`. `/authorize` later restores that key's tenant context. Without the header a random `client_id` is issued and `token_endpoint_auth_method` is `none`. A `client_id` in the raw API key format is never registered as a client row.
>
> `/register` answers 400 `invalid_client_metadata` when `redirect_uris` is missing, and 429 `too_many_requests` with `Retry-After` (seconds remaining in the current window, rounded up, at least 1) above the hourly cap (`MEMENTO_DCR_MAX_PER_HOUR`).

### GET /authorize

OAuth 2.0 authorization endpoint. PKCE `code_challenge` and `code_challenge_method=S256` are required.

Query parameters: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method`, `state` (optional).

When `redirect_uri` is in the allow list (localhost, `OAUTH_TRUSTED_ORIGINS`, `OAUTH_ALLOWED_REDIRECT_URIS`), the request is approved without the consent screen and redirected with `code` (302). Otherwise a consent screen is rendered and, after consent, a 302 redirect to `redirect_uri` with `code` is returned. A client bound to an API key at registration always passes through the consent screen, even when `redirect_uri` is in the allow list. An unregistered client_id is auto-registered only for an allow-listed redirect_uri or when `MCP_ALLOW_AUTO_DCR_REGISTER=true`.

### POST /token

OAuth 2.0 token endpoint. Accepts `application/x-www-form-urlencoded` or `application/json` bodies and supports `authorization_code` exchange (PKCE `code_verifier` required) and `refresh_token` renewal. A per-IP rate limit applies.

- Code exchange for a client bound to an API key at registration succeeds only when the request presents the same key as `client_secret` (or as the password of an `Authorization: Basic` header). Otherwise the server answers 401 `invalid_client`.
- An `invalid_client` error is HTTP 401; other OAuth errors (`invalid_request`, `invalid_grant`, and so on) are 400. Responses carry `Cache-Control: no-store`.
- The access token lifetime is `OAUTH_ACCESS_TOKEN_TTL_SECONDS` (`SESSION_TTL_MINUTES * 60` when unset); the refresh token lifetime is `SESSION_TTL_MINUTES * 60 * 2` seconds.

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
- `decision=deny`: 302 redirect to `redirect_uri?error=access_denied&error_description=User%20denied%20access&state=<state>` (`state` only when present in the request). Common error rule: a missing or non-URL redirect_uri returns 400 JSON; a redirect_uri not registered for the client is redirected with a warning under `MEMENTO_OAUTH_REDIRECT_CHECK=warn` (default) and returns 400 JSON under `enforce`

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

### PATCH /v1/internal/model/nothing/keys/:id/policy

Change the policy columns of an API key. Master key required. Only the supplied fields are updated in one statement; an unknown field or an empty object returns 400.

Request body:

```json
{ "default_mode": "recall-only", "allowed_workspaces": ["proj-a", "proj-b"], "symbolic_hard_gate": true }
```

| Field | Value | Description |
|-|-|-|
| `default_mode` | `recall-only`, `write-only`, `onboarding` or `null` | Per-key default mode preset. `null` clears it (all tools exposed). An unregistered name and a master-only preset (`audit`) return 400 |
| `allowed_workspaces` | array of strings or `null` | `null` is unlimited. An empty array judges every workspace claim to be outside the allowed set and records a `workspaceNotAllowed` warning; a write is rejected only when `MEMENTO_WORKSPACE_GATE=true` and the key has the hard gate on. A write without a workspace always passes. Reads are limited to the listed workspaces and global fragments (`MEMENTO_WORKSPACE_READ_AUTHZ`; the default `warn` only records). At most 64 entries (after de-duplication), 128 characters each; an empty string, surrounding whitespace or a control character returns 400 |
| `symbolic_hard_gate` | boolean | `true` rejects a `remember` call whose fragment violates a PolicyRules rule |
| `egress_policy` | object or `null` | LLM egress policy `{ "local_only": boolean, "approved_providers": [provider names] or null, "workspaces": { "<workspace>": { "local_only", "approved_providers" } } }`. Every field is optional and `null` means no policy. Provider names must be registered names (at most 32); at most 64 workspace overrides. An unknown field or a malformed value returns 400 with the location in the message (for example `egress_policy.workspaces.a.local_only`). See "Egress Policy" in [configuration.en.md](configuration.en.md) for the decision rules |

`egress_policy` is read and written only when the request carries it, and the response carries it only then. Sending `egress_policy` to an install without the column (before migration-055) returns 409.

Response 200:

```json
{ "success": true, "default_mode": "recall-only", "allowed_workspaces": ["proj-a", "proj-b"], "symbolic_hard_gate": true }
```

Errors: 400 `{ "error": "...", "field": "default_mode" }` (validation failure), 404 (key not found), 409 (`egress_policy` column missing), 413 (body too large).

Effect: `symbolic_hard_gate`, `allowed_workspaces` and `egress_policy` clear this process's lookup cache, but a lookup already in flight when the PATCH lands can still write the old value into the cache. That entry expires within the 30 second TTL, so the change is effective within about 30 seconds at the latest; other instances behave the same. `default_mode` applies to sessions opened after the change. The change is written to the audit log as one `admin key_policy` line (field names with old and new values).

### Key lifecycle: PATCH /keys/:id, POST /keys/:id/rotate, /revoke, /access-review

The path prefix is `/v1/internal/model/nothing`. All of them require master key authentication and every request records an audit event (`admin.key.lifecycle_update`, `admin.key.rotate`, `admin.key.revoke`, `admin.key.access_review`; key creation is `admin.key.create`). Raw keys and description text are not written to the audit detail.

The `PATCH /keys/:id` body holds one or more of the following fields. Only the given fields change, and an empty string is the same as `null`.

| Field | Value | Description |
|-|-|-|
| `expires_at` | ISO 8601 timestamp with `Z` or an explicit offset (`+09:00`), or `null` | The key is refused from this time on (`memento_auth_denied_total{reason="key_expired"}`). `null` means no expiry. A time without an offset (`2027-01-01T00:00:00`), a date only, a number or any other notation returns 400 |
| `description` | string of at most 500 characters or `null` | Description shown in the console |
| `owner` | string of at most 128 characters or `null` | Owner label |
| `kind` | `^[a-z][a-z0-9_-]{0,31}$` or `null` | Key kind label |
| `allowed_cidrs` | array of IPv4/IPv6 blocks (at most 64) or `null` | The request address must fall in one of the blocks. A single address is stored as `/32` or `/128`. `null` means no restriction, an empty array refuses every address. The request address is the value after `TRUST_PROXY_HOPS` is applied, and an IPv4-mapped IPv6 address is matched as IPv4. A request from outside the blocks gets the same 401 as an invalid key and is counted in `memento_auth_denied_total{reason="cidr_denied"}`. An open session is closed at its key state recheck when the request address is outside the blocks. The check assumes that `TRUST_PROXY_HOPS` equals the number of trusted reverse proxies in front of the server and that the server is reached only through them. With a hop count higher than the real one, or with hops 1 and a request that reaches the server directly, the client can choose its address through `X-Forwarded-For`. A server without `TRUST_PROXY_HOPS` therefore refuses list writes (including an empty array) with 409 `trust_proxy_hops_unset`; clearing with `null` is accepted |

Response 200 is `{ "success": true, ...lifecycle columns }`. Expiry and block changes clear the session recheck cache of this process at once.

The optional `POST /keys/:id/rotate` body is `{ "graceHours": 24 }`. `graceHours` is an integer from 0 to 720 and defaults to `MEMENTO_KEY_ROTATION_GRACE_HOURS` (24). A new raw key is created and returned once as `raw_key`; the previous key (including a key still in the overlap of an earlier rotation) authenticates new requests only until `previous_valid_until`. A key whose overlap has ended is counted in `memento_auth_denied_total{reason="key_rotated"}`. A revoked key returns 409 `key_revoked`.

Access already held: once the overlap end (`previous_valid_until`) has passed, every MCP session (streamable and legacy SSE) of this key and every OAuth access and refresh token bound to this key that was created before that time ends, including those created with the new key during the overlap. Sessions are closed at their next key state recheck (at most `MEMENTO_SESSION_KEY_RECHECK_MS`, 30 seconds by default, later) and clients recover the same session id by authenticating with the new key. An access token gets 401 (`key_rotated`) on its next request and a refresh token gets `invalid_grant`, unless the refresh request presents the current key as `client_secret`, which binds the new tokens again. With `graceHours` 0 the previous key is refused at once, this process closes the key's sessions before answering (`closed_sessions`), and tokens issued before that time end at their next use. With `MEMENTO_SESSION_KEY_RECHECK_MS=0` there is no session recheck, so an overlap rotation does not end open sessions (the immediate close of a 0 overlap and revocation still apply). If closing sessions fails the rotation still answers success with `warning: "session_close_failed"`.

```json
{ "id": "...", "name": "ci-runner", "key_prefix": "mmcp_cirunner_", "raw_key": "mmcp_cirunner_...", "previous_valid_until": "2026-10-04T12:00:00.000Z", "retired_secrets": 1 }
```

The `POST /keys/:id/revoke` body is `{ "reason": "..." }` (1 to 500 characters). It records `revoked_at`, `revoked_by` and `revoke_reason`, sets the status to `inactive` and revokes every secret of the key. The session recheck cache and the policy caches of this process are cleared and the key's sessions are closed at once. Revocation cannot be undone, and revoking a revoked key returns 409 `already_revoked`. If closing sessions fails after the commit, the revocation still answers success with `warning: "session_close_failed"` and the audit detail records `sessionCloseFailed: true`; the remaining sessions close at their next key state recheck.

`POST /keys/:id/access-review` takes no body. It records `access_reviewed_at` and `access_reviewed_by` (the admin actor label, for example `master:bearer`).

Errors: 400 `{ "error": "...", "field": "..." }` (validation), 404 (no such key), 409 `{ "error": "...", "message": "..." }` (revocation conflicts `key_revoked`, `already_revoked`, unset hop count `trust_proxy_hops_unset`), 413 (body too large).

Clock: expiry, rotation overlap and retirement are judged with the application server clock (`valid_until` is also set from the clock of the server that took the rotation). Times written by the database (`revoked_at`, `access_reviewed_at`, `last_used_at`), `rotation_overlap_until` in the list and the backfill script's consistency report use the database clock and are not used for decisions.

Lookup order: the SHA-256 hash of a raw key is looked up in `api_key_secrets` first, and in `api_keys.key_hash` only when the hash is not there. The row found is judged in this order: revoked, inactive, expired, secret row state (revoked, overlap ended), daily limit. A key whose lifecycle columns are empty is judged on status and daily limit only. The source is counted in `memento_api_key_lookup_total{source="secret"|"legacy"}`.

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
| `memory://stats` | Scoped statistics | Per-type/per-tier counts and utility averages for current default-agent fragments within the resource's key/workspace scope |
| `memory://topics` | Scoped topic list | Unique topics from current default-agent fragments in the same scope |
| `memory://config` | System configuration | Weights and TTL thresholds defined in `MEMORY_CONFIG` |
| `memory://active-session` | Session activity log | Current session tool usage history recorded in `SessionActivityTracker` (Redis) |

These resources have no `includePeerAgents` input, so even master cannot request all-agent aggregates through them. Superseded fragments (`valid_to IS NOT NULL`) are excluded.

Omitting agentId selects default; specifying it selects that agent plus default. This transition release defaults `MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE=true`, allowing deployed API-key specific-agent claims with a warning and counter. Setting false enables strict mode, where specific-agent selection requires master authentication. `includePeerAgents` always requires master authentication regardless of the flag. `search_traces` and `reconstruct_history` also apply this default agent filter, so existing administrative calls may return fewer rows.

ID lookups through `fragment_history` and `graph_explore` now apply workspace filters. For an ordinary key with no default_workspace that stored a fragment in proj, request its history with `{ "id": "fragment-id", "workspace": "proj" }`. Master may use `{ "id": "fragment-id", "allWorkspaces": true }` to remove only the workspace filter. For `graph_explore`, replace `id` with `startId` in both examples. Omitting workspace selects global-only, so previously successful ID-only calls may now return not found.

---

## MCP Tool — recall

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| keywords | string[] | - | Keyword search (L1->L2). Without text, an L3 semantic supplement runs in parallel using the synthesized keywords(+contextText) text, recovering fragments whose stored keywords lack the query terms (controlled by `semanticSearch.keywordFallback`, adds an `L3kw:N` searchPath segment). |
| text | string | - | Natural language query (L3 semantic) |
| topic | string | - | Topic filter |
| type | string | - | Type filter (fact, decision, error, preference, procedure, relation, episode) |
| tokenBudget | number | - | Maximum return tokens. Default 1000. With `MEMENTO_RANK_BEFORE_BUDGET=on` (the default), candidates including linked fragments receive the final score and are selected within this budget; linked fragments use the same budget. With `off`, results are cut in search order and linked fragments are added outside the budget. |
| includeLinks | boolean | - | Include linked fragments (1-hop, resolved_by/caused_by prioritized). Default true. |
| linkRelationType | string | - | Link relation type filter (related, caused_by, resolved_by, part_of, contradicts) |
| threshold | number | - | Similarity threshold (0-1) |
| includeSuperseded | boolean | - | Include expired (superseded) fragments. Default false. |
| includePeerAgents | boolean | - | Master only. Includes other agents within the same key/workspace scope. Ordinary API keys receive a permission error. Default false. |
| includeKeyName | boolean | - | When true, each fragment carries key_id and key_name (the access key label). Only information within the same key group scope is exposed. Default false. |
| asOf | string | - | ISO 8601. Used only as the time-proximity ranking reference that lifts fragments close to that time. It is not a filter that keeps only the versions valid at that time; use `timeRange` to bound a period. |
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
| workspace | string | - | Returns the selected workspace + global (NULL), falls back to the key default, and returns global-only when neither exists. |
| allWorkspaces | boolean | - | Master-only cross-workspace read. API keys receive a permission error when requesting true. |
| contextText | string | - | Current conversation context text. Proactively activates related fragments (when ENABLE_SPREADING_ACTIVATION=true). |
| cursor | string | - | Backward-compatible opaque pagination cursor carrying the offset and fixed `anchorTime` |
| pageSize | number | - | Default 20, max 50 |
| agentId | string | - | Agent ID |
| minImportance | number | - | Minimum importance filter (0-1). Only fragments with importance at or above this value are returned. |
| isAnchor | boolean | - | Anchor filter. `true` returns anchors only, `false` returns non-anchors only, and omission returns both. |
| affect | string \| string[] | - | Affect tag filter. Single string or array. Returns only fragments with the matching affect value. Valid values: neutral, frustration, confidence, surprise, doubt, satisfaction |
| fields | string[] | - | Fragment fields to include in the response. Returns all fields if not specified. Supported keys: id / content / type / topic / keywords / importance / created_at / access_count / confidence / linked / explanations / workspace / context_summary / case_id / valid_to / affect / ema_activation / key_id / key_name |
| format | string | - | Response format. `default` (the default) is the existing response; `pack` returns the answer pack `pack` instead of `fragments` (see "Answer pack (format: pack)" below). Not applied to caseMode. |

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
| `_meta.hints` | Array of search signal hints (`no_results`, `topic_mismatch`, `contradiction_pending`, `stale_results`, etc.). `topic_mismatch` fires when the requested topic yields zero fragments while similar topics exist in key scope, and recommends re-running recall with a suggested topic. `contradiction_pending` fires when returned fragments have unresolved contradicts links and recommends cleanup via amend. When a global-only lookup omits both workspace and key default and returns nothing, the `no_results` suggestion recommends retrying with the intended workspace. |
| `_meta.suggestion` | RecallSuggestionEngine hint object (null when no issue detected) |
| `_meta.serverTime` | Server time of the response, mitigating LLM clients' training-time fixation. Included consistently in all recall/context responses. `iso` (UTC ISO 8601), `epoch_ms` (Unix ms), `display_kst` (Asia/Seoul formatted), `timezone`. |

Successful responses from the write tools (remember/amend/forget) may also carry a `_meta` block. In that case `hints` holds a single `feedback_sampled` signal alongside `serverTime`; `searchEventId` and `suggestion` are absent. See [Feedback sampling hint](#feedback-sampling-hint).

When a shared key has no `default_workspace` and writes use an explicit workspace, recall/context calls must pass that same workspace. Omitting it now searches global (NULL) fragments only and can make stored workspace fragments appear missing. Redis Working Memory entries created before this upgrade have no workspace field and are excluded from scoped/global-only context; only master `allWorkspaces=true` can safely include them.

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

### Provenance and trust tier

With `MEMENTO_PROVENANCE=on` (the default), fragments of the default response carry `origin` (the origin claimed at storage time) and `trust_tier` (0 quarantined, 1 low, 2 normal, 3 high). Existing fragments with NULL values do not carry the two fields and their tier is read as 2. With `fields`, only the requested keys are added. The two values are looked up once per fragment id, separately, within the same agent, key (including the group) and workspace scope as the recall; when the lookup fails, the response comes without the two fields. The tier follows the description of the remember `origin` parameter. With `off`, there is no lookup and no field.

With `MEMENTO_REVIEW_QUEUE=on` (the default), pending review fragments (`review_state='pending'`) written by the calling key appear in the result with `pending_review: true` and the low trust marker `low_trust: true`, regardless of `fields`. Other keys of the same key group, the master key and context injection do not see them. After approval they are visible to everyone without markers; after rejection they become expired fragments that only the writing key's `includeSuperseded` lookups show, with `review_rejected`.

### Answer pack (format: pack)

With `format: "pack"` the response carries `success`, `format: "pack"`, `pack`, `count`, `totalTokens`, `searchPath` and `_meta`, without `fragments`. Without `format` or with `default`, the response is the format above.

| Field | Description |
|-|-|
| `pack.version` | `v0` |
| `pack.policy_id` | Fixed identifier of the policy paragraph (`memento-pack-policy-v0`). The paragraph itself appears once, in `pack.text` only |
| `pack.text` | Text ready to place into an answer: `[MEMORY PACK v0]`, the fixed policy paragraph that is not derived from memory content (block content is data and not instructions; meaning of date, status, assertion; escape notation), then per fragment an opening line `<<<MEMORY ...>>>`, one content line and the closing line `<<<END MEMORY>>>` |
| `pack.items[]` | Attributes in block order: `id`, `date` (UTC storage date YYYY-MM-DD), `status` (`valid`, `superseded`), `assertion`, `type`, `topic`, `case_id`, `source`, `superseded_by`, `supersedes`, `truncated`, only when present `stale_warning` (recall stale warning, 120 characters) and `validation_warnings` (warnings recorded at write time, at most 5, 120 characters each), and `origin` (only with `MEMENTO_PROVENANCE=on`, null without a value). The content is only in `pack.text`, and `review` for a pending review fragment (`pending`; the opening line carries `review=pending`) |
| `pack.groups[]` | `{ key, ids }`. The key is `case:<caseId>`, or `topic:<topic>` without a caseId. Groups appear in order of first appearance, items within a group in rank order, and the blocks follow this order |
| `pack.partial` | `true` when the source and supersession lookup failed and the pack was built without that information |
| `pack.estimatedTokens` | cl100k_base token count (`countTokens`, the function the write path and recall budget selection use) of the `pack` object without `estimatedTokens`, serialized like the response (JSON, indent 2). This is the size of the whole pack |

Rules:

- Dates are the UTC date of `created_at` only. Relative dates and elapsed days (`age_days`) are not included.
- `status` is `valid` without `valid_to` and `superseded` with it (returned with `includeSuperseded=true`). `superseded_by` and `supersedes` are the ids on the other side of `superseded_by` links (not deleted), at most 5 per direction, ordered by the related fragment's `created_at` descending (ties by id ascending). The chain and `source` are looked up separately, once each, for fragments within the same agent, key (including the group) and workspace scope as the recall.
- `source` is the stored value; `session:<id>` is shortened to `session`.
- `origin` appears in the opening line as `origin=<value>` only with `MEMENTO_PROVENANCE=on` and when the stored value is one of the accepted values of the remember `origin`.
- Content and the string attributes of the opening line escape backslash, line breaks, tab and the characters of the general categories Cc, Cf, Cs, Zl, Zp (including the soft hyphen, zero-width characters, direction controls and the tag characters U+E0000 to U+E007F) as `\\`, `\n`, `\t`, `\uXXXX`, `\u{XXXXX}`. Runs of three or more `<` or `>` become `\u003c`, `\u003e`, so neither content nor attributes can form a block delimiter. The length caps (content 1000, attributes 120, code points) apply to the escaped length and never split an escape sequence. Cut content is marked `truncated=true`. String attributes are double-quoted.
- `assertion` is included only for `observed`, `inferred`, `verified`, `rejected`.
- The extra fields of `fields`, `includeKeywords`, `includeContext` and the linked fragments (`linked`) are not part of the pack.

Response size: `totalTokens` is the token count of the content of the fragments recall selected, and `pack.estimatedTokens` is the token count of the whole pack (`text`, `items`, `groups`). Tool responses send the whole result object as a JSON string, so the line breaks and escape notation in `pack.text` are escaped once more by JSON, and the attributes appear both in the opening lines of `pack.text` and in `pack.items`. Measured on 2026-10-03 with the evaluation set content (short Korean sentences, about 42 tokens on average), the whole response was 2.1 times the default format at 3 items (438 against 921 tokens), 1.6 times at 10 (1404 against 2252) and 1.55 times at 15 (2026 against 3134). The fixed policy paragraph is included once per response, so the ratio is larger with fewer items.

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

`fragment_count` is the number of representative candidates for the case after current key-group, workspace, validity, and `isAnchor` filters; it is not the case's lifetime fragment total. `events` are not filtered by a source fragment's current anchor status and return up to 20 historical entries per case within the current key-group scope.

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
| keywords | string[] | - | Search keywords. Even when supplied, keywords extracted from the content are merged after them (deduplicated, max 10) with supplied keywords first. Without input only extraction is used |
| importance | number | - | Importance 0-1 (type-specific default if not provided) |
| source | string | - | Source (session ID, tool name, etc.) |
| linkedTo | string[] | - | List of existing fragment IDs to link to |
| scope | string | - | Storage scope. permanent=long-term memory (default), session=session working memory (kept for 24 hours, consumed by session synthesis). Requires `sessionId`; without it the fragment is stored as permanent. Passes the same semantic write gate as permanent storage |
| isAnchor | boolean | - | Pin important fragment. When true, excluded from importance decay and expiration deletion. |
| supersedes | string[] | - | List of existing fragment IDs to replace. Specified fragments have their valid_to set and importance halved. |
| contextSummary | string | - | Context/background summary of how this memory arose (1-2 sentences). Returned alongside the fragment on recall to restore context. |
| sessionId | string | - | Current session ID. Used to bundle fragments from the same session by temporal adjacency. |
| workspace | string | - | Workspace name. Key's default_workspace applied if not specified. |
| agentId | string | - | Agent ID (for agent scoping) |
| caseId | string | - | Case/task identifier this fragment belongs to. Auto-set to the current session_id if not provided. |
| goal | string | - | Goal of the episode fragment (recommended for episode type) |
| outcome | string | - | Outcome of the episode fragment |
| phase | string | - | Work phase (e.g., planning, debugging, verification) |
| resolutionStatus | string | - | Task resolution status (open, resolved, abandoned) |
| assertionStatus | string | - | Fragment confidence level (observed, inferred, verified, rejected). Default: observed |
| affect | string | - | Emotional state tag at the time of storing this memory. Default: neutral. Valid values: neutral, frustration, confidence, surprise, doubt, satisfaction |
| idempotencyKey | string | - | Retry-safe identifier (max 128 characters). Repeated calls with the same value within the same key_id scope return the existing fragment id without creating a new fragment. For client retry and network deduplication. |
| origin | string | - | Claimed source of the memory: user_stated, agent_inferred, tool_output, external_content, consolidation, import. The server sets `trust_tier` (0 to 3) from this value, the initialize `clientInfo.name` and the key cap. The tier is the smaller of the origin tier (user_stated 3, external_content 1, others 2) and the key cap (3 with the `trusted_origin` permission or the master key, otherwise 2); tier 1 or lower is left out of the ANCHOR and CORE injection of context. `consolidation` and `import` can also be claimed and, like the other origins, get the smaller of the origin tier (2) and the key cap. Values outside the list return `-32602`. Omitted means no origin (tier 2). Ignored with `MEMENTO_PROVENANCE=off` |
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
    "quota": { "limit": 5000, "current": 120, "remaining": 4880, "resetAt": null }
  }
}
```

Without violations (normal storage):
```json
{
  "success": true,
  "id": "frag-...",
  "keywords": ["..."],
  "ttl_tier": "warm",
  "scope": "permanent",
  "conflicts": []
}
```

With violations (soft gate, stored):
```json
{
  "success": true,
  "id": "frag-...",
  "keywords": ["..."],
  "ttl_tier": "warm",
  "scope": "permanent",
  "conflicts": [],
  "validation_warnings": ["decisionHasRationale"]
}
```

`validation_warnings`: Array of PolicyRules soft gating violation rule names (string[]). The field is omitted when there are no violations. When `MEMENTO_SYMBOLIC_POLICY_RULES=false` (default), always omitted. Both the atomic path (`MEMENTO_REMEMBER_ATOMIC=true`) and the non-atomic path pass the same semantic write gate (`WriteGate.check`), so the format is identical on both paths. When enabled, failed predicates accumulate from the following 5:

- `decisionHasRationale` — decision type lacks 2+ linked_to references or rationale keywords
- `errorHasResolutionPath` — error type lacks cause/fix keywords or resolution_status
- `procedureHasStepMarkers` — procedure type lacks numbered/step markers
- `caseIdHasResolutionStatus` — fragment with a case_id has no resolution_status set
- `assertionNotContradictory` - the assertion is marked both verified and rejected
- `fragmentHasWorkspace` — workspace could not be resolved from an explicit value or the key default (severity: low)

Warnings are soft gates and do not block storage. When `api_keys.symbolic_hard_gate=true`, fragments triggering warnings are rejected. `fragmentHasWorkspace` is only included in the hard-gate-eligible set when `MEMENTO_WORKSPACE_GATE=true`; by default (`false`) it never blocks storage even on hard-gate-enabled keys.

`workspaceNotAllowed` — recorded when a fragment's workspace falls outside the API key's `allowed_workspaces` set (severity: medium). Evaluated unconditionally, independent of `MEMENTO_SYMBOLIC_POLICY_RULES`. It is a pure warning that never blocks storage and is always excluded from the hard-gate-eligible set.

A `scope=session` response reports the storage path in `working_memory`. `redis` means Redis working memory. `postgres-fallback` means Redis was not ready and the fragment was stored as a PostgreSQL working memory row (`MEMENTO_WM_PG_FALLBACK=on`, the default); `_meta.hints` then carries `working_memory_fallback`. `none` means Redis was not ready and the fallback is off, so nothing was stored; `_meta.hints` carries `working_memory_unavailable`, and the fragment must be stored with `scope=permanent` to be kept. Fallback rows do not appear in `recall`, consolidation or quota counts, and are read by `context` and `reflect` (`sessionId`). Policy warnings are reported in `validation_warnings`.

Fragments also record the resolution source of their workspace as `workspace_source`: `explicit` (workspace given in the request), `key_default` (the API key's default_workspace was applied), or `unscoped` (neither was available).

The duplicate detection scope for the same body is set by `MEMENTO_DEDUP_SCOPE` (default `workspace`). With `workspace`, the same key writing the same body to another workspace stores a separate fragment, and an existing fragment with the same body in the same workspace or a global (no workspace) fragment returns that id. With `key`, detection is per key. A response that hit an existing fragment carries the existing fragment id in `id`, and a same-scope hit (`same_scope`: same workspace or a global fragment) also carries it in `duplicate_of`.

With `MEMENTO_REMEMBER_DUPLICATE_GUARD=true` (default `false`), a `remember` that receives the same body as an existing fragment in the detection scope does not run post-processing, TTL adjustment or reindexing on the existing fragment and only reports its state through `existing: true` and `duplicate` (`same_scope`, `other_workspace`, `closed`, `unknown`). `other_workspace` only occurs under per-key detection. Duplicate hits are counted in `mcp_remember_duplicate_total{kind}` regardless of the flag.

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

### Error codes

- `-32003` (SYMBOLIC_POLICY_VIOLATION): PolicyRules violations or high-confidence `sensitive.*` detections on a key with the symbolic hard gate enabled, or high-confidence `sensitive.*` detections under `MEMENTO_SENSITIVE_SCAN=reject` (master key included), or an anchor designation under `MEMENTO_ANCHOR_PERMISSION=enforce` by a key without the anchor permission or at the anchor limit (`anchorPermissionRequired`, `anchorLimitExceeded`, `anchorLookupFailed`). Storage is rejected. Retry `sensitive.*` after removing the secret or identification number. This is a JSON-RPC **protocol-level** error, not an MCP tool error (isError: true).
- `-32602`: `content` exceeds 4000 characters. It is returned as a tool result `{ "success": false, "error": "content length N exceeds max 4000", "code": -32602 }`, not as a JSON-RPC error.

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": {
    "code": -32003,
    "message": "policy_violation: decisionHasRationale",
    "data": {
      "violations": ["decisionHasRationale"],
      "fragmentType": "decision"
    }
  }
}
```

---

## MCP Tool — batch_remember

Store multiple fragments at once (for bulk memory input). Batch INSERTs up to 200 items in a single transaction, minimizing HTTP round-trips.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| fragments | object[] | Y | Array of fragments to store (max 200). Each item includes content (string, required, max 4000 characters; an item exceeding it is rejected with `-32602`), topic (string, required), type (string, required), importance (number), keywords (string[]), workspace (string), idempotencyKey (string, max 128 chars), origin (string, same values and rules as the remember `origin`; a value outside the list fails only that item). |
| workspace | string | - | Batch default workspace. Used for individual fragments without a workspace. Key's default_workspace applied if not specified. |
| agentId | string | - | Agent ID (for agent scoping) |
| stream | boolean | - | Deprecated: no longer emits SSE progress events. batch_remember returns a standard single JSON response. This parameter is retained for backward compatibility but has no effect on behavior. |
| async | boolean | - | When true, fire-and-forget (async) mode (default false). Performs only schema validation, content_hash dedup, and quota pre-check synchronously, then enqueues accepted fragments to a Redis queue and immediately returns `{async: true, accepted: N, rejected: [{index, error}], jobId: "..."}` (`jobId` is null when `accepted` is 0). The actual INSERT is handled by the background worker (BatchRememberWorker). Falls back to synchronous mode when Redis is disabled (REDIS_ENABLED=false). |

### async=true Response Example

```json
{
  "async": true,
  "accepted": 5,
  "rejected": [{ "index": 3, "error": "Content too short: length < 10 and word count < 3" }],
  "jobId": "brw-1750000000000-a1b2c"
}
```

In synchronous mode (default), a `results[]` array is returned. Use the `batch_status` tool with `jobId` to query processing state. The async worker guarantees at-least-once delivery via ack, retry (up to 3), dead-letter, and startup recovery (RPOPLPUSH reliable queue).

### Pre-validation error codes

Each fragment is checked before INSERT against the conditions below. A failing fragment is recorded as `results[i].success = false` and does not affect storage of the rest of the array.

| Error message | Cause |
|-|-|
| `content is required` | `content` is null or undefined |
| `content length N exceeds max 4000` | `content` exceeds 4000 characters |
| `type is required` | `type` is missing |
| `Content too short: length < 10 and word count < 3` | `FragmentFactory.validateContent` rejected the content as too short |
| `fragment_limit_exceeded` | API key fragment quota exceeded |
| `policy_violation: <rule>, ...` | Semantic write gate policy violation on a key with `api_keys.symbolic_hard_gate=true` |

Each item passes the same semantic write gate as remember (normalization, sensitive data masking, per-type truncation, PolicyRules, workspace permission) outside the transaction. Violations kept as warnings are reported in `results[i].validation_warnings` (string[] of rule names) of the successful item; the field is omitted when there is none.

---

## MCP Tool — batch_status

Query the processing state of an async batch job started by `batch_remember(async: true)`. Read-only. Returns `status: null` when Redis is disabled.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| jobId | string | Y | The `jobId` from a `batch_remember(async: true)` response |

### Response

The response is `{ success: true, jobId, status }`. `status` is the job state object, or null for an unknown or expired jobId. All values are returned as strings.

| `status` field | Description |
|-|-|
| state | `queued` \| `processing` \| `completed` \| `dead` |
| accepted | Fragments enqueued |
| inserted | Fragments stored once processing completed |
| skipped | Fragments skipped once processing completed |
| error | Last error message while waiting for retry or in the dead state |
| ts | Last update time (epoch ms) |

### Response Example

```json
{
  "success": true,
  "jobId": "brw-1750000000000-a1b2c",
  "status": {
    "state": "completed",
    "accepted": "5",
    "inserted": "5",
    "skipped": "0",
    "ts": "1750000012345"
  }
}
```

---

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

### Response shapes

The call result falls into one of three cases.

| Situation | Response | isError |
|-|-|-|
| Deleted | `{success: true, deleted: 1, protected: 0, purged: {case_summaries: 2, audit_fragments: 1}}` | false |
| Permanent tier without `force` | `{success: true, deleted: 0, protected: 1, reason: "..."}` | false |
| Target missing or not permitted | `{success: true, deleted: 0, error: "Fragment not found or no permission"}` | true |

In the third case the payload reports `success: true` while carrying an `error` key, and that key flips the MCP envelope to `isError: true`. Retrying a delete that already succeeded lands here, so clients should read `deleted` rather than treating the envelope as authoritative.

`purged` is the deletion cascade receipt (`MEMENTO_FORGET_CASCADE=on`, the default). In the same transaction as the fragment deletion, `case_summaries` counts the `case_events` summaries of the deleted fragments that were replaced with `[삭제됨]`, and `audit_fragments` counts the server-written contradiction resolution records that pointed at a deleted fragment and were deleted with it (they are not counted in `deleted`). It appears on responses that reached the deletion step (a topic delete with no targets included), and not on responses that ended because the id target is missing, not permitted or permanent-protected. With `off` the response has no `purged`.

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
| content | string | - | New content. The same 4000-character limit as remember applies; exceeding it is rejected with `-32602`. Like remember, sensitive data is masked and content longer than 300 characters (1000 for episode) is truncated when stored. The remember self-containment rules apply |
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
| idempotencyKey | string | - | Retry-safe identifier (max 128 characters). Repeating a call with the same value in the same key_id scope returns the first response without recording history again |

The changed fields pass the same semantic write gate as remember. PolicyRules violations introduced by this change are reported in the response `validation_warnings` (string[] of rule names); violations the fragment already had are not reported again. On a key with `api_keys.symbolic_hard_gate=true`, a new violation rejects the update. Unlike remember, this rejection is not raised as a JSON-RPC `-32003` error; it comes back as the tool response `{ "success": false, "error": "policy_violation: <rule>, ..." }` (the amend handler's audit path turns the error into a tool response). A dryRun response carries the gated expected state in `simulated.would_be_fragment` and the violations in `simulated.validation_warnings`.

---

## MCP Tool — reflect

Persist session learnings as atomic fragments at session end. Each array item is stored as an independent fragment, so include only one fact/decision/procedure per item.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| summary | string \| string[] | - | Session overview fragment list. Array recommended. 1 item = 1 fact (1-2 sentences). |
| sessionId | string | - | Session ID. When provided, reflect synthesizes only Working Memory items of that session that are not yet stored. Session fragments already stored are never stored again, so repeated calls do not add fragments. A synthesized error gets `resolution_status=resolved` only when its content starts with `[해결됨]`; otherwise it is stored as `open`. |
| decisions | string[] | - | Technical/architecture decision list. 1 item = 1 decision. |
| errors_resolved | string[] | - | Resolved error list. 'Cause: X -> Resolution: Y' format recommended. |
| new_procedures | string[] | - | Established procedure/workflow list. 1 item = 1 procedure. |
| open_questions | string[] | - | Unresolved question list. 1 item = 1 question. |
| narrative_summary | string | - | Summarize the entire session as a 3-5 sentence narrative. Stored as an episode fragment contributing to cross-session context continuity. Auto-generated from summary if omitted. |
| agentId | string | - | Agent ID |
| workspace | string | - | Workspace applied to the items passed by the caller (summary, decisions, etc.). Session synthesis groups keep their own workspace and use this value only when the group has none. Falls back to the API key's default_workspace, then global (NULL). Recommended in multi-project setups to prevent cross-project session summary injection. |
| task_effectiveness | object | - | Session outcome and tool usage effectiveness assessment. Composed of outcome, evaluator, evidence, unmet_requirements, overall_success, tool_highlights, tool_pain_points. See the table below. |
| idempotencyKey | string | - | Retry-safe identifier (max 128 characters). Repeating a call with the same value in the same key_id scope returns the fragment list created by the first call |

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

### AutoReflect timeout

AutoReflect, which runs automatically at session end, applies a 30000 ms timeout to its LLM call. The value keeps a 30 s margin against the 60 s cutoff of external gateways (for example the claude.ai MCP proxy) and must not be raised to 40000 ms or more.

| Item | Default | Description |
|-|-|-|
| `GEMINI_TIMEOUT_MS` (code constant) | 30000 | LLM call timeout of AutoReflect (ms). Exported as a constant of `lib/memory/processors/AutoReflect.js` and not configurable through environment variables |

---

## MCP Tool — context

Loads Anchor, Core, Learning, and Working Memory plus session_reflect separately. After ID deduplication, flat/structured responses and injectionText use the same fragment set. Anchors and one minimum slot for each core type, Learning, and Working Memory are guaranteed to prevent context loss.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| tokenBudget | number | - | Injection token target (default 2000). Anchors and minimum non-anchor slots may make the total exceed the target; remaining candidates are trimmed by score. |
| types | string[] | - | Types to load (default: preference, error, procedure, decision) |
| sessionId | string | - | Session ID (for Working Memory loading) |
| agentId | string | - | Agent ID |
| includePeerAgents | boolean | - | Master only. When true, includes memories of every agent inside the key/workspace boundary. API keys receive a permission error. Default false. |
| workspace | string | - | Returns the selected workspace + global (NULL), falls back to the key default, and returns global-only when neither exists. |
| allWorkspaces | boolean | - | Master-only cross-workspace context read, including anchor/core/learning/working memory. |
| structured | boolean | - | When true, returns hierarchical tree structure; when false/omitted, returns existing flat list (default: false) |
| includeKeyName | boolean | - | When true, each fragment carries key_id and key_name (the access key label). Only information within the same key group scope is exposed, and it does not apply to the structured=true tree response. Default false. |

### Anchor selection metadata

`_meta.anchorSelection` reports `totalLimit`, `workspaceReserve`, and `reserveApplied`, plus workspace/global/unscoped/total counts under `candidates`, `selected`, and `excluded`. `selected.reservedWorkspace` is the number of workspace anchors admitted during the reservation phase. `loadStatus` reports whether each candidate scope loaded successfully (or `null` when not applicable). If any load fails, `partial=true` and unknown candidate/excluded counts are `null`. With an effective workspace, its top reserved anchors are selected first and the remaining slots are filled by a combined importance ranking of leftover workspace and global anchors. Without an effective workspace, it applies no reserve, selects the top anchors from the single permitted candidate scope, and reports that count as `unscoped`. Normal calls include only global (NULL) anchors; candidates across all workspaces are included only for a server-authenticated master request with `allWorkspaces=true`.


### Injection line annotation

With `MEMENTO_CONTEXT_ANNOTATE=on` (the default), each memory line of `injectionText` ends with ` (YYYY-MM-DD, assertion)`. Example: `- nginx settings live in the sites-available category files (2026-09-30, verified)`. The date is the UTC storage date. The assertion is shown only when the stored value is one of `observed`, `inferred`, `verified`, `rejected`; otherwise only the date is added. Header strings (`[ANCHOR MEMORY]` and so on) and the `- ` line prefix do not change, so hooks that read lines only need to ignore the trailing parentheses. The date is in UTC, so it changes at UTC midnight (09:00 KST), and a memory stored between 00:00 and 08:59 KST shows the previous date. There is no time zone setting. With `on`, selection adds a fixed annotation cost of 6 per memory line (characters / 4 units; 11 with `MEMENTO_PROVENANCE=on`, which also counts the origin) within `tokenBudget`, so fewer fragments may be selected for the same budget. The field shapes of `fragments` and the structured response, and the way `totalTokens` is computed (content only), are the same with either value. With `off`, lines end with the content and selection adds no annotation cost.

With `MEMENTO_PROVENANCE=on` (the default), anchor and core lines also carry the stored origin at the end of the parentheses. Example: `- check staging before deploying (2026-09-30, observed, user_stated)`. Nothing is added when there is no origin or the value is not an accepted one. Under the same switch, fragments with trust tier 1 or lower (for example `origin=external_content`) are not injected into `[ANCHOR MEMORY]` and `[CORE MEMORY]` and are also left out of the anchors and core of `fragments` and the structured response. Anchors are filtered by the query predicate (`trust_tier IS NULL OR trust_tier >= 2`), core fragments by a separate tier lookup of the recall result. Core also leaves out fragments whose tier could not be confirmed: when the tier lookup fails, all core candidates are left out, and fragments missing from the lookup result are left out. The outcome is reported in `_meta.coreSelection` (`partial`, `loadStatus.trust`, `excluded.lowTrust`, `excluded.missing`) and in the metric `memento_context_core_trust_excluded_total{reason}` (`low_trust`, `missing`, `lookup_failed`). The learning and working sections are not filtered. While the origin is shown, the fixed annotation cost counts up to the longest origin (`, external_content`) and is 11.

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
| idempotencyKey | string | - | Retry-safe identifier (max 128 characters). Repeating a call with the same value returns the first response without adjusting link weights again |

---

## MCP Tool — memory_stats

Master-key-only fragment memory statistics. Returns total fragment count, TTL distribution, and per-type statistics. Because these are global aggregates without tenant scope, regular API keys cannot access this tool.

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

### Execution

Master key only (`requiresMaster: true`); hidden from API-key tools/list and rejected with `-32001` when called with an API key. The full cycle runs 20+ stages and scales with fragment count; around 13,000 fragments it takes roughly 7 minutes. The scheduler runs the same path every 6 hours by default, so manual invocation is for inspection only. The semantic dedup stage is guarded: a merge is blocked when the distinctive tokens of the fragment being removed do not survive in the one being kept.

---

## MCP Tool — session_rotate

Closes the current session and issues a new `sessionId`. Use it when a token leak is suspected or on a rotation schedule. Rotation revalidates the current credential and refreshes `bound_key_id`, key-group membership, and `permissions`, while preserving the `defaultWorkspace` and `mode` selected on the existing session.

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
| includePeerAgents | boolean | - | Master only. Includes other agents' nodes within the same key/workspace scope. Default false. |
| workspace | string | - | Scope for the start fragment and neighbors. Falls back to the key default; global (NULL) only when neither is set. |
| allWorkspaces | boolean | - | Master only. Removes workspace filters from the start fragment and neighbors, preserving agent/key boundaries. Default false. |

---

## MCP Tool — fragment_history

Query the complete change history of a fragment. Returns previous versions modified via amend and superseded_by chains.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Y | Fragment ID to query |
| agentId | string | - | Agent ID |
| includePeerAgents | boolean | - | Master only. Includes other agents' history within the same key/workspace scope. Ordinary API keys receive a permission error. Default false. |
| workspace | string | - | Scope for the current fragment, versions and superseded chain. Falls back to the key default; global (NULL) only when neither is set. |
| allWorkspaces | boolean | - | Master only. Removes workspace filters from the current fragment, versions and superseded chain, preserving agent/key boundaries. Default false. |

---

## MCP Tool — get_skill_guide

Returns the AnchorMind best practices guide. Comprehensive skill reference covering memory tool usage, session lifecycle, keyword rules, search strategies, experiential memory usage, and more.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| section | string | - | Query a specific section only. Returns full guide if not specified. Possible values: overview, lifecycle, keywords, search, episode, multiplatform, collaboration, codex, tools, importance, experiential, cbr, triggers, workspace, antipatterns |

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
| allWorkspaces | boolean | - | Master only. When true, removes workspace filters from the timeline, events, evidence, and causal links. |
| agentId | string | - | Defaults to shared default scope. Strict mode requires master for specific-agent selection; transition compatibility defaults true and temporarily accepts existing API-key claims. |
| includePeerAgents | boolean | - | Master only. Includes all agents within the same key/workspace scope. Default false. |

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
| allWorkspaces | boolean | - | Master only. When true, removes the workspace filter from traces. |
| agentId | string | - | Defaults to shared default scope. Strict mode requires master for specific-agent selection; transition compatibility defaults true and temporarily accepts existing API-key claims. |
| includePeerAgents | boolean | - | Master only. Includes all agents within the same key/workspace scope. Default false. |

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
{ "success": true, "id": "frag-abc123", "idempotent": true, "existing": true }
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
    "quota": { "limit": 5000, "current": 120, "remaining": 4880, "resetAt": null }
  }
}
```

### Rate Limit header consumption example

```bash
# Inspect response headers
curl -si -X POST https://anchormind.example.com/mcp \
  -H "Authorization: Bearer $API_KEY" \
  ... | grep X-RateLimit
# X-RateLimit-Limit: 5000
# X-RateLimit-Remaining: 4879
# X-RateLimit-Resource: fragments
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
| `MEMENTO_REMEMBER_ATOMIC` | `false` | When `true`, the remember path switches to `_rememberAtomic`. Quota re-validation and INSERT are handled atomically within a single BEGIN/COMMIT transaction using `SELECT api_keys FOR UPDATE`. The semantic write gate runs identically before the transaction on both paths, so the `validation_warnings` format is unchanged. |
| `MEMENTO_WRITE_GATE` | `on` | Semantic write gate switch. With `on`, remember, amend, batch_remember, reflect-derived writes, AutoReflect, imports and the CLI remember local mode pass the same gate. With `off`, each entry point applies only its base steps (remember: all, amend: input size limit and keyword normalization, batch_remember, reflect and CLI remember: normalization, masking and truncation, imports: none). |
| `MEMENTO_ANCHOR_PERMISSION` | `warn` | Anchor designation permission enforcement (`off`, `warn`, `enforce`). Only the master key and keys with the `anchor` (or `admin`) permission designate anchors, and a key's live anchor count is capped by `MEMENTO_ANCHOR_LIMIT_PER_KEY` (default 1000). `warn` stores other requests as regular fragments with `anchorPermissionRequired` and similar names in `validation_warnings`; `enforce` rejects them. Context anchor lines carry a non-identifying principal label (`[k:xxxx]`, `[master]`). |
| `MEMENTO_SENSITIVE_SCAN` | `mask` | Detection mode for secrets and personal data in written values (`mask`, `reject`, `off`). `mask` replaces matches with markers before storage; detections other than email addresses and phone numbers keep only `sensitive.<rule>` names in `validation_warnings` (informational, no retry needed). Hard gate keys reject high-confidence detections (password fields, API key patterns, tokens, private keys, resident registration numbers, card numbers) with `-32003`, and `reject` rejects for every key. `off` applies only the legacy rules to content. |
| `MEMENTO_CASE_BACKPROP_ENABLED` | `false` | When `true`, amending a fragment with a case_id (specifically changing resolutionStatus) triggers importance backpropagation to all fragments sharing the same caseId. Exported as the `CASE_BACKPROP_ENABLED` constant in `lib/config.js`. Boosts activation scores of related fragments after case resolution, improving subsequent recall precision. |
| `MEMENTO_STORAGE` | `pgvector` | Storage backend name. Currently `pgvector` only; this value does not affect behavior. |
| `MEMENTO_SYMBOLIC_POLICY_RULES` | `false` | When `true`, the policy step of the semantic write gate evaluates PolicyRules soft gates and accumulates failed rule names into `validation_warnings`. |
| `MEMENTO_TOOL_ARGS_VALIDATION` | `warn` | Check mode of tool call arguments against `inputSchema` (`off`, `warn`, `enforce`). |
| `MEMENTO_REMEMBER_DUPLICATE_GUARD` | `false` | When `true`, a `remember` that receives the same body as an existing fragment in the same key scope reports the state through `existing` and `duplicate` without post-processing the existing fragment. |
| `MEMENTO_FEEDBACK_SAMPLING` | `true` | Attaches the `feedback_sampled` hint to successful remember/amend/forget responses with a fixed probability. When `false`, no hint is attached and response shapes are unchanged. |

---

## Related Documents

- [Local Embedding Setup](embedding-local.md) -- Detailed instructions for switching to `EMBEDDING_PROVIDER=transformers`
- [Integration/E2E Tests](../tests/integration/README.md) -- Test environment setup and execution
- [Architecture](architecture.en.md) -- Component dependencies and search pipeline
- [Configuration Reference](configuration.en.md) -- Complete environment variable list and MEMORY_CONFIG
