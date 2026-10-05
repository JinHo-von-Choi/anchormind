---
title: "Troubleshooting"
date: 2026-03-13
author: 최진호
updated: 2026-10-03
---

# Troubleshooting

## 1. `psql` 명령을 찾을 수 없음

문제:
`psql: command not found` 또는 Windows에서 명령을 인식하지 못함

원인:
PostgreSQL client가 설치되어 있지 않거나 PATH에 없다.

확인 방법:

```bash
psql --version
```

해결 방법:
- PostgreSQL client를 설치한다.
- Windows는 PostgreSQL `bin` 경로를 PATH에 추가한다.

## 2. `CREATE EXTENSION vector` 실패

문제:
`extension "vector" is not available`

원인:
pgvector가 설치되지 않았거나 PostgreSQL 버전에 맞는 패키지가 없다.

확인 방법:

```sql
\dx
```

해결 방법:
- pgvector 패키지를 설치한다.
- extension 생성 권한이 있는 계정으로 실행한다.

## 3. `npm install` 중 `onnxruntime-node` 실패

문제:
설치 중 GPU 바인딩 또는 native module 단계에서 실패

원인:
CUDA 11 환경 또는 로컬 바이너리 호환성 문제

확인 방법:
- 설치 로그에 `onnxruntime-node`가 포함되는지 확인

해결 방법:

```bash
npm install --onnxruntime-node-install-cuda=skip
```

## 4. 포트 57332 충돌

문제:
서버 시작 시 포트 사용 중 오류

원인:
이미 다른 프로세스가 같은 포트를 사용 중이다.

확인 방법:

```bash
lsof -i :57332
```

Windows:

```powershell
netstat -ano | findstr 57332
```

해결 방법:
- 기존 프로세스를 종료한다.
- 또는 `.env`에서 `PORT`를 다른 값으로 바꾼다.

## 5. `401 Unauthorized`

문제:
`/mcp` 호출 시 인증 실패

원인:
`MEMENTO_ACCESS_KEY`와 요청 헤더의 Bearer 토큰이 일치하지 않는다.

확인 방법:
- `.env`의 `MEMENTO_ACCESS_KEY`
- 요청 헤더의 `Authorization: Bearer ...`

해결 방법:
- access key를 다시 맞춘다.
- 개발이나 시험에서 인증 없이 쓰려면 `.env`에 `MEMENTO_AUTH_DISABLED=true`를 명시한다. `MEMENTO_ACCESS_KEY`를 비워 두기만 하면 서버가 기동하지 않는다(문제 12 참조).

## 6. Windows quoting 문제

문제:
JSON-RPC 호출 시 작은따옴표, 큰따옴표, escape 처리 때문에 요청이 깨진다.

원인:
PowerShell과 Bash의 quoting 규칙이 다르다.

확인 방법:
- Bash 예시를 그대로 PowerShell에 붙였는지 확인

해결 방법:
- PowerShell에서는 `Invoke-RestMethod`와 `ConvertTo-Json`을 사용한다.
- Bash 예시는 WSL 또는 Git Bash에서만 그대로 사용한다.

## 7. Redis를 켜지 않았는데 괜찮은가

문제:
Redis 없이 서버를 실행해도 되는지 불명확함

원인:
문서에 선택 구성과 필수 구성이 혼재되어 있다.

확인 방법:
- `.env`에서 `REDIS_ENABLED=false`

해결 방법:
- 온보딩 단계에서는 Redis 없이 시작해도 된다.
- 다만 L1 인덱스, 캐시, 일부 비동기 큐 기반 성능 경로는 축소될 수 있다.

## 8. `DATABASE_URL`은 맞는데 접속이 안 됨

문제:
PostgreSQL 연결 실패

원인:
비밀번호 인코딩 문제, 호스트 오류, 방화벽, 사용자 권한 부족

확인 방법:

```bash
psql "$DATABASE_URL" -c "SELECT 1;"
```

