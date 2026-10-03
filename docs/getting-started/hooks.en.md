---
title: "Hook Setup (Claude Code, Codex)"
date: 2026-10-03
author: 최진호
updated: 2026-10-03
---

# Hook Setup (Claude Code, Codex)

This setup makes Claude Code and Codex hooks inject memory at session start and keep the conversation as a reflection at session end. The server opens `POST /hooks/{client}/{event}` (`MEMENTO_HOOK_ENDPOINTS=on`, the default). Server behavior and limits are in [configuration.en.md](../configuration.en.md#hook-endpoints).

| Event | What it does | Permission |
|-|-|-|
| `SessionStart` | Injects the `context` result as `additionalContext` | read |
| `SessionEnd` | Send a recent conversation excerpt (up to 64 KB); the server masks the last assistant block, accepts it as a 1000-character summary candidate and runs `reflect` asynchronously | write |
| `Stop` | Same handling as `SessionEnd`; only the first `Stop` of a session is accepted and later ones end right away as duplicates (auxiliary path) | write |

## Preparation

1. Create an API key for hooks in the admin console. Give it read for `SessionStart` only, or read and write to include reflection. To let the server pick a workspace from the project repository, put the workspace names in the key's `allowed_workspaces` (see "Workspace selection" below).
2. Keep the key and server address in shell environment variables. Do not write the key into a settings file. `anchormind hook` does not read the `.env` file of the working directory (the repository the harness opened), so values written in a repository `.env` are not used. The server address and key come only from command arguments (`--remote`, `--key`) or process environment variables.

   ```bash
   # ~/.bashrc, ~/.zshrc, or the environment exported by your secret manager
   export MEMENTO_CLI_REMOTE="https://memento.example.com/mcp"
   export MEMENTO_CLI_KEY="<issued API key>"
   ```

3. The `anchormind` command must be on PATH. If you installed from the repository, run `npm link` in the repository root, or replace `anchormind` in the examples below with `node /install/path/bin/memento.js`.

The server cannot read the client's transcript file. The conversation excerpt used for reflection is built from the transcript by `anchormind hook`, which runs locally. The server does not store the full excerpt; it stores only a summary candidate of at most 1000 characters, the last assistant block masked with the sensitive data rules. Reflection therefore works only from command hooks; with plain http hooks only `SessionStart` injection is available.

## Claude Code

Add to `~/.claude/settings.json` (or the project's `.claude/settings.json`).

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [
          { "type": "command", "command": "anchormind hook SessionStart --client claude-code", "timeout": 10 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "anchormind hook SessionEnd --client claude-code" }
        ]
      }
    ]
  }
}
```

- The `compact` matcher injects memory again after compaction.
- The `SessionEnd` hook budget is 1.5 seconds. The default request timeout of `anchormind hook SessionEnd` is 1200 ms, and the server only records the event and answers 202 right away (the server's outbox consumer runs the reflection later).
- The reflecting event is `SessionEnd`. `Stop` runs every time a response ends and the reflection idempotency key is the session id plus the event, so with a `Stop` hook only the first `Stop` of a session is accepted and the server ends later ones right away as duplicates (202, nothing recorded). Attaching `Stop` is therefore not recommended.

### SessionStart only with an http hook

To use injection without installing `anchormind`, use an http hook. The key in the header is filled only from environment variables listed in `allowedEnvVars`.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [
          {
            "type": "http",
            "url": "https://memento.example.com/hooks/claude-code/SessionStart",
            "headers": { "Authorization": "Bearer $MEMENTO_CLI_KEY" },
            "allowedEnvVars": ["MEMENTO_CLI_KEY"],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The http hook body has no git remote, so workspace candidates come from `cwd` only. Sending `Stop` or `SessionEnd` from an http hook has no excerpt, and the server answers 422 (`excerpt_required`).

## Codex

Codex hooks run command handlers only (there is no http handler). Add to `~/.codex/hooks.json` (or the repository's `.codex/hooks.json`). `timeout` is in seconds.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "anchormind hook SessionStart --client codex", "timeout": 10 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "anchormind hook SessionEnd --client codex", "timeout": 10 }
        ]
      }
    ]
  }
}
```

