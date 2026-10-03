---
title: "Plugin Install (Claude Code, Codex)"
date: 2026-10-03
author: 최진호
updated: 2026-10-03
---

# 플러그인 설치 (Claude Code, Codex)

AnchorMind 플러그인은 MCP 연결, 세션 훅, 스킬을 한 번에 설치한다. 훅을 손으로 설정하는 방법은 [훅 설정](hooks.md)에 있고, 플러그인은 같은 훅을 묶어 배포한다. 플러그인 원본은 저장소의 `integrations/claude-code`, `integrations/codex`이고, `anchormind init`이 이를 로컬 플러그인 마켓플레이스 디렉터리로 만든다.

| 구성 | Claude Code | Codex |
|-|-|-|
| MCP 연결 | 플러그인 `.mcp.json`(서버 주소와 키를 플러그인 설정값으로 받음) | `~/.codex/config.toml`에 직접 등록(키는 환경 변수 이름만 적음) |
| 훅 | `SessionStart`(startup, resume, compact), `SessionEnd` | `SessionStart`, `SessionEnd` |
| 스킬 | `skills/anchormind`(기억 도구 핵심 규칙, 상세는 `get_skill_guide`) | 없음(서버 instructions와 `get_skill_guide`) |
| 키 보관 | 운영체제 보안 저장소(`sensitive` 설정값) | 환경 변수 `MEMENTO_CLI_KEY` |

API 키는 어떤 플러그인 파일에도 들어가지 않는다.

## 준비