해결 방법:
- 비밀번호에 특수문자가 있으면 URL 인코딩이 필요한지 확인한다.
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`가 실제 값과 일치하는지 점검한다.

## 9. `ReferenceError: Cannot access 'fragment' before initialization`

문제:
`remember`를 호출하면 이 오류가 난다.

원인:
v2.10.0 이하에서 `remember()` 본문의 atomic 분기가 `fragment` 변수 선언보다 앞에 위치하는 TDZ 버그.

해결 방법:
v2.10.1 이상으로 업그레이드한다. R12 핫픽스에서 해당 TDZ가 제거됐다.

```bash
npm install anchormind-mcp@latest
# 또는 소스 설치 시
git pull
npm install
```

## 10. migration-034-v2.16.0-bundle의 인덱스 생성이 대형 테이블에서 오래 걸림

문제:
`npm run migrate`가 migration-034-v2.16.0-bundle 단계에서 `fragments` 테이블을 오래 잠근다.

원인:
마이그레이션은 트랜잭션 안에서 실행되므로 `CREATE UNIQUE INDEX`를 일반 형태로 만든다. `CREATE INDEX CONCURRENTLY`는 트랜잭션 블록 안에서 실행할 수 없다.

해결 방법:
`npm run migrate` 전에 아래 두 문을 `psql`에서 트랜잭션 없이 직접 실행한다. 마이그레이션은 `IF NOT EXISTS`로 같은 이름의 인덱스를 건너뛴다.

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_tenant
  ON agent_memory.fragments (key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_master
  ON agent_memory.fragments (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NULL;
```

주의: `BEGIN;` 블록 안에서 실행하면 오류가 난다. 적용 이력은 `agent_memory.schema_migrations`(`filename` 열)에 기록되며 이 문을 실행해도 이력은 바뀌지 않는다.

## 11. 버전 마이그레이션 참고: `_searchEventId` 필드를 찾을 수 없음

구버전 클라이언트에서 발생할 수 있는 호환성 항목.

응답 메타데이터는 `_meta.searchEventId` / `_meta.hints` / `_meta.suggestion`에서만 읽는다. top-level mirror 필드는 v3.1.0에서 제거됐으므로 `response._meta.searchEventId` 경로로 클라이언트 코드를 전환한다.

## 12. 서버가 기동하지 않고 종료 코드 78로 끝남

문제:
`node server.js`가 `[Startup] MEMENTO_ACCESS_KEY가 설정되지 않았습니다.`를 출력하고 종료한다.

원인:
`MEMENTO_ACCESS_KEY`가 비어 있고 `MEMENTO_AUTH_DISABLED=true`도 없다. 키 없이 뜨는 서버는 모든 도구를 무인증으로 열기 때문에 기동을 거부한다. `MEMENTO_CONFIG_STRICT=true`일 때 숫자, 열거, 불리언 환경 변수에 값 문제가 있어도 같은 코드로 종료한다.

해결 방법:
- `.env`에 `MEMENTO_ACCESS_KEY`를 채운다.
- 개발이나 시험에서만 `MEMENTO_AUTH_DISABLED=true`를 명시한다.
- `MEMENTO_CONFIG_STRICT` 때문이면 기동 로그의 `[Startup] 환경 변수 값 ... 기대와 다르다` 줄에서 이름을 확인해 값을 고친다.

## 13. `404 Session not found`

문제:
이미 연결해 둔 클라이언트의 호출이 `Session not found`(JSON-RPC `-32000`)로 끝난다.

원인:
- API 키가 비활성화 또는 삭제됐다. API 키 세션은 `MEMENTO_SESSION_KEY_RECHECK_MS`(기본 30000ms) 주기로 키 상태를 다시 읽으며, 비활성 또는 삭제된 키의 세션은 닫힌다.
- 세션이 만료됐거나 서버가 세션을 복구하지 못했다.
- `MEMENTO_SESSION_ID_POLICY=enforce`에서 UUID 형식이 아닌 세션 ID로 복구를 시도했다.

해결 방법:
- 관리 콘솔에서 키 상태를 확인한다.
- 클라이언트가 `initialize`부터 다시 연결하도록 한다. 세션 ID는 `MCP-Session-Id` 헤더로 보낸다.

## 14. `/health/ready`가 503