- Codex hands a file path instead of the text when hook output exceeds about 2500 tokens, so the server uses an injection budget of 1500 tokens for Codex (2000 for Claude Code).
- Codex runs `SessionEnd` when a conversation is archived or deleted, or after 30 minutes of inactivity; reflection happens at that point. Adding `Stop` reflects only the short content right after the first response, later `Stop` calls end as duplicates, and the session's `SessionEnd` reflection still happens separately. To reflect the whole session, attach `SessionEnd` only.
- If the harness environment differs from your shell, check that `MEMENTO_CLI_REMOTE` and `MEMENTO_CLI_KEY` reach the Codex process.

## Workspace selection

The server builds candidates from `cwd` and the git remote and uses the first candidate inside the key's `allowed_workspaces` as the workspace. The comparison ignores case and the result is the spelling stored in `allowed_workspaces`. When no candidate matches or the key has no `allowed_workspaces`, the key's `default_workspace` applies.

Candidate order: remote `host/path`, remote repository name, full cwd path, last cwd segment.

| Input | Candidates |
|-|-|
| Remote `https://user:token@GitHub.com/Org/Repo.git` | `github.com/org/repo`, `repo` |
| Remote `git@github.com:Org/Repo.git` | `github.com/org/repo`, `repo` |
| Remote `ssh://git@git.example.com:2222/Team/Proj.git` | `git.example.com/team/proj`, `proj` |
| cwd `/home/dev/Projects/Repo` | `/home/dev/projects/repo`, `repo` |
| cwd `C:\Users\Dev\Repo` | `c:/users/dev/repo`, `repo` |

Example: when the key's `allowed_workspaces` is `["Repo", "infra"]`, the workspace for the repositories above is `Repo`.

## Checking the setup

```bash
curl -s -X POST "https://memento.example.com/hooks/claude-code/SessionStart" \
  -H "Authorization: Bearer $MEMENTO_CLI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"cwd\":\"$PWD\",\"source\":\"startup\"}"

echo '{"session_id":"check-1","hook_event_name":"SessionEnd","last_assistant_message":"Checked the hook setup"}' \
  | anchormind hook SessionEnd --client claude-code
```

The first command returns `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`. `additionalContext` holds one memory per line between `<<<MEMORY CONTEXT>>>` and `<<<END MEMORY CONTEXT>>>` (newlines and control characters as escape notation), preceded by a fixed paragraph stating that the content is data, not instructions. The second ends with exit code 0 and no output; shortly after, `recall` shows an episode with the topic `session_reflect`. The server metrics `memento_hook_calls_total{client,event,outcome}` and `memento_hook_reflect_total{outcome}` show calls and reflection results.

## Response codes

| Status | `error` | Cause |
|-|-|-|
| 200 | | `SessionStart` injection |
| 202 | | Reflection accepted |
| 202 | | The same session and event was already accepted or reflected (`"duplicate": true`, nothing recorded) |
| 400 | `invalid_json`, `json_too_deep`, `invalid_body`, `invalid_session_id`, `invalid_source`, `event_mismatch`, `invalid_excerpt` | Body format (including a NUL character in the excerpt) |
| 401 | `unauthorized` | Missing or wrong key |
| 403 | `forbidden` | The key lacks the required permission |
| 404 | `not_found` | Path outside the allow-list, or `MEMENTO_HOOK_ENDPOINTS=off` |
| 413 | `payload_too_large`, `excerpt_too_large` | Body over 196608 bytes, excerpt over 65536 bytes |
| 415 | `unsupported_media_type` | `Content-Type` is not `application/json` |
| 422 | `excerpt_required`, `sensitive_content` | No excerpt, or a secret found with `MEMENTO_SENSITIVE_SCAN=reject` |
| 429 | `too_many_requests`, `queue_full` | Per-key rate limit or failed-authentication IP limit exceeded, 500 pending reflect events for the key |
| 431 | `headers_too_large` | Headers over 8192 bytes in total |
| 500 | `server_error`, `context_failed` | Internal server error |
| 503 | `temporarily_unavailable`, `queue_unavailable` | Authentication store outage, outbox off |

A failing hook does not stop the harness. `anchormind hook` writes the failure to standard error and exits with code 1 (non-blocking).