1. 관리 콘솔에서 이 용도의 API 키를 만든다. 세션 시작 주입만 쓰면 read, 세션 종료 회고까지 쓰면 read와 write 권한을 준다. 프로젝트별 workspace를 쓰려면 키의 `allowed_workspaces`에 workspace 이름을 넣는다([workspace 결정](hooks.md#workspace-결정)).
2. 훅은 `anchormind hook`을 실행하므로 `anchormind` 명령이 PATH에 있어야 한다. 저장소에서 설치했다면 저장소 루트에서 `npm link`를 실행한다.
3. 키는 셸 환경 변수로 둔다. 설정 파일이나 명령줄에 키를 직접 쓰지 않는다.

   ```bash
   # ~/.bashrc, ~/.zshrc 또는 비밀 관리 도구가 내보내는 환경
   export MEMENTO_CLI_REMOTE="https://memento.example.com/mcp"
   export MEMENTO_CLI_KEY="<발급한 API 키>"
   ```

## 플러그인 파일 만들기

`anchormind init`은 기본이 dry-run이다. 만들 파일과 기존 파일과의 diff를 출력하고 아무것도 쓰지 않는다.

```bash
anchormind init --target claude          # 확인만
anchormind init --target claude --write  # ~/.anchormind/claude-code에 쓴다
```

- `--dir <경로>`로 위치를 바꾼다. 기본은 `~/.anchormind/claude-code`, `~/.anchormind/codex`다.
- 이미 있는 파일과 내용이 다르면 `conflict`로 표시하고, `--force` 없이는 아무 파일도 쓰지 않는다. 직접 고친 파일을 지키려면 `--force`를 주지 않는다.
- 디렉터리나 심볼릭 링크가 있는 경로는 `--force`를 주어도 쓰지 않는다.
- 서버 버전을 올린 뒤 같은 명령을 다시 실행하면 바뀐 파일만 `conflict`로 나온다. 확인 후 `--write --force`로 바꾸고 하네스에서 플러그인을 갱신한다.

## Claude Code

```bash
anchormind init --target claude --write
claude plugin marketplace add ~/.anchormind/claude-code
claude plugin install anchormind@anchormind-local
```

플러그인을 켤 때 Claude Code가 두 값을 묻는다.

| 설정값 | 내용 | 보관 위치 |
|-|-|-|
| `server_url` | MCP 주소, 예: `https://memento.example.com/mcp` | `settings.json`의 `pluginConfigs` |
| `api_key` | 발급한 API 키 | 운영체제 보안 저장소 |

명령줄에서 값을 넣으려면 `claude plugin configure`에 표준 입력으로 준다. 키는 환경 변수에서 읽어 넘기므로 명령줄과 셸 기록에 남지 않는다.

```bash
printf '{"server_url":"%s","api_key":"%s"}' "$MEMENTO_CLI_REMOTE" "$MEMENTO_CLI_KEY" \
  | claude plugin configure anchormind@anchormind-local --values-stdin
```

- MCP 연결은 `${user_config.server_url}`, `${user_config.api_key}`로 채워진다.
- 훅 프로세스는 같은 값을 `CLAUDE_PLUGIN_OPTION_SERVER_URL`, `CLAUDE_PLUGIN_OPTION_API_KEY`로 받는다. `anchormind hook`은 이 값을 `MEMENTO_CLI_REMOTE`, `MEMENTO_CLI_KEY`보다 먼저 쓰므로 훅과 MCP 연결이 같은 서버와 키를 쓴다.
- [훅 설정](hooks.md)대로 `~/.claude/settings.json`에 같은 훅을 이미 걸었다면 지운다. 두 곳에 있으면 주입과 회고가 두 번 실행된다.
- 설치 없이 시험하려면 저장소에서 `claude --plugin-dir integrations/claude-code`로 실행한다.
- 갱신: `anchormind init --target claude --write --force` 뒤 `claude plugin update anchormind@anchormind-local`(재시작 후 적용).

확인:

```bash
claude plugin validate ~/.anchormind/claude-code
```

새 세션을 열면 `/mcp`에 `anchormind`가 연결되어 있고, 첫 응답 전에 기억 주입(`[ANCHOR MEMORY]` 등)이 컨텍스트에 들어간다.

## Codex

```bash
anchormind init --target codex --url "$MEMENTO_CLI_REMOTE" --write
codex plugin marketplace add ~/.anchormind/codex
codex plugin add anchormind@anchormind-local
```

1. Codex에서 `/hooks`로 플러그인 훅을 확인하고 신뢰한다. 신뢰하지 않은 훅은 실행되지 않는다.
2. MCP 서버를 `~/.codex/config.toml`에 등록한다. 키 값이 아니라 환경 변수 이름만 적는다.

   ```toml
   [mcp_servers.anchormind]
   url = "https://memento.example.com/mcp"
   bearer_token_env_var = "MEMENTO_CLI_KEY"
   ```

   같은 설정을 명령으로 넣을 수도 있다: `codex mcp add anchormind --url https://memento.example.com/mcp --bearer-token-env-var MEMENTO_CLI_KEY`.
3. Codex를 실행하는 환경에 `MEMENTO_CLI_REMOTE`, `MEMENTO_CLI_KEY`가 있어야 한다. MCP 연결과 훅이 모두 이 값을 읽는다.

- Codex 플러그인 형식(Agent Plugins)의 `mcp.json`은 헤더 값에 환경 변수를 치환하지 않고 비밀을 넣지 말라고 정하므로, 키가 필요한 MCP 연결은 플러그인에 넣지 않고 `config.toml`에 둔다.
- Codex는 훅 출력이 약 2500 토큰을 넘으면 본문 대신 파일 경로를 넘기므로 서버는 Codex 주입 예산을 1500 토큰으로 둔다.
- 갱신: `anchormind init --target codex --write --force` 뒤 Codex에서 플러그인을 다시 설치한다(`codex plugin remove anchormind@anchormind-local`, `codex plugin add anchormind@anchormind-local`).

## 문제 해결

| 증상 | 확인할 것 |
|-|-|
| 세션 시작에 기억이 주입되지 않는다 | `anchormind`가 PATH에 있는지(`which anchormind`), 키에 read 권한이 있는지, 서버의 `MEMENTO_HOOK_ENDPOINTS`가 `on`인지 |
| 회고가 남지 않는다 | 키에 write 권한이 있는지, 서버 지표 `memento_hook_reflect_total{outcome}` |
| 다른 프로젝트 기억이 섞인다 | 키의 `allowed_workspaces`와 [workspace 결정](hooks.md#workspace-결정) 규칙 |
| `init`이 `conflict`로 멈춘다 | diff를 보고 직접 고친 내용이 없으면 `--write --force` |
| Codex 훅이 실행되지 않는다 | `/hooks`에서 신뢰했는지, `config.toml`의 `[features] hooks = false` 여부 |

훅 응답 코드와 오류 문구는 [훅 설정](hooks.md#응답-코드)에 있다.
