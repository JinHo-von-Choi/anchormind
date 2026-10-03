---
title: "Plugin Install (Claude Code, Codex)"
date: 2026-10-03
author: 최진호
updated: 2026-10-03
---

# Plugin Install (Claude Code, Codex)

The AnchorMind plugin installs the MCP connection, the session hooks and the skill in one step. Setting the hooks up by hand is described in [Hook Setup](hooks.en.md); the plugin ships the same hooks as a bundle. The plugin sources are `integrations/claude-code` and `integrations/codex` in the repository, and `anchormind init` turns them into a local plugin marketplace directory.

| Part | Claude Code | Codex |
|-|-|-|
| MCP connection | Plugin `.mcp.json` (server URL and key come from plugin settings) | Registered in `~/.codex/config.toml` (only the environment variable name of the key is written) |
| Hooks | `SessionStart` (startup, resume, compact), `SessionEnd` | `SessionStart`, `SessionEnd` |
| Skill | `skills/anchormind` (core memory tool rules, details through `get_skill_guide`) | None (server instructions and `get_skill_guide`) |
| Key storage | Operating system credential store (`sensitive` setting) | Environment variable `MEMENTO_CLI_KEY` |

The API key is not written to any plugin file.

## Preparation

1. Create an API key for this purpose in the admin console. Grant read for session start injection only, or read and write to also record session end reflections. To use per project workspaces, add the workspace names to the key's `allowed_workspaces` ([Workspace selection](hooks.en.md#workspace-selection)).
2. The hooks run `anchormind hook`, so the `anchormind` command must be on PATH. If you installed from the repository, run `npm link` in the repository root.
3. Keep the key in a shell environment variable. Never write the key into a configuration file or on the command line.

   ```bash
   # ~/.bashrc, ~/.zshrc, or the environment exported by your secret manager
   export MEMENTO_CLI_REMOTE="https://memento.example.com/mcp"
   export MEMENTO_CLI_KEY="<issued API key>"
   ```

## Creating the plugin files

`anchormind init` is a dry-run by default. It prints the files it would create and a diff against existing files, and writes nothing.

```bash
anchormind init --target claude          # check only
anchormind init --target claude --write  # write to ~/.anchormind/claude-code
```

- `--dir <path>` changes the location. The defaults are `~/.anchormind/claude-code` and `~/.anchormind/codex`.
- An existing file with different content is reported as `conflict`, and without `--force` no file is written at all. Leave out `--force` to keep files you edited yourself.
- A path that holds a directory or symbolic link is never written, even with `--force`.
- After upgrading the server, running the same command again reports only the changed files as `conflict`. Review them, replace them with `--write --force`, and update the plugin in the harness.

## Claude Code

```bash
anchormind init --target claude --write
claude plugin marketplace add ~/.anchormind/claude-code
claude plugin install anchormind@anchormind-local
```

When the plugin is enabled, Claude Code asks for two values.

| Setting | Content | Stored in |
|-|-|-|
| `server_url` | MCP URL, for example `https://memento.example.com/mcp` | `pluginConfigs` in `settings.json` |
| `api_key` | The issued API key | Operating system credential store |

To set the values from the command line, pass them to `claude plugin configure` on standard input. The key is read from the environment variable and serialized as JSON, so it does not appear on the command line or in the shell history, and a key containing `"` or `\` still yields valid JSON.

```bash
node -e 'process.stdout.write(JSON.stringify({ server_url: process.env.MEMENTO_CLI_REMOTE, api_key: process.env.MEMENTO_CLI_KEY }))' \
  | claude plugin configure anchormind@anchormind-local --values-stdin
```

- The MCP connection is filled from `${user_config.server_url}` and `${user_config.api_key}`.
- Hook processes receive the same values as `CLAUDE_PLUGIN_OPTION_SERVER_URL` and `CLAUDE_PLUGIN_OPTION_API_KEY`. When both are present, `anchormind hook` uses them before the `MEMENTO_CLI_REMOTE`, `MEMENTO_CLI_KEY` pair, so the hooks and the MCP connection use the same server and key. When only one is present both are ignored with a warning. The URL and key are always a pair from one source, and the `.env` of the repository being worked on is not read.
- If you already added the same hooks to `~/.claude/settings.json` following [Hook Setup](hooks.en.md), remove them. With both in place, injection and reflection run twice.
- To try the plugin without installing it, run `claude --plugin-dir integrations/claude-code` from the repository.
- Update: `anchormind init --target claude --write --force`, then `claude plugin update anchormind@anchormind-local` (applies after a restart).

Check:

```bash
claude plugin validate ~/.anchormind/claude-code
```

In a new session, `/mcp` shows `anchormind` connected, and the memory injection (`[ANCHOR MEMORY]` and so on) is in the context before the first response.

## Codex

```bash
anchormind init --target codex --url "$MEMENTO_CLI_REMOTE" --write
codex plugin marketplace add ~/.anchormind/codex
codex plugin add anchormind@anchormind-local
```

1. In Codex, review and trust the plugin hooks with `/hooks`. Untrusted hooks do not run.
2. Register the MCP server in `~/.codex/config.toml`. Write the environment variable name, not the key value.

   ```toml
   [mcp_servers.anchormind]
   url = "https://memento.example.com/mcp"
   bearer_token_env_var = "MEMENTO_CLI_KEY"
   ```

   The same setting can be added with a command: `codex mcp add anchormind --url https://memento.example.com/mcp --bearer-token-env-var MEMENTO_CLI_KEY`.
3. `MEMENTO_CLI_REMOTE` and `MEMENTO_CLI_KEY` must be present in the environment Codex runs in. Both the MCP connection and the hooks read them.

- The Codex plugin format (Agent Plugins) does not substitute environment variables in `mcp.json` header values and forbids secrets there, so the MCP connection that needs the key lives in `config.toml` instead of the plugin.
- Codex hands over a file path instead of the hook output when the output exceeds about 2500 tokens, so the server keeps the Codex injection budget at 1500 tokens.
- Update: `anchormind init --target codex --write --force`, then reinstall the plugin in Codex (`codex plugin remove anchormind@anchormind-local`, `codex plugin add anchormind@anchormind-local`).

## Troubleshooting

| Symptom | Check |
|-|-|
| No memory is injected at session start | `anchormind` is on PATH (`which anchormind`), the key has read permission, the server's `MEMENTO_HOOK_ENDPOINTS` is `on` |
| No reflection is recorded | The key has write permission; server metric `memento_hook_reflect_total{outcome}` |
| Memories of other projects mix in | The key's `allowed_workspaces` and the [Workspace selection](hooks.en.md#workspace-selection) rules |
| `init` stops with `conflict` | Review the diff; if you made no edits, use `--write --force` |
| Codex hooks do not run | Whether you trusted them in `/hooks`, and whether `config.toml` sets `[features] hooks = false` |

Hook response codes and error strings are in [Hook Setup](hooks.en.md#response-codes).
