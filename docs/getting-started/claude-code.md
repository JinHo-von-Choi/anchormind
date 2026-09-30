---
title: "Claude Code Configuration"
date: 2026-03-13
author: 최진호
updated: 2026-04-20
---

# Claude Code Configuration

이 문서는 Claude Code에서 Memento MCP를 HTTP 기반 MCP 서버로 등록하는 방법을 설명한다.

- memento 서버만 직접 실행할 경우: 이 설정은 필요 없다.
- Claude Code가 `remember`, `recall`, `context` 같은 도구를 직접 쓰게 하려면: MCP 서버 등록이 필요하다.

## 핵심 주의사항

HTTP 타입 MCP 서버는 `~/.claude/settings.json`의 `mcpServers` 블록에 수동 기재하면 **Claude Code가 인식하지 못한다**. `settings.json`은 일반 Claude Code 설정용이며 MCP 서버 등록 경로가 아니다. 반드시 아래 세 가지 공식 등록 방법 중 하나를 사용한다.

- 방법 A(권장): `claude mcp add` CLI → `~/.claude.json`에 사용자/로컬 스코프로 저장
- 방법 B: 저장소 루트의 `.mcp.json` → 프로젝트 단위 공유
- stdio 타입과 HTTP 타입은 동일한 방법으로 등록한다. HTTP만 특별히 다른 경로를 쓰지 않는다.

## 방법 A: `claude mcp add` CLI (권장)

```bash
claude mcp add memento http://localhost:57332/mcp \
  --transport http \
  --scope user \
  --header "Authorization: Bearer YOUR_MEMENTO_ACCESS_KEY"
```

옵션 설명:
- `--transport http` — Streamable HTTP 전송 명시 (필수, 기본값은 stdio)
- `--scope user` — 사용자 전역 범위. 모든 프로젝트에서 동일 memento 사용 시 사용. `local`은 현재 디렉터리 한정, `project`는 `.mcp.json` 저장
- `--header` — 요청 헤더 전달. access key 노출이 우려되면 환경 변수로 주입한다

등록 후 확인:

```bash
claude mcp list
# memento: http://localhost:57332/mcp (HTTP) - ✓ Connected

claude mcp get memento
```

`claude mcp list`에 `memento`가 보이고 `Connected` 상태면 정상. 이후 Claude Code 세션을 재시작하면 16개 MCP 도구가 로드된다.

등록 제거:

```bash
claude mcp remove memento --scope user
```

## 방법 B: `.mcp.json` 프로젝트 단위

저장소 루트에 `.mcp.json`을 생성하면 해당 프로젝트에서 작업하는 팀원 전원이 동일 MCP 구성을 공유한다.

```json
{
  "mcpServers": {
    "memento": {
      "type": "http",
      "url": "http://localhost:57332/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MEMENTO_ACCESS_KEY"
      }
    }
  }
}
```

access key를 커밋하지 않도록 `.gitignore`에 추가하거나 환경 변수 치환을 사용한다.

## 스코프 선택 가이드

| 상황 | 권장 스코프 | 비고 |
|------|------------|------|
| 개인 기기 전역 | `--scope user` | `~/.claude.json`에 저장 |
| 특정 프로젝트 팀 공유 | `.mcp.json` | 저장소에 커밋 |
| 현재 디렉터리 한정 테스트 | `--scope local` | 다른 프로젝트에 영향 없음 |

## 세션 시작 시 context 자동 로드

자동 로드는 선택 사항이다. 세션 시작마다 핵심 기억을 불러오고 싶을 때만 사용한다.

### curl 기반 예시

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:57332/mcp -H 'Authorization: Bearer YOUR_KEY' -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"context\",\"arguments\":{}}}'"
          }
        ]
      }
    ]
  }
}
```

`mcp-session-id` 헤더는 생략 가능하다. 서버가 세션 ID를 자동으로 생성하여 응답 헤더에 반환한다. 특정 세션을 지정해야 하는 경우에만 직접 전달한다.

### Windows PowerShell 요청 예시

아래 예시는 설정 파일 JSON이 아니라 PowerShell에서 직접 동작을 확인할 때 쓰는 예시다.

```powershell
$headers = @{
  Authorization   = "Bearer $env:MEMENTO_ACCESS_KEY"
  "Content-Type"  = "application/json"
  "mcp-session-id" = "test-session"
}

$body = @{
  jsonrpc = "2.0"
  id      = 1
  method  = "tools/call"
  params  = @{
    name      = "context"
    arguments = @{}
  }
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Method Post -Uri "http://localhost:57332/mcp" -Headers $headers -Body $body
```

## 트러블슈팅

**`claude mcp list`에 memento가 보이지 않는다**
- `settings.json`의 `mcpServers` 블록에 기재한 것은 아닌지 확인. 그 경로는 인식되지 않는다. 방법 A 또는 B를 사용한다.
- `~/.claude.json`을 직접 열어 `mcpServers.memento` 항목이 실제 저장됐는지 확인한다.

**`Connected` 대신 에러가 표시된다**
- memento 서버가 실제 실행 중인지 확인: `curl http://localhost:57332/health` → `{"status":"healthy"}` 기대
- access key가 유효한지 확인 (Admin UI에서 재발급 또는 상태 확인)
- 방화벽·포트포워딩 점검

**systemd + nvm 환경에서 서버가 크래시 루프**
- `ExecStart=node server.js`는 nvm 환경이 로드되지 않아 실패한다.
- `start.sh` 래퍼로 nvm Node.js 경로를 명시하고 `.env`를 수동 로드한다:
  ```bash
  #!/bin/bash
  cd /path/to/memento-mcp
  export $(grep -v '^#' .env | grep '=' | xargs)
  exec /home/USER/.nvm/versions/node/vXX.XX.X/bin/node server.js
  ```

## _meta 응답 구조

`recall` 및 `context` 응답은 `_meta` 래퍼에 부가 정보를 담는다.

```json
{
  "_meta": {
    "searchEventId": "evt-abc123",
    "hints": ["embedding provider is openai"],
    "suggestion": "try adding contextText for better results"
  },
  "fragments": [...]
}
```

`_meta.searchEventId` / `_meta.hints` / `_meta.suggestion` 경로만 사용한다.

> 버전 마이그레이션 참고: top-level mirror 필드(`_searchEventId` 등)는 v3.1.0에서 제거됐다. 구버전 클라이언트는 `_meta` 내부 필드로 전환한다.

## dryRun 사전 시뮬레이션 (v2.12.0 M5)

`remember`, `link`, `forget`, `amend` 도구에서 `dryRun: true`를 설정하면 실제 저장 없이 실행 결과를 미리 확인할 수 있다.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "remember",
    "arguments": {
      "topic": "infra",
      "type": "fact",
      "content": "nginx 포트 443 정상 응답 확인",
      "dryRun": true
    }
  }
}
```

응답에 `dryRun: true`와 예상 저장 결과가 포함된다. 실제 DB 변경은 발생하지 않는다.

## 권장 사항

- access key는 가능한 환경 변수나 안전한 비밀 저장소로 관리한다
- 서버 설치와 Claude Code 연동은 별도 단계로 이해한다
- 세션 자동화 전에 먼저 수동 `context` 호출이 정상 동작하는지 확인한다
- recall 응답에서 `_searchEventId`를 직접 참조하던 코드는 `_meta.searchEventId`로 전환한다
