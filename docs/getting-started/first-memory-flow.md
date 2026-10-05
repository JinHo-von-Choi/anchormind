---
title: "First Memory Flow"
date: 2026-03-13
author: 최진호
updated: 2026-10-03
---

# First Memory Flow

이 문서는 설치 직후 AnchorMind가 실제로 기억을 저장하고 불러오는지 검증하는 절차다.

## 목표

1. `initialize`로 세션 발급
2. `remember` 호출 성공
3. `recall` 호출 성공
4. `context` 호출 성공

## 1. 세션 초기화

`tools/call`은 세션이 필요하다. `initialize` 응답 헤더의 `MCP-Session-Id`를 받아 이후 요청에 같은 헤더로 보낸다. 세션 없이 `tools/call`을 보내면 서버가 HTTP 400(`Session required`)으로 응답한다.

```bash
SID=$(curl -s -D - -o /dev/null -X POST http://localhost:57332/mcp \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"first-flow","version":"1"}}}' \
  | awk 'tolower($1)=="mcp-session-id:"{print $2}' | tr -d '\r')
echo "$SID"
```

## 2. remember

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
        "topic": "first-run",
        "type": "fact",
        "content": "첫 remember 테스트를 성공적으로 수행했다."
      }
    }
  }'
```

올바른 입력 특징:
- `topic`, `type`, `content`가 모두 있음
- `content`는 1~3문장 수준의 원자적 사실

자주 틀리는 입력:
- 너무 긴 세션 전체 요약을 한 번에 넣는 경우
- `type`에 지원되지 않는 문자열을 넣는 경우

## 3. recall

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
        "topic": "first-run"
      }
    }
  }'
```

기대 결과:
- 조금 전에 저장한 파편이 결과에 포함된다.

### sparse fields로 필요한 필드만 조회

`fields` 파라미터를 지정하면 응답 크기를 줄이고 필요한 필드만 받을 수 있다.

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
        "topic": "first-run",
        "fields": ["id", "content", "importance"]
      }
    }
  }'
```

`fields`에 지정하지 않은 필드는 응답에서 생략된다. 검색 내부 처리(L1/L2/RRF)는 전체 필드를 유지하며, 최종 응답 직전에 pick 처리된다.

## 4. context

```bash
curl -s -X POST http://localhost:57332/mcp \
  -H "Authorization: Bearer change-me" \
  -H "MCP-Session-Id: $SID" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "context",
      "arguments": {}
    }
  }'
```

`context`는 세션 시작 시 핵심 기억을 묶어서 불러오는 도구다. `remember`와 `recall`이 개별 파편 저장/조회라면, `context`는 세션 부팅용 요약 주입에 가깝다.

## 5. 다음 단계

- Claude Code와 연결하려면 [Claude Code Configuration](claude-code.md)
- Windows 환경이라면 [Windows WSL2 Setup](windows-wsl2.md) 또는 [Windows PowerShell Setup](windows-powershell.md)
- 오류가 나면 [Troubleshooting](troubleshooting.md)
- Symbolic Memory 활성화 방법은 [docs/configuration.md](../configuration.md) 및 [CHANGELOG.md](../../CHANGELOG.md)를 참조한다.
