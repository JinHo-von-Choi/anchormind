---
title: "Windows PowerShell Setup"
date: 2026-03-13
author: 최진호
updated: 2026-04-20
---

# Windows PowerShell Setup

이 문서는 Bash 없이 순수 PowerShell로 설치하는 제한 지원 경로다.

- 권장하지 않음: `bash setup.sh`
- 지원 범위: 수동 `.env` 생성, `npm install`, `psql`, `node server.js`
- 주의: quoting, 경로, PostgreSQL/pgvector 설치 차이로 WSL2보다 실패 확률이 높다

## 1. 전제 조건

- Node.js 20+
- PostgreSQL + `vector` extension
- `psql` 명령이 PATH에 있어야 함

## 2. 환경 파일 생성

```powershell
Copy-Item .env.example.minimal .env
```

`.env`를 열어 값을 수정한다. 로그 디렉터리는 Windows 경로로 맞춘다.

예시:

```env
PORT=57332
SESSION_TTL_MINUTES=60
LOG_DIR=./logs
MEMENTO_ACCESS_KEY=change-me

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=memento
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgresql://postgres:change-me@localhost:5432/memento

REDIS_ENABLED=false
CACHE_ENABLED=false
```

## 3. 의존성 설치

```powershell
npm install
```

CUDA 11 환경에서 설치 오류가 나면:

```powershell
npm install --onnxruntime-node-install-cuda=skip
```

## 4. schema 적용

`vector` extension을 먼저 만든다.

```powershell
psql -d "postgresql://postgres:change-me@localhost:5432/memento" -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

그 다음 schema를 적용한다.

```powershell
psql -d "postgresql://postgres:change-me@localhost:5432/memento" -f lib/memory/memory-schema.sql
```

## 5. 서버 실행

```powershell
node server.js
```

## 6. 헬스 체크

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:57332/health"
```

## 7. JSON-RPC 호출 예시

```powershell
$headers = @{
  Authorization = "Bearer change-me"
  "Content-Type" = "application/json"
}

$body = @{
  jsonrpc = "2.0"
  id      = 1
  method  = "tools/call"
  params  = @{
    name      = "remember"
    arguments = @{
      topic   = "onboarding"
      type    = "fact"
      content = "Windows PowerShell 경로에서 remember 호출을 테스트했다."
    }
  }
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Method Post -Uri "http://localhost:57332/mcp" -Headers $headers -Body $body
```

## 8. 환경 변수 문법 참고

PowerShell에서 일회성 환경 변수는 아래와 같이 설정한다.

```powershell
$env:DATABASE_URL = "postgresql://postgres:change-me@localhost:5432/memento"
node server.js
```

반복 사용 환경이라면 WSL2로 전환하는 것이 낫다.

## 9. CLI 원격 접속 환경변수 설정 (v2.12.0 M1)

PowerShell에서 CLI 원격 접속 환경변수를 설정할 때 따옴표에 주의한다. `$env:` 접두어를 사용하며, 값에 `$` 문자가 포함되면 큰따옴표 내부에서 해석될 수 있으므로 작은따옴표로 감싼다.

```powershell
# 환경변수 설정 (세션 내 유효)
$env:MEMENTO_CLI_REMOTE = "https://memento.anchormind.net/mcp"
$env:MEMENTO_CLI_KEY = "mmcp_xxx"

# 설정 후 CLI 사용
node bin/memento.js stats
node bin/memento.js recall "검색어"

# 일회성 실행 (환경변수 없이 직접 지정)
node bin/memento.js stats --remote "https://memento.anchormind.net/mcp" --key "mmcp_xxx"
```

주의: PowerShell에서 `--key $env:MEMENTO_CLI_KEY` 형태로 전달할 때, 값에 특수문자가 있으면 따옴표로 감싸야 한다.

## 재부팅 후 자동 복구

Docker 기반으로 상시 운영하는 경우, restart 정책과 Windows 로그인 시 복구 패턴은
[Production Docker](../operations/production-docker.md)를 따른다. 요지: Docker Desktop의
"Start when you sign in" 활성화 + compose `restart: unless-stopped` 조합으로 대부분 해결되고,
`/health` 게이트를 쓸 때는 HTTP 200이 아니라 응답의 `status === "healthy"`를 확인해야 한다.
