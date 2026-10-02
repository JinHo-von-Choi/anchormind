---
title: "Troubleshooting"
date: 2026-03-13
author: 최진호
updated: 2026-04-20
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
- 인증을 비활성화하려면 `.env`에서 `MEMENTO_ACCESS_KEY`를 비워 둔다.

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
`remember` 호출 시 TDZ(Temporal Dead Zone) 에러 발생. 원격 서버(`memento.anchormind.net`)에서도 동일 증상이 보고됐다.

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

## 10. migration-034-v2.16.0-bundle 적용 실패 (CONCURRENTLY 에러)

문제:
`npm run migrate` 실행 시 migration-034-v2.16.0-bundle 단계에서 에러 발생.

원인:
`CREATE INDEX CONCURRENTLY`는 트랜잭션 블록 안에서 실행할 수 없다. 마이그레이션 스크립트가 트랜잭션을 사용하는 환경에서 CONCURRENTLY 구문이 실패한다.

해결 방법:
트랜잭션 외부에서 수동으로 인덱스를 생성한 뒤 migration-034-v2.16.0-bundle을 완료로 표시한다.

```sql
-- 반드시 BEGIN/COMMIT 없이 독립 실행
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_key_tenant
  ON agent_memory.fragments (key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_fragments_idempotency_key_master
  ON agent_memory.fragments (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NULL;

-- 완료 표시
INSERT INTO agent_memory.schema_migrations (version) VALUES ('036')
  ON CONFLICT DO NOTHING;
```

주의: 위 명령은 `psql`에서 직접 실행하거나 트랜잭션 없이 실행해야 한다. `BEGIN;` 블록 안에서 실행하면 오류가 반복된다.

## 11. 버전 마이그레이션 참고: `_searchEventId` 필드를 찾을 수 없음

구버전 클라이언트에서 발생할 수 있는 호환성 항목.

응답 메타데이터는 `_meta.searchEventId` / `_meta.hints` / `_meta.suggestion`에서만 읽는다. top-level mirror 필드는 v3.1.0에서 제거됐으므로 `response._meta.searchEventId` 경로로 클라이언트 코드를 전환한다.
