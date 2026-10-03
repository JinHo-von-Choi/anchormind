---
title: "Hook Setup (Claude Code, Codex)"
date: 2026-10-03
author: 최진호
updated: 2026-10-03
---

# 훅 설정 (Claude Code, Codex)

Claude Code와 Codex의 훅이 세션 시작에 기억을 주입하고 세션 종료에 대화를 회고로 남기게 하는 설정이다. 서버는 `POST /hooks/{client}/{event}`를 연다(`MEMENTO_HOOK_ENDPOINTS=on`, 기본값). 서버 동작과 상한은 [configuration.md](../configuration.md#훅-엔드포인트)에 있다. 같은 훅을 MCP 연결, 스킬과 함께 플러그인으로 설치하려면 [플러그인 설치](plugins.md)를 따른다.

| 이벤트 | 하는 일 | 필요한 권한 |
|-|-|-|
| `SessionStart` | `context` 결과를 `additionalContext`로 주입 | read |
| `SessionEnd` | 최근 대화 발췌(64 KB 이하)를 보내면 서버가 마지막 응답 블록을 가려 1000자 요약 후보로 접수하고 비동기로 `reflect` | write |
| `Stop` | `SessionEnd`와 같은 처리. 세션의 첫 `Stop`만 접수하고 그 뒤는 중복으로 바로 끝나는 보조 경로 | write |

## 준비

1. 훅 전용 API 키를 관리 콘솔에서 만든다. `SessionStart`만 쓰면 read, 회고까지 쓰면 read와 write 권한을 준다. 프로젝트 저장소에서 workspace를 고르게 하려면 키의 `allowed_workspaces`에 workspace 이름을 넣는다(아래 "workspace 결정").
2. 키와 서버 주소를 셸 환경 변수로 둔다. 키를 설정 파일에 직접 쓰지 않는다. `anchormind hook`은 작업 디렉터리(하네스가 연 저장소)의 `.env`를 읽지 않으므로, 저장소의 `.env`에 적은 값은 쓰이지 않는다. 서버 주소와 키는 명령 인자(`--remote`, `--key`)나 프로세스 환경 변수에서만 읽는다.

   ```bash
   # ~/.bashrc, ~/.zshrc 또는 비밀 관리 도구가 내보내는 환경
   export MEMENTO_CLI_REMOTE="https://memento.example.com/mcp"
   export MEMENTO_CLI_KEY="<발급한 API 키>"
   ```

3. `anchormind` 명령이 PATH에 있어야 한다. 저장소에서 설치했다면 저장소 루트에서 `npm link`를 실행하거나, 아래 예시의 `anchormind`를 `node /설치/경로/bin/memento.js`로 바꾼다.

서버는 클라이언트의 transcript 파일을 읽을 수 없다. 회고에 쓸 대화 발췌는 로컬에서 실행되는 `anchormind hook`이 transcript에서 만들어 보낸다. 서버는 발췌 전체를 저장하지 않고 마지막 응답 블록을 민감 정보 규칙으로 가린 1000자 이하의 요약 후보만 저장한다. 그래서 회고는 command 훅에서만 동작하고, http 훅만 쓰면 `SessionStart` 주입만 된다.

## Claude Code

`~/.claude/settings.json`(또는 프로젝트의 `.claude/settings.json`)에 추가한다.

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

- `compact` matcher는 압축 뒤 기억을 다시 주입한다.
- `SessionEnd` 훅의 예산은 1.5초다. `anchormind hook SessionEnd`의 기본 요청 제한 시간은 1200 ms이고, 서버는 기록만 하고 바로 202로 응답한다(회고는 서버의 outbox 소비자가 나중에 수행한다).
- 회고하는 이벤트는 `SessionEnd`다. `Stop`은 응답이 끝날 때마다 실행되고 회고의 멱등 키가 세션 id와 이벤트이므로, `Stop`을 걸어도 세션의 첫 `Stop`만 접수되고 그 뒤 `Stop`은 서버가 중복으로 바로 끝낸다(202, 기록 없음). 따라서 `Stop`은 걸지 않는 것을 권장한다.

### http 훅으로 SessionStart만 쓰기

`anchormind`를 설치하지 않고 주입만 쓰려면 http 훅을 쓴다. 헤더의 키는 `allowedEnvVars`에 적은 환경 변수에서만 채워진다.

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

http 훅의 본문에는 git 원격 주소가 없으므로 workspace 후보는 `cwd`에서만 나온다. http 훅으로 `Stop`이나 `SessionEnd`를 보내면 발췌가 없어 서버가 422(`excerpt_required`)로 응답한다.

## Codex

Codex 훅은 command 처리기만 실행한다(http 처리기 없음). `~/.codex/hooks.json`(또는 저장소의 `.codex/hooks.json`)에 추가한다. `timeout`은 초 단위다.

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

- Codex는 훅 출력이 약 2500 토큰을 넘으면 본문 대신 파일 경로를 넘기므로 서버는 Codex 주입 예산을 1500 토큰으로 둔다(Claude Code는 2000).
- Codex의 `SessionEnd`는 대화를 보관하거나 지울 때, 또는 30분 동안 활동이 없을 때 실행된다. 회고는 이 시점에 일어난다. `Stop`을 추가하면 첫 응답 직후의 짧은 내용만 회고되고 이후 `Stop`은 중복으로 끝나며, 같은 세션의 `SessionEnd` 회고는 별도로 한 번 더 일어난다. 세션 전체를 반영하려면 `SessionEnd`만 건다.
- 하네스의 환경 변수가 셸과 다르면 `MEMENTO_CLI_REMOTE`, `MEMENTO_CLI_KEY`가 Codex 프로세스에 전달되는지 확인한다.

## workspace 결정

서버는 `cwd`와 git 원격 주소에서 후보를 만들고, 키의 `allowed_workspaces` 안에 있는 첫 후보를 workspace로 쓴다. 비교는 대소문자를 무시하고 결과는 `allowed_workspaces`에 저장된 표기다. 맞는 후보가 없거나 키에 `allowed_workspaces`가 없으면 키의 `default_workspace`를 쓴다.

후보 순서: 원격 `host/path`, 원격 저장소 이름, cwd 전체 경로, cwd 마지막 조각.

| 입력 | 후보 |
|-|-|
| 원격 `https://user:token@GitHub.com/Org/Repo.git` | `github.com/org/repo`, `repo` |
| 원격 `git@github.com:Org/Repo.git` | `github.com/org/repo`, `repo` |
| 원격 `ssh://git@git.example.com:2222/Team/Proj.git` | `git.example.com/team/proj`, `proj` |
| cwd `/home/dev/Projects/Repo` | `/home/dev/projects/repo`, `repo` |
| cwd `C:\Users\Dev\Repo` | `c:/users/dev/repo`, `repo` |

예: 키의 `allowed_workspaces`가 `["Repo", "infra"]`이면 위 저장소들에서 workspace는 `Repo`다.

## 동작 확인

```bash
curl -s -X POST "https://memento.example.com/hooks/claude-code/SessionStart" \
  -H "Authorization: Bearer $MEMENTO_CLI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"cwd\":\"$PWD\",\"source\":\"startup\"}"

echo '{"session_id":"check-1","hook_event_name":"SessionEnd","last_assistant_message":"훅 설정을 확인했다"}' \
  | anchormind hook SessionEnd --client claude-code
```

첫 명령은 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`를 돌려준다. `additionalContext`는 `<<<MEMORY CONTEXT>>>`와 `<<<END MEMORY CONTEXT>>>` 사이에 기억을 한 줄씩(줄바꿈과 제어 문자는 이스케이프 표기) 담고, 그 사이 내용이 자료이며 지시가 아니라는 고정 문단을 앞에 둔다. 두 번째 명령은 출력 없이 종료 코드 0으로 끝나고, 잠시 뒤 `recall`로 `session_reflect` 주제의 episode를 확인할 수 있다. 서버 지표 `memento_hook_calls_total{client,event,outcome}`와 `memento_hook_reflect_total{outcome}`로 호출과 회고 결과를 본다.

## 응답 코드

| 상태 | `error` | 원인 |
|-|-|-|
| 200 | | `SessionStart` 주입 |
| 202 | | 회고 접수 |
| 202 | | 같은 세션과 이벤트가 이미 접수되었거나 회고됨(`"duplicate": true`, 기록 없음) |
| 400 | `invalid_json`, `json_too_deep`, `invalid_body`, `invalid_session_id`, `invalid_source`, `event_mismatch`, `invalid_excerpt` | 본문 형식(발췌의 NUL 문자 포함) |
| 401 | `unauthorized` | 키가 없거나 맞지 않음 |
| 403 | `forbidden` | 키에 필요한 권한이 없음 |
| 404 | `not_found` | 경로가 허용 목록 밖이거나 `MEMENTO_HOOK_ENDPOINTS=off` |
| 413 | `payload_too_large`, `excerpt_too_large` | 본문 196608바이트, 발췌 65536바이트 초과 |
| 415 | `unsupported_media_type` | `Content-Type`이 `application/json`이 아님 |
| 422 | `excerpt_required`, `sensitive_content` | 발췌 없음, `MEMENTO_SENSITIVE_SCAN=reject`에서 비밀 검출 |
| 429 | `too_many_requests`, `queue_full` | 키별 요청 한도 또는 인증 실패한 IP의 한도 초과, 키의 대기 회고 이벤트 500건 |
| 431 | `headers_too_large` | 헤더 합계 8192바이트 초과 |
| 500 | `server_error`, `context_failed` | 서버 내부 오류 |
| 503 | `temporarily_unavailable`, `queue_unavailable` | 인증 저장소 장애, outbox 꺼짐 |

훅이 실패해도 하네스 작업은 멈추지 않는다. `anchormind hook`은 실패를 표준 오류에 쓰고 종료 코드 1(비차단)로 끝난다.
