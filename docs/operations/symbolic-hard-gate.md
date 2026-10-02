# symbolic-hard-gate 운영 가이드

작성자: 최진호
작성일: 2026-04-16

## 개요

특정 API 키에서 PolicyRules violations 발생 시 `remember()` 저장을 거부한다. 기본 비활성(false). 키 단위 opt-in 방식으로 동작하며, 마스터 키(keyId=NULL)는 항상 제외된다.

## 활성화

```sql
UPDATE agent_memory.api_keys
SET    symbolic_hard_gate = true
WHERE  id = '<key_uuid>';
```

캐시 갱신: `ApiKeyStore` 30초 TTL이 만료되면 자동 반영. 즉시 적용이 필요하면 `invalidateHardGateCache(keyId)` 호출 또는 서버 재시작.

## 비활성화

```sql
UPDATE agent_memory.api_keys
SET    symbolic_hard_gate = false
WHERE  id = '<key_uuid>';
```

## 동작 확인

저품질 `decision` 파편 저장을 시도하면 `-32003` 에러가 반환된다.

```bash
curl -X POST http://localhost:57332/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <api_key>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"remember","arguments":{"content":"do this","type":"decision","topic":"test"}}}'
```

기대 응답 구조 (hard gate 활성화 + PolicyRules 위반 시):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
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

`data.violations` 배열에 위반된 rule 이름이 포함되므로 클라이언트가 구체적인 수정 방향을 파악할 수 있다.

## 모니터링

```
rate(memento_symbolic_gate_blocked_total{phase="policy"}[5m])
```

Prometheus에서 hard gate 차단 발생 빈도를 추적한다.

`/metrics` 엔드포인트는 master key 인증을 요구한다. Prometheus scrape config에 `Authorization: Bearer <MEMENTO_ACCESS_KEY>` 헤더를 포함시킬 것.

```bash
# 수동 확인
curl -H "Authorization: Bearer <MEMENTO_ACCESS_KEY>" http://localhost:57332/metrics | grep memento_symbolic
```

## 마스터 키 예외

`MEMENTO_ACCESS_KEY`로 인증된 요청(keyId=null)은 대상에서 제외된다. `api_keys` 행이 없기 때문이다. 마스터 키 레벨 hard gate 적용은 `MEMENTO_SYMBOLIC_HARD_GATE_MASTER` 환경변수 지원이 필요하며 향후 과제로 보류됐다.

## 조회 실패 시 동작

`ApiKeyStore.getSymbolicHardGate()` 조회가 실패하면 예외를 그대로 올리고, 해당 remember에 정책 위반이 있으면 `hardGateLookupFailed` 규칙과 함께 `-32003`으로 저장을 거부한다(fail-closed). 위반이 없는 저장은 조회 자체를 하지 않으므로 영향이 없다.

## 캐시 무효화

캐시 TTL은 30초다. 긴급하게 즉시 반영이 필요한 경우 `invalidateHardGateCache(keyId)` 함수를 호출하거나 서버를 재시작한다. 현재 admin 엔드포인트는 제공되지 않으므로 SQL UPDATE 후 최대 30초 대기 또는 재시작이 즉시 반영 경로다.
