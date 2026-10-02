# 보안 정책

## 지원 범위

최신 마이너 릴리스에 보안 수정을 반영한다. 그 이전 버전은 개별 판단한다.

| 버전 | 지원 |
|-|-|
| 5.12.x | 지원 |
| 5.11 이하 | 미지원 |

## 취약점 신고

취약점을 발견하면 공개 이슈로 올리지 말고 아래 경로로 알린다.

- GitHub Security Advisory: https://github.com/JinHo-von-Choi/anchormind/security/advisories/new

접수 후 3영업일 안에 회신하고, 확인되면 수정 계획과 예상 일정을 공유한다. 수정 배포 전까지 상세 내용을 공개하지 않는다.

신고에 다음이 포함되면 확인이 빠르다.

- 영향 받는 버전과 배포 형상
- 재현 절차
- 관측한 영향 범위

## 운영 시 반드시 확인할 것

이 서버는 기억 데이터를 보관하며 API 키 단위로 격리한다. 다음을 확인하지 않은 채 인터넷에 노출하면 격리가 성립하지 않는다.

### 인증

`MEMENTO_ACCESS_KEY`를 설정한다. 설정하지 않으면 서버가 기동하지 않는다. 인증 없이 운용하려면 `MEMENTO_AUTH_DISABLED=true`를 명시해야 하며, 이 경우 모든 요청이 master 권한으로 처리된다. 노출 환경에서는 쓰지 않는다.

API 키로 연 MCP 세션은 사용할 때 키 상태를 `MEMENTO_SESSION_KEY_RECHECK_MS`(기본 30000ms, 0이면 끔) 주기로 다시 읽는다. 비활성 또는 삭제된 키의 세션은 닫히고 404를 받는다.

관리 인증은 `MEMENTO_ADMIN_AUTH_BACKOFF=on`일 때 연속 5회 실패 뒤 다음 시도를 최대 60초까지 늦추고, 지연 중에는 올바른 키도 429를 받는다. 기본은 `off`이며 실패 기록은 항상 남는다. `/register`는 프로세스당 시간당 `MEMENTO_DCR_MAX_PER_HOUR`(기본 100, 0은 상한 없음)건을 넘으면 429를 돌려준다. `MEMENTO_SESSION_ID_POLICY=enforce`와 `MEMENTO_RESERVED_AGENT_IDS=enforce`는 쿼리스트링 세션 ID와 예약 agentId(`system`, `admin`)를 거부한다. 두 값의 기본은 `warn`이다.

### 데이터베이스 격리

기본 배포에서 키 간 격리는 애플리케이션 질의 필터가 담당한다. 행 수준 보안을 두 번째 방어선으로 세우려면 런타임 역할을 표 소유자와 분리하고 `FORCE ROW LEVEL SECURITY`를 적용해야 한다. 절차는 `docs/operations/row-level-security.md`에 있다.

### 리버스 프록시

`TRUST_PROXY_HOPS`를 실제 프록시 단수에 맞춘다. 직접 노출 환경에서는 0을 쓴다. 이 값이 어긋나면 요청자 IP를 위조할 수 있고 IP 기준 제한이 무력해진다. 값이 없는 채로 `X-Forwarded-For`를 받으면 `[Proxy]` 경고를 남기고 관리 `/stats`의 `healthFlags`에 `trust_proxy_hops_unset`을 표시한다.

### 저장 데이터

기억 본문은 PostgreSQL에 평문으로 저장된다. 저장 암호화와 백업 암호화는 인프라 계층 책임이다. Redis에 접근 통제를 걸지 않으면 세션과 토큰이 노출된다.

### LLM CLI 공급자

`MEMENTO_LLM_CLI_TOOL_APPROVAL`의 기본은 `none`이다. gemini-cli, copilot-cli, opencode-cli는 제한된 도구 승인으로 서버 작업 디렉터리가 아닌 빈 임시 디렉터리에서 실행된다. `all`은 승인 제한을 풀고 서버 작업 디렉터리에서 실행하므로 신뢰하는 입력에만 쓴다.

### 타임아웃

`REQUEST_TIMEOUT_MS`와 `DB_STATEMENT_TIMEOUT_MS`를 0으로 두지 않는다. 0은 무제한이며 느린 연결이나 폭주 질의가 커넥션을 점유한다.

## 자동 검사

의존성 점검은 별도 워크플로(`audit.yml`)에서 push, pull request, 매일 예약 실행으로 `npm run audit:ci`(audit-ci, 런타임 의존성, 예외는 `audit-ci.jsonc`)를 수행하고, 전체 의존성은 `npm audit` 보고만 남긴다. 단위 시험은 감사 결과와 무관하게 실행된다. 정적 분석은 CodeQL이 수행한다. 의존성 갱신 제안은 Dependabot이 올린다.