문제:
`/health/ready`가 `{"status":"not_ready","reason":"db_timeout"}` 또는 `db_error`로 503을 돌려준다.

원인:
주 DB가 `MEMENTO_HEALTH_READY_DB_TIMEOUT_MS`(기본 2000) 안에 응답하지 않거나 연결에 실패했다.

확인 방법:

```bash
psql "$DATABASE_URL" -c "SELECT 1;"
curl -s http://localhost:57332/health/live
```

해결 방법:
- DB 연결 설정과 DB 부하를 점검한다. `/health/live`는 DB와 무관하게 200이므로 프로세스 재시작 판정에는 `/health/live`만 쓴다.

## 15. 관리자 계정 로그인이나 TOTP 등록이 503 `totp_seal_key_missing`

문제:
owner, admin 역할 계정의 로그인 또는 TOTP 등록이 503 `totp_seal_key_missing`으로 끝난다.

원인:
TOTP 비밀을 봉인하는 `MEMENTO_ADMIN_SEAL_KEY`가 없거나 형식이 틀렸다(32바이트, base64 또는 64자 hex). 형식이 틀린 값은 기동 시 설정 문제 목록에 오르고 미설정으로 동작한다.

확인 방법:

```bash
openssl rand -hex 32   # 새 봉인 키 예시. 출력값을 서버 환경 변수에 설정한다
```

해결 방법:
- 서버 환경 변수에 `MEMENTO_ADMIN_SEAL_KEY`를 설정하고 재시작한다. 마스터 키 로그인은 이 값과 무관하게 동작한다.
- TOTP를 잃은 계정은 서버 호스트에서 `anchormind admin recover --confirm`으로 초기화한 뒤 다시 등록한다([cli.md](../cli.md)).

## 16. `recall`이 본문 단어로 찾지 못함(어휘 채널 미참여)

문제:
임베딩이 꺼져 있거나 키워드가 없는 질의에서 `text`의 본문 단어로 파편을 찾지 못한다.

원인:
본문 어휘 채널은 `fragments.content_tokens`의 GIN 색인(`idx_fragments_content_tokens`)이 유효할 때만 참여한다. 색인을 만들지 않았거나 만드는 중이거나 `MEMENTO_LEXICAL_CHANNEL=off`다. 기존 행의 `content_tokens`가 비어 있으면 그 행은 이 채널에서 빠진다.

확인 방법:

```bash
curl -s -H "Authorization: Bearer $MEMENTO_ACCESS_KEY" http://localhost:57332/metrics | grep memento_lexical
```

해결 방법:
- `scripts/ops/online-index.mjs --index idx_fragments_content_tokens`로 색인을 만들고 `scripts/backfill-content-tokens.mjs --confirm`으로 기존 행을 채운다([online-migration.md](../operations/online-migration.md#본문-어휘-채널)).
- `memento_lexical_tokens_coverage_ratio`가 1이면 채움이 끝난 것이다.

## 17. `remember`한 파편이 `recall`에 보이지 않거나 `pending_review`로 나옴

문제:
저장한 파편이 다른 키의 `recall`이나 `context`에 보이지 않고, 쓴 키의 `recall`에는 `pending_review: true`로 나온다.

원인:
에이전트 지시를 덮어쓰는 문구, 신뢰 등급 1 이하의 앵커나 preference나 procedure, `anchor` 권한이 없는 앵커 요청은 거부하지 않고 검토 대기로 저장된다(`MEMENTO_REVIEW_QUEUE=on`). 검토 대기 파편은 승인 전까지 다른 키와 context 주입에 나타나지 않는다.

해결 방법:
- 관리 API `GET /v1/internal/model/nothing/review`로 대기 목록을 보고 `POST .../review/:id/approve` 또는 `.../reject`로 결정한다. 30일 동안 결정이 없으면 자동 거절된다.
- 앵커를 쓰는 키에는 `scripts/grant-anchor-permission.js --apply`로 `anchor` 권한을 준다. 사용자가 직접 말한 내용을 신뢰 등급 3으로 저장하려면 키에 `trusted_origin` 권한을 주고 `origin: "user_stated"`를 보낸다.
