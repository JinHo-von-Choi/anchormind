# Security and Operations Checklist

What to do before opening the server to the internet, which protections are always on, and what to check while it runs.

## Before exposing it externally

If you only use it locally, you can skip this section. When you open it to the internet or a team network, go through it from the top.

1. **Put it behind a reverse proxy that terminates TLS.** Set the HSTS header on the proxy as well.
2. **Tell the server how many proxies are in front.** Set `TRUST_PROXY_HOPS` to 0 for direct exposure, or 1 behind a single proxy. If unset, the first `X-Forwarded-For` entry is trusted.
3. **Make the master key strong.** The server refuses to start when `MEMENTO_ACCESS_KEY` is empty. Running without authentication requires explicitly setting `MEMENTO_AUTH_DISABLED=true`, and is for development only.
4. **Restrict origins.** See "Origin settings" below.
5. **Turn warn-only protections into rejections.** See "Settings to switch to enforce" below.
6. **Create admin accounts.** Accounts that sign in with a password and TOTP reduce how often the master key is used to enter the console. Setup is in [Upgrade Notes](upgrade-notes.en.md#1-anchor-permission-admin-accounts-body-lexical-search-migration-053-to-060).
7. **Check the exposure.** Use the "external exposure check" in [maintenance.md](maintenance.md) to confirm the listen address, authentication keys and origin allowlist.

### Origin settings

Desktop apps, CLIs and IDE extensions (Claude Code, Cursor, Windsurf, Continue, Cline, Zed, gemini CLI and so on) do not send an `Origin` header. If you only use such clients, you do not need any origin setting.

Configure these only when you use browser-based clients.

| Variable | Role |
|----------|------|
| `ALLOWED_ORIGINS` | Browser origins to allow. If unset, every origin is accepted. If set, requests from origins outside the list end with 403. |
| `MCP_STRICT_ORIGIN=true` | Narrows `/mcp` to trusted domains as well. |
| `ADMIN_ALLOWED_ORIGINS` | Origins allowed to call the admin console. If unset, all are allowed, so list the console origin or restrict access at the proxy or firewall. |
| `OAUTH_TRUSTED_ORIGINS` | Origins whose consent is approved automatically. If one origin hosts several apps, matching full URIs with `OAUTH_ALLOWED_REDIRECT_URIS` is recommended. |
| `MEMENTO_CORS_MODE` | How cross-origin response headers are produced. `observe` (default: echoes the request origin and logs first-seen origins), `reflect`, or `allowlist` (only `OAUTH_TRUSTED_ORIGINS`). |

Put only the origins you really use in `ALLOWED_ORIGINS`. Common candidates: claude.ai, claude.com, chatgpt.com, chat.openai.com, copilot.microsoft.com, gemini.google.com, aistudio.google.com, www.perplexity.ai, cursor.com, codeium.com, windsurf.com, sourcegraph.com, typingmind.com.

### Settings to switch to enforce

By default these only log a warning and let the request through. Check the logs to confirm no existing client breaks, then switch them to reject.

| Variable | Default | When switched to reject |
|----------|---------|------------------------|
| `MEMENTO_TOOL_ARGS_VALIDATION` (`off`, `warn`, `enforce`) | `warn` | Calls whose arguments do not match the `tools/list` schema are rejected with -32602. |
| `MEMENTO_SESSION_ID_POLICY` (`warn`, `enforce`) | `warn` | A session ID in the query string gets 400; recovering an ID that is not server-issued (UUID) gets 404. |
| `MEMENTO_RESERVED_AGENT_IDS` (`warn`, `enforce`) | `warn` | API-key requests that use the internal agentIds (`system`, `admin`) are rejected with -32001. The master key is allowed. |
| `MEMENTO_ANCHOR_PERMISSION` (`off`, `warn`, `enforce`) | `warn` | Setting an anchor from a key without the `anchor` permission is rejected. |
| `MEMENTO_WORKSPACE_READ_AUTHZ` (`off`, `warn`, `enforce`) | `warn` | Reading outside the key's `allowed_workspaces`, or a non-master session requesting a master-only preset, is rejected with -32001. |
| `MEMENTO_OAUTH_REDIRECT_CHECK` (`warn`, `enforce`) | `warn` | An error response from `/authorize` no longer redirects to an unregistered `redirect_uri`; it returns 400 JSON. |
| `MEMENTO_SSE_QUERY_KEY` (`allow`, `deny`) | `allow` | The legacy SSE `?accessKey=` query key is refused with 401 and a hint to use the `Authorization` header. `allow` accepts it for the master key only. |
| `MEMENTO_ADMIN_AUTH_BACKOFF` (`on`, `off`) | `off` | After 5 consecutive admin authentication failures the next attempt is delayed up to 60 seconds. During the delay even a correct key gets 429 (`Retry-After`). |

Before moving `MEMENTO_WORKSPACE_READ_AUTHZ` to `enforce`, review the per-key records accumulated during the `warn` period (`memento_workspace_read_authz_total` and the warning logs).

Setting `MEMENTO_FRAME_OPTIONS=deny` adds the `X-Frame-Options: DENY` header. Without it, this header is not sent.

## Protections that are always on

- Deny by default: a tool name that is not in `TOOL_PERMISSIONS` is rejected regardless of permissions.
- Per-key isolation: `forget`, `amend`, `link` and `fragment_history` include `key_id` in their SQL conditions, so they cannot reach another key's fragments. "Not found" and "no permission" return the same message, so existence is not revealed either.
- No spoofed session data: internal fields such as `_keyId` and `_permissions` sent by a client are overwritten with the server's authentication result.
- Key state recheck: sessions opened with an API key re-read the key state every `MEMENTO_SESSION_KEY_RECHECK_MS` (default 30000 ms, 0 disables). A session for a deactivated or deleted key is closed and receives 404 `Session not found`. Permission changes reach open sessions.
- Admin API permissions: each request is checked against the capability declared for its route, and routes missing from the table are owner-only. Admin accounts sign in with TOTP (required for owner and admin), and session cookies use `SameSite=Strict` plus double-submit CSRF checks. Master-key sign-in remains as an emergency path.
- Provenance and review: a fragment's `origin` and `trust_tier` keep low-trust content out of ANCHOR and CORE injection. Text that tries to override instructions goes to the review queue.
- Key lifetime: expiry, allowed address ranges, rotation and revocation are supported. Sessions of a revoked key close immediately.
- Request limits: `/auth`, `/keys` POST and `/import` POST have per-IP limits. Beyond that, each API key gets 100 requests per minute and each IP 30 per minute, adjustable by environment variable. `initialize`, `GET /sse`, `/token`, `/register` and `/authorize` share one IP bucket and return 429 with `Retry-After` when it is exceeded.
- Audit log: tool-call records carry the actor (`key=`, the first 8 characters of `sid=`, `ip=`). Admin API changes (except GET) and admin authentication successes and failures are recorded too.
- Response headers: every response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- OpenAPI: with `ENABLE_OPENAPI=true`, `GET /openapi.json` is available. The master key sees all paths; an API key sees a spec filtered by its permissions.

## Checks while running

### Health

| Path | Meaning |
|------|---------|
| `/health` | Combines DB, Redis, pgvector and worker status. Returns degraded when only some parts are down. Unauthenticated requests get the status only. |
| `/health/live` | Only checks that the process is alive. Always 200. |
| `/health/ready` | 200 if the primary DB answers within `MEMENTO_HEALTH_READY_DB_TIMEOUT_MS` (default 2000); otherwise 503 with `db_timeout` or `db_error`. |

`memento-watchdog.sh` restarts the service only when `/health/live` stops responding. Consecutive restarts back off exponentially and a lock prevents duplicate runs.

### What happens automatically

- Worker recovery: embedding and evaluation workers retry with exponential backoff from 1 to 60 seconds after an error.
- Graceful shutdown: on `SIGTERM` it waits up to 30 seconds for running workers and then runs auto-reflect for sessions. The whole shutdown is bounded by `MEMENTO_SHUTDOWN_DEADLINE_MS` (default 60000, 0 for no limit); beyond it the process is killed with exit code 1.
- OAuth error responses: a failed authentication returns a `WWW-Authenticate` header, so OAuth clients can start the flow by themselves. The default session TTL is 43200 minutes (30 days); change it with `SESSION_TTL_MINUTES`.

### What you run yourself

- Backups: `scripts/ops/backup.sh` runs `pg_dump` on the `agent_memory` schema and keeps 14 days by default. `scripts/ops/restore-verify.mjs` restores into a disposable test server and compares against the manifest. See [backup-restore.md](backup-restore.md).
- Indexes on large tables: `scripts/ops/online-index.mjs` builds them without blocking writes (`--dry-run`, `--confirm`). See [online-migration.md](online-migration.md).
- Audit verification: `anchormind audit verify` recomputes the hash chain. A broken chain exits with code 1. Emergency recovery for a lost admin account is `anchormind admin recover --confirm`.
- Feature switch report: `npm run switches` prints each switch's applied value, default and state as a table. With `--strict` it exits with code 1 if any switch has an invalid value.
- Migration lint: `npm run lint:migrations`.
- Metrics: `/metrics` exposes Prometheus-format metrics (master-key authentication is required when `MEMENTO_ACCESS_KEY` is set). Shared Prometheus configuration is in [monitoring.md](monitoring.md).

More operations documents are in this directory: LLM provider chain, symbolic hard gate, agent worktree, upstream porting and others.

## Known limitations

- Automatic quality evaluation only covers the `decision`, `preference` and `relation` types. `fact`, `procedure` and `error` are left out of the evaluation queue.
- The L1 Redis index is per API key. When filling the hot cache and working memory it rechecks the effective agent scope, and old cache entries without agent information are safely excluded.
