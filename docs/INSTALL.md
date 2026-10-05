# 설치 가이드

> [!TIP]
> 직접 설치하기 어렵다면 [AI에게 맡기기](#ai에게-맡기기) 섹션부터 보면 된다. 한 줄 프롬프트로 환경 점검·의존성 설치·`.env` 생성·MCP 등록·헬스 체크까지 AI가 진행한다.

## AI에게 맡기기

이 저장소를 처음 다룬다면 AI 어시스턴트에 맡기는 것이 가장 빠르다. Claude Code, Cursor, Codex 같은 도구를 모두 쓸 수 있다.

### 권장 프롬프트

**클린 설치 (새 환경에 처음 도입)**

> "anchormind 저장소(`https://github.com/JinHo-von-Choi/anchormind`)를 내 환경에 클론하고, `docs/INSTALL.md`와 `SKILL.md`를 읽어 다음을 수행해 줘:
>
> 1. 시스템 요구사항 확인 (Node.js, PostgreSQL, Redis 가용성)
> 2. `npm install` 및 `bash setup.sh`로 의존성·.env 생성
> 3. PostgreSQL과 Redis가 없으면 설치하거나 Docker Compose 권장 구성 제시
> 4. 마이그레이션(`npm run migrate`) 실행
> 5. `node bin/memento.js health`로 헬스 체크 통과 확인
> 6. 현재 사용 중인 AI 클라이언트(Claude Code/Cursor/Codex)의 MCP 설정에 AnchorMind 등록
> 7. `mcp__anchormind__context` 호출로 동작 검증 (master 키이면 `mcp__anchormind__memory_stats`도 가능)
>
> 각 단계 결과를 표로 보고하고, 실패하면 `docs/getting-started/troubleshooting.md`를 참고해 자동 복구를 시도해 줘."

**기존 Claude Code 환경 통합**

> "내 `~/.claude.json`에 AnchorMind MCP 서버를 추가하고 싶다. `docs/getting-started/claude-code.md`를 참고해서 다음을 진행해 줘:
>
> 1. 현재 `~/.claude.json` 백업
> 2. AnchorMind 항목을 mcpServers 섹션에 추가 (URL, ACCESS_KEY)
> 3. Claude Code 재시작 안내
> 4. 도구 목록에 mcp__anchormind__remember 등이 표시되는지 확인하는 절차 제시"

### AI가 수행할 작업 체크리스트

위 프롬프트를 받은 AI가 정상적으로 처리했다면 다음 조건이 모두 충족되어야 한다.

- `.env` 파일이 생성되고 `MEMENTO_ACCESS_KEY`·`POSTGRES_*`·`REDIS_*` 키가 모두 채워져 있다
- `npm run migrate`가 `migration-060`까지 통과한다
- `node bin/memento.js health`가 DB/Redis/임베딩 제공자 모두 OK를 반환한다
- AI 클라이언트 도구 목록에 `mcp__*__remember`·`recall`·`reflect`가 노출된다
- `context` 호출이 기억 0건이라도 정상 응답을 반환한다 (master 키의 `memory_stats`도 같다)

### AI가 막혔을 때 사람이 봐야 할 문서

- 의존성 문제: [Troubleshooting](getting-started/troubleshooting.md)
- Windows: [Windows WSL2 Setup](getting-started/windows-wsl2.md)
- Claude Code 등록 세부: [Claude Code Configuration](getting-started/claude-code.md)
- 첫 동작 검증: [First Memory Flow](getting-started/first-memory-flow.md)
- 운영 매뉴얼: [SKILL.md](../SKILL.md)

## 시작 경로 선택

- 최소 실행만 빨리 확인: [Quick Start](getting-started/quickstart.md)
- Windows에서 가장 안정적인 설치: [Windows WSL2 Setup](getting-started/windows-wsl2.md)
- Windows에서 Bash 없이 수동 설치: [Windows PowerShell Setup](getting-started/windows-powershell.md)
- Claude Code 연동: [Claude Code Configuration](getting-started/claude-code.md)
- Docker 상시 운영·재부팅 복구: [Production Docker](operations/production-docker.md)
- 설치 후 첫 검증: [First Memory Flow](getting-started/first-memory-flow.md)
- 문제 해결: [Troubleshooting](getting-started/troubleshooting.md)

## 지원 정책

- Linux / macOS: 일반 설치 경로
- Windows: WSL2 Ubuntu 경로 권장
- Windows PowerShell: 제한 지원
- `setup.sh`: Bash 환경 전제

## 빠른 시작 (대화형 설치 스크립트)

```bash
bash setup.sh
```

`.env` 생성, `npm install`, DB 스키마 적용까지 단계별로 안내한다.

## 수동 설치

의존성 설치, 환경 파일 준비, PostgreSQL 스키마 적용, 서버 실행 순서로 진행하는 절차는 [Quick Start](getting-started/quickstart.md)에 있다. `vector` 확장은 슈퍼유저 권한이 필요하며 `npm run migrate`가 만들지 않으므로, 먼저 `CREATE EXTENSION IF NOT EXISTS vector`를 실행한다.

## 업그레이드 (기존 설치)

순서는 `git pull`, `npm install`, `npm run migrate`, 서비스 재시작이다. 버전별 주의 사항과 되돌리기 방법은 [업그레이드 노트](operations/upgrade-notes.md)에 있다.

## 환경 변수와 선택 구성

- 시작용 파일은 `.env.example.minimal`, 운영형 예시는 `.env.example`이다. 전체 환경 변수는 [Configuration](configuration.md)에 있다.
- OpenAI 키 없이 로컬 모델로 임베딩을 쓰려면 [로컬 임베딩 가이드](embedding-local.md)를 따른다.
- 품질 평가와 자동 reflect에 쓰는 LLM provider와 CLI 설치는 [LLM Providers](operations/llm-providers.md)에 있다.

## 기동 후 검증 체크리스트

서버를 기동한 뒤 아래 항목을 순서대로 확인한다.

```bash
# 1. 헬스 엔드포인트 200 확인
curl -s http://localhost:57332/health | jq .status
curl -s http://localhost:57332/health/live    # 항상 200 (프로세스 생존)
curl -s http://localhost:57332/health/ready   # 주 DB 응답 시 200, 아니면 503 (db_timeout, db_error)

# 2. 임베딩 일관성 검사 결과 확인 (서버 로그)
# 정상: 관련 로그 없이 기동 계속
# 불일치: "[embedding-consistency] 차원 불일치 발견:" 출력 후 기동 중단

# 3. CLI 진단
node bin/memento.js health
```

임베딩 일관성 검사는 통과하면 별도 로그 없이 기동을 이어간다. `[embedding-consistency] 차원 불일치 발견:` 뒤에 테이블별 `DB=Nd, config=Nd`가 출력되고 기동이 중단되면 `EMBEDDING_DIMENSIONS` 설정과 실제 DB 차원이 맞지 않는 상태다. 이전 provider로 되돌리거나, `EMBEDDING_DIMENSIONS=N DATABASE_URL=$DATABASE_URL node scripts/post-migrate-flexible-embedding-dims.js` 실행 후 `node scripts/backfill-embeddings.js`로 재생성한 뒤 서버를 재시작한다.

## 서버 실행과 연결

```bash
node server.js
```

클라이언트 연결은 [클라이언트별 연결](getting-started/clients.md), [Claude Code](getting-started/claude-code.md)를 참고한다. 터미널 명령은 [CLI](cli.md)에 정리되어 있다.

## 기억 도구를 자동으로 쓰게 하기

`initialize` 응답의 `instructions`가 기억 도구 사용을 권하더라도, 그 사실만으로 세션 시작 시 기억이 주입되지는 않는다. 아래 중 하나를 설정한다.

- 훅: [훅 설정](getting-started/hooks.md)
- 플러그인(훅과 스킬 묶음): [플러그인 설치](getting-started/plugins.md)
- 지침 파일: `CLAUDE.md`에 다음을 적는다.

```markdown
## 세션 시작 규칙
- 대화 시작 시 반드시 `context` 도구를 호출하여 Core Memory와 Working Memory를 로드한다.
- 에러 해결이나 코드 작업 전에는 `recall(keywords=[관련_키워드], type="error")`로 관련 기억을 먼저 확인한다.
```
