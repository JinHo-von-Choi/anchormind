# Security and Operations Checklist

Start here before launch day. Use it to decide what to finish before opening the server to the internet, which protections stay on, and what to watch while it runs.

## Before exposing it externally

If you use it only on your machine, skip this section. Before you put it on the internet or a team network, work through these checks from the top.

1. **Put it behind a reverse proxy that terminates TLS.** Set the HSTS header on the proxy too.
2. **Tell the server how many proxies are in front.** Set `TRUST_PROXY_HOPS` to 0 for direct exposure, or 1 when it sits behind one proxy. If you leave it unset, the server trusts the first `X-Forwarded-For` entry.
3. **Use a strong master key.** The server will not start when `MEMENTO_ACCESS_KEY` is empty. Running without authentication requires `MEMENTO_AUTH_DISABLED=true`, and that mode is for development only.
4. **Restrict origins.** See "Origin settings" below.
5. **Change warn-only protections to rejections.** See "Settings to switch to enforce" below.
6. **Create admin accounts.** Password and TOTP sign-in reduces how often people need the master key to enter the console. Setup is covered in [Upgrade Notes](upgrade-notes.en.md#1-anchor-permission-admin-accounts-body-lexical-search-migration-053-to-060).
7. **Check the exposure.** Use the "external exposure check" in [maintenance.md](maintenance.md) to confirm the listen address, authentication keys, and origin allowlist.

### Origin settings

Desktop apps, CLIs, and IDE extensions (Claude Code, Cursor, Windsurf, Continue, Cline, Zed, gemini CLI, and so on) do not send an `Origin` header. If those are your only clients, you do not need to configure origins.

Set these only for browser-based clients.

| Variable | Role |
|----------|------|
| `ALLOWED_ORIGINS` | Browser origins to allow. If unset, every origin is accepted. If set, requests from origins outside the list get 403. |
| `MCP_STRICT_ORIGIN=true` | Also limits `/mcp` to trusted domains. |
| `ADMIN_ALLOWED_ORIGINS` | Origins allowed to call the admin console. If unset, all origins are allowed, so list the console origin or restrict access at the proxy or firewall. |
| `OAUTH_TRUSTED_ORIGINS` | Origins whose consent is approved automatically. If one origin hosts several apps, use full URI matches with `OAUTH_ALLOWED_REDIRECT_URIS`. |
| `MEMENTO_CORS_MODE` | How cross-origin response headers are produced. `observe` is the default: it echoes the request origin and logs first-seen origins. Other options are `reflect` and `allowlist` (only `OAUTH_TRUSTED_ORIGINS`). |

Put only the origins you actually use in `ALLOWED_ORIGINS`. Common candidates include claude.ai, claude.com, chatgpt.com, chat.openai.com, copilot.microsoft.com, gemini.google.com, aistudio.google.com, www.perplexity.ai, cursor.com, codeium.com, windsurf.com, sourcegraph.com, and typingmind.com.

### Settings to switch to enforce

By default, these settings only log a warning and let the request pass. Check the logs first, make sure existing clients still work, then switch them to reject.

| Variable | Default | When switched to reject |
|----------|---------|------------------------|
| `MEMENTO_TOOL_ARGS_VALIDATION` (`off`, `warn`, `enforce`) | `warn` | Calls whose arguments do not match the `tools/list` schema are rejected with -32602. |
| `MEMENTO_SESSION_ID_POLICY` (`warn`, `enforce`) | `warn` | A session ID in the query string gets 400; recovering an ID that was not issued by the server (UUID) gets 404. |
| `MEMENTO_RESERVED_AGENT_IDS` (`warn`, `enforce`) | `warn` | API-key requests using internal agentIds (`system`, `admin`) are rejected with -32001. The master key is still allowed. |
| `MEMENTO_ANCHOR_PERMISSION` (`off`, `warn`, `enforce`) | `warn` | Setting an anchor from a key without the `anchor` permission is rejected. |
| `MEMENTO_WORKSPACE_READ_AUTHZ` (`off`, `warn`, `enforce`) | `warn` | Reading outside the key's `allowed_workspaces`, or a non-master session requesting a master-only preset, is rejected with -32001. |
| `MEMENTO_OAUTH_REDIRECT_CHECK` (`warn`, `enforce`) | `warn` | An error response from `/authorize` no longer redirects to an unregistered `redirect_uri`; it returns 400 JSON instead. |
| `MEMENTO_SSE_QUERY_KEY` (`allow`, `deny`) | `allow` | The legacy SSE `?accessKey=` query key is refused with 401 and a hint to use the `Authorization` header. `allow` accepts it for the master key only. |
| `MEMENTO_ADMIN_AUTH_BACKOFF` (`on`, `off`) | `off` | After 5 consecutive admin authentication failures, the next attempt is delayed up to 60 seconds. During the delay, even a correct key gets 429 (`Retry-After`). |

Before moving `MEMENTO_WORKSPACE_READ_AUTHZ` to `enforce`, review the per-key records collected during the `warn` period (`memento_workspace_read_authz_total` and the warning logs).

Setting `MEMENTO_FRAME_OPTIONS=deny` adds the `X-Frame-Options: DENY` header. Without it, that header is not sent.

## Protections that are always on

- Deny by default: any tool name missing from `TOOL_PERMISSIONS` is rejected, no matter what the permissions say.
- Per-key isolation: `forget`, `amend`, `link`, and `fragment_history` add `key_id` to their SQL conditions. They cannot touch another key's fragments. "Not found" and "no permission" return the same message, so existence does not leak either.
- No spoofed session data: when a client sends internal fields such as `_keyId` or `_permissions`, the server replaces them with the result of its own authentication.
- Key state recheck: sessions opened with an API key re-read the key state every `MEMENTO_SESSION_KEY_RECHECK_MS` (default 30000 ms; 0 disables it). If the key has been deactivated or deleted, the session closes and gets 404 `Session not found`. Permission changes apply to open sessions.
- Admin API permissions: each request is checked against the capability declared for its route. Routes missing from the table are owner-only. Admin accounts sign in with TOTP (required for owner and admin), and session cookies use `SameSite=Strict` with double-submit CSRF checks. Master-key sign-in stays available as an emergency path.
- Provenance and review: a fragment's `origin` and `trust_tier` keep low-trust content out of ANCHOR and CORE injection. Text that tries to override instructions is sent to the review queue.
- Key lifetime: expiry, allowed address ranges, rotation, and revocation are supported. Sessions for a revoked key close immediately.
- Request limits: `/auth`, `/keys` POST, and `/import` POST have per-IP limits. Each API key also gets 100 requests per minute, and each IP gets 30 per minute; both are adjustable by environment variable. `initialize`, `GET /sse`, `/token`, `/register`, and `/authorize` share one IP bucket and return 429 with `Retry-After` when it is exceeded.
- Audit log: tool-call records include the actor (`key=`, the first 8 characters of `sid=`, `ip=`). Admin API changes except GET, plus successful and failed admin authentication, are logged too.
- Response headers: every response includes `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- OpenAPI: when `ENABLE_OPENAPI=true`, `GET /openapi.json` is available. The master key sees all paths; an API key sees a spec filtered to its permissions.

## Checks while running

### Health

| Path | Meaning |
|------|---------|
| `/health` | Combines DB, Redis, pgvector, and worker status. Returns degraded if only some parts are down. Unauthenticated requests get only the status. |
| `/health/live` | Checks only that the process is alive. Always 200. |
| `/health/ready` | Returns 200 if the primary DB answers within `MEMENTO_HEALTH_READY_DB_TIMEOUT_MS` (default 2000); otherwise returns 503 with `db_timeout` or `db_error`. |

`memento-watchdog.sh` watches `/health/live` only. It restarts the service when that endpoint stops responding, backs off exponentially after consecutive restarts, and uses a lock to avoid duplicate runs.

### What happens automatically

- Worker recovery: embedding and evaluation workers retry after an error, with exponential backoff from 1 to 60 seconds.
- Graceful shutdown: on `SIGTERM`, the service waits up to 30 seconds for running workers, then runs auto-reflect for sessions. The full shutdown is capped by `MEMENTO_SHUTDOWN_DEADLINE_MS` (default 60000, 0 for no limit); if it passes that cap, the process is killed with exit code 1.
- OAuth error responses: failed authentication returns a `WWW-Authenticate` header, so OAuth clients can start the flow on their own. The default session TTL is 43200 minutes (30 days); set `SESSION_TTL_MINUTES` to change it.

### What you run yourself

- Backups: `scripts/ops/backup.sh` runs `pg_dump` on the `agent_memory` schema and keeps 14 days by default. `scripts/ops/restore-verify.mjs` restores into a disposable test server and compares the result with the manifest. See [backup-restore.md](backup-restore.md).
- Indexes on large tables: `scripts/ops/online-index.mjs` builds indexes without blocking writes (`--dry-run`, `--confirm`). See [online-migration.md](online-migration.md).
- Audit verification: `anchormind audit verify` recomputes the hash chain. A broken chain exits with code 1. Emergency recovery for a lost admin account is `anchormind admin recover --confirm`.
- Feature switch report: `npm run switches` prints each switch's applied value, default, and state as a table. With `--strict`, it exits with code 1 if any switch has an invalid value.
- Migration lint: `npm run lint:migrations`.
- Metrics: `/metrics` exposes Prometheus-format metrics. Master-key authentication is required when `MEMENTO_ACCESS_KEY` is set. Shared Prometheus configuration is in [monitoring.md](monitoring.md).

More operations documents are in this directory: LLM provider chain, symbolic hard gate, agent worktree, upstream porting, and others.

## Known limitations

- Automatic quality evaluation covers only the `decision`, `preference`, and `relation` types. It does not include `fact`, `procedure`, or `error`.
- The L1 Redis index is per API key. When filling the hot cache and working memory, it rechecks the effective agent scope; old cache entries without agent information are excluded safely.
