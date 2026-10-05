---
title: "Quick Start"
date: 2026-03-13
author: 최진호
updated: 2026-10-05
---

# Quick Start

이 문서를 끝까지 따라 하면 다음 상태가 된다.

- AnchorMind 서버가 내 컴퓨터에서 돌고 있다.
- AI 에이전트(Claude Code 등)가 서버에 연결되어 있다.
- 기억을 하나 저장하고 다시 꺼내 봤다.

걸리는 시간은 10분 안팎이다. 모델을 내려받는 첫 기동만 조금 더 걸린다.

## 0. 필요한 것

| 필요한 것 | 확인 |
|-----------|------|
| Node.js 20 이상 | `node --version` |
| git | `git --version` |
| Docker | `docker --version` (PostgreSQL을 직접 설치했다면 필요 없다) |

PostgreSQL은 pgvector 확장이 설치된 것이어야 한다. 아래 1번에서 Docker로 준비한다.

## 1. 데이터베이스 준비

기억은 PostgreSQL에 저장된다. pgvector가 들어 있는 이미지를 쓰면 확장을 따로 설치하지 않아도 된다.

```bash
docker run -d --name anchormind-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=change-me -e POSTGRES_DB=memento \
  -v anchormind-pgdata:/var/lib/postgresql/data pgvector/pgvector:pg15

docker exec anchormind-db psql -U postgres -d memento \
  -c "CREATE EXTENSION IF NOT EXISTS vector"
```

`CREATE EXTENSION`이 출력되면 성공이다.

이미 쓰는 PostgreSQL이 있다면 데이터베이스를 만들고 같은 `CREATE EXTENSION`을 슈퍼유저로 실행한다. 확장 생성은 서버가 대신 해 주지 않는다.

## 2. 코드 받기

```bash
git clone https://github.com/JinHo-von-Choi/anchormind.git
cd anchormind
npm install
```

CUDA 11이 깔린 컴퓨터에서 `onnxruntime-node` 설치 오류가 나면 다음 명령으로 다시 설치한다.

```bash
npm install --onnxruntime-node-install-cuda=skip
```

## 3. 설정 파일 만들기

```bash
cp .env.example.minimal .env
```

`.env`를 열어 두 가지를 한다.

**첫째, `MEMENTO_ACCESS_KEY`를 바꾼다.** 서버에 접속할 때 쓰는 마스터 키이며 `Authorization: Bearer` 토큰이 된다. 값이 비어 있으면 서버가 종료 코드 78로 기동하지 않는다. `openssl rand -hex 24`로 만든 값을 쓰면 된다.

**둘째, 아래 세 줄을 파일 끝에 추가한다.** 외부 API 키 없이 자연어 검색을 쓰기 위한 로컬 임베딩 설정이다.

```
EMBEDDING_PROVIDER=transformers
EMBEDDING_MODEL=Xenova/multilingual-e5-small
EMBEDDING_DIMENSIONS=384
```

데이터베이스 항목(`POSTGRES_*`, `DATABASE_URL`)은 1번의 `docker run` 값과 이미 같다. 1번에서 값을 바꿨다면 여기서도 같게 맞춘다.

> 임베딩을 켜지 않아도 서버는 뜬다. 다만 자연어 질문으로 하는 검색(`text` 질의)은 결과가 0건이다. 키워드 검색만 동작한다.

## 4. 데이터베이스 초기화

```bash
npm run migrate
node scripts/post-migrate-flexible-embedding-dims.js
```

첫 줄은 테이블을 만든다. 둘째 줄은 임베딩 차원을 3번에서 정한 384로 맞춘다. 외부 임베딩 API를 쓴다면 둘째 줄은 필요 없다.

## 5. 서버 실행과 확인

```bash
node server.js
```

첫 기동에서는 임베딩 모델(약 120MB)을 내려받는다. 로그에 `[LocalEmbedder] model ready`가 나오면 끝난 것이다.

다른 터미널에서 확인한다.

```bash
curl http://localhost:57332/health
```

`{"status":"healthy", ...}`가 나오면 정상이다.

## 6. 에이전트 연결

Claude Code:

```bash
claude mcp add anchormind http://localhost:57332/mcp \
  --transport http \
  --scope user \
  --header "Authorization: Bearer 3번에서_정한_MEMENTO_ACCESS_KEY"
```

```bash
claude mcp list
```

`anchormind ... Connected`가 보이면 된다. Claude Code를 재시작하면 `remember`, `recall`, `context` 같은 도구가 보인다.

다른 클라이언트(Cursor, Codex, Windsurf, Claude.ai Web, ChatGPT 등)는 [클라이언트별 연결](clients.md), Claude Code 세부 설정은 [Claude Code Configuration](claude-code.md)을 본다.

## 7. 저장하고 꺼내 보기

에이전트에게 이렇게 말해 본다.

> 우리 프로젝트는 PostgreSQL 15를 쓰고 테스트는 Vitest로 돌린다고 기억해 줘.

새 세션을 열어서 묻는다.

> 이 프로젝트 테스트 어떻게 돌려?

에이전트가 `recall`을 호출해 저장해 둔 내용으로 답하면 동작하는 것이다.

에이전트 없이 직접 확인하려면 [First Memory Flow](first-memory-flow.md)의 curl 예제를 쓴다.

> 저장 직후의 검색 지연: Redis 없이 쓰면 새 기억이 자연어 검색에 잡히기까지 최대 5분이 걸린다. 서버가 5분 주기로 임베딩을 만들기 때문이다. 키워드 검색은 바로 된다.

## 8. 다음 단계

- 에이전트가 기억 도구를 알아서 부르게 하려면 [훅 설정](hooks.md) 또는 [플러그인 설치](plugins.md)를 따른다. 설정하지 않으면 에이전트가 필요하다고 판단할 때만 호출한다.
- 컴퓨터를 껐다 켜도 서버가 살아 있게 하려면 [Production Docker](../operations/production-docker.md)를 본다.
- 오류가 나면 [Troubleshooting](troubleshooting.md)을 본다.
- Windows는 [WSL2 가이드](windows-wsl2.md)를 따른다.
- 터미널에서 직접 조작하려면 [CLI](../cli.md)를 본다.
