---
title: "Quick Start"
date: 2026-03-13
author: 최진호
updated: 2026-10-03
---

# Quick Start

이 문서는 최소 구성으로 Memento MCP를 실행하는 경로다. 기준은 다음과 같다.

- 필수: Node.js 20+, PostgreSQL, `vector` extension
- 선택: Redis
- 선택: 임베딩 provider
- 선택: Claude Code 연동

Redis, 임베딩 provider, NLI 외부 서비스가 없어도 기본 서버 기동과 핵심 도구 호출은 가능하다.

## 1. 의존성 준비

```bash
node --version
psql --version
```

Node.js는 20 이상을 권장한다. PostgreSQL에는 `pgvector` extension이 설치되어 있어야 한다.

## 2. 최소 환경 파일 생성

```bash
cp .env.example.minimal .env
```

`.env`에서 최소한 아래 값을 채운다.

```env
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=memento
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgresql://postgres:change-me@localhost:5432/memento
MEMENTO_ACCESS_KEY=change-me
```

> `MEMENTO_ACCESS_KEY`는 필수다. 설정하지 않으면 서버가 종료 코드 78로 기동을 멈춘다. 개발/테스트 환경에서 인증을 비활성화하려면 `.env`에 `MEMENTO_AUTH_DISABLED=true`를 추가한다.

## 3. 의존성 설치

```bash
npm install
```

CUDA 11 환경에서 `onnxruntime-node` 설치 오류가 발생하면 아래 명령을 사용한다.

```bash
npm install --onnxruntime-node-install-cuda=skip
```

## 4. 환경 변수 로드

`.env` 파일의 값을 현재 셸에 반영한다.

```bash
export $(grep -v '^#' .env | grep '=' | xargs)
```

PowerShell 환경이라면 [Windows PowerShell Setup](windows-powershell.md)의 환경 변수 문법을 참조한다.

## 5. PostgreSQL schema 적용

먼저 `vector` extension을 확인한다.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

그 다음 마이그레이션을 실행한다.

```bash
npm run migrate
```

수동으로 개별 마이그레이션을 실행하려면 [INSTALL.md](../INSTALL.md)를 참조한다.

## 6. 서버 실행

```bash
node server.js
```

정상 기동 시 다음과 비슷한 로그가 보인다.

```text
Memento MCP HTTP server listening on port 57332
Streamable HTTP endpoints: POST/GET/DELETE /mcp
Authentication: ENABLED
```

## 7. 헬스 체크

```bash
curl -s http://localhost:57332/health
```

정상 응답 예시:

```json
{
  "status": "healthy",
  "timestamp": "2026-10-03T00:00:00.000Z"
}
```

`/health/live`는 프로세스 생존만 확인하며 항상 200이다. `/health/ready`는 주 DB가 응답하면 200, 아니면 503(`db_timeout` 또는 `db_error`)이다.

## 8. 세션 초기화

`tools/call`은 세션이 필요하다. 먼저 `initialize`를 호출해 응답 헤더의 `MCP-Session-Id`를 받는다. 세션 없이 `tools/call`을 보내면 서버가 HTTP 400(`Session required`)으로 응답한다.

```bash
SID=$(curl -s -D - -o /dev/null -X POST http://localhost:57332/mcp \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"quickstart","version":"1"}}}' \
  | awk 'tolower($1)=="mcp-session-id:"{print $2}' | tr -d '\r')
echo "$SID"
```

## 9. 첫 remember 호출

```bash
curl -s -X POST http://localhost:57332/mcp \
  -H "Authorization: Bearer change-me" \
  -H "MCP-Session-Id: $SID" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "remember",
      "arguments": {
        "topic": "onboarding",
        "type": "fact",
        "content": "Quick Start로 서버 기동 확인을 완료했다."
      }
    }
  }'
```

## 10. 첫 recall 호출

```bash
curl -s -X POST http://localhost:57332/mcp \
  -H "Authorization: Bearer change-me" \
  -H "MCP-Session-Id: $SID" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "recall",
      "arguments": {
        "topic": "onboarding"
      }
    }
  }'
```

다음 단계는 [First Memory Flow](first-memory-flow.md) 문서를 따라 `context`, `remember`, `recall` 사용 흐름을 검증하는 것이다.

## 11. CLI 기본 사용법

서버 없이 터미널에서 직접 조회·저장할 수 있다.

```bash
# 서브명령별 도움말
node bin/memento.js recall --help
node bin/memento.js remember --help

# TTY에서는 table 포맷이 기본
node bin/memento.js stats

# JSON 포맷 명시
node bin/memento.js stats --format json

# idempotencyKey로 중복 저장 방지
node bin/memento.js remember "Quick Start 완료" --topic onboarding --type fact \
  --idempotency-key "quickstart-done-2026-04-20"

# 원격 서버 조회
node bin/memento.js recall "onboarding" \
  --remote https://memento.anchormind.net/mcp \
  --key mmcp_xxx

# 환경변수로 원격 설정
export MEMENTO_CLI_REMOTE=https://memento.anchormind.net/mcp
export MEMENTO_CLI_KEY=mmcp_xxx
node bin/memento.js stats
```

상세 CLI 사용법: [docs/cli.md](../cli.md)

Symbolic Memory 활성화 방법은 [docs/configuration.md](../configuration.md) 및 [CHANGELOG.md](../../CHANGELOG.md)를 참조한다.
