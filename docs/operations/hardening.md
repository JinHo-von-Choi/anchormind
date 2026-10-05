# 보안과 운영 점검

서버를 인터넷에 열기 전 해야 할 일을 정리했다. 지금 적용된 보호 장치와 운영 중 확인할 항목도 함께 모았다.

## 외부에 공개하기 전에 할 일

로컬에서만 쓰면 이 절은 건너뛰어도 된다. 인터넷이나 팀 네트워크에 열 때는 위에서부터 차례로 한다.

1. **TLS를 종단하는 리버스 프록시 뒤에 둔다.** HSTS 헤더도 프록시에서 설정한다.
2. **프록시 단계 수를 알려 준다.** `TRUST_PROXY_HOPS`에 직접 노출이면 0, 프록시 하나 뒤면 1을 넣는다. 미설정이면 `X-Forwarded-For`의 첫 항목을 믿는다.
3. **마스터 키를 강하게 만든다.** `MEMENTO_ACCESS_KEY`가 비어 있으면 서버가 기동하지 않는다. 인증 없이 쓰려면 `MEMENTO_AUTH_DISABLED=true`를 따로 적어야 하며 개발용이다.
4. **Origin을 제한한다.** 아래 "Origin 설정"을 본다.
5. **경고만 하는 보호를 거부로 바꾼다.** 아래 "enforce로 바꿀 설정"을 본다.
6. **관리자 계정을 만든다.** 비밀번호와 TOTP로 로그인하는 계정을 쓰면 마스터 키로 콘솔에 들어가는 일을 줄인다. 설정은 [업그레이드 노트](upgrade-notes.md#1-앵커-권한-관리자-계정-본문-어휘-검색-migration-053--060)에 있다.
7. **노출 상태를 점검한다.** [maintenance.md](maintenance.md)의 "외부 노출 점검"으로 listen 주소, 인증 키, Origin 허용 목록을 확인한다.

### Origin 설정

데스크탑 앱, CLI, IDE 확장(Claude Code, Cursor, Windsurf, Continue, Cline, Zed, gemini CLI 등)은 `Origin` 헤더를 보내지 않는다. 이런 클라이언트만 쓰면 Origin 설정은 필요 없다.

브라우저에서 동작하는 클라이언트를 쓸 때만 설정한다.

| 변수 | 역할 |
|------|------|
| `ALLOWED_ORIGINS` | 허용할 브라우저 Origin 목록. 미설정이면 모든 Origin을 받는다. 설정하면 목록 밖 Origin의 요청은 403으로 끝난다. |
| `MCP_STRICT_ORIGIN=true` | `/mcp`까지 신뢰하는 도메인으로 좁힌다. |
| `ADMIN_ALLOWED_ORIGINS` | 관리 콘솔을 부르는 Origin 목록. 미설정이면 모두 허용하므로 콘솔 Origin을 적거나 프록시와 방화벽에서 접근을 막는다. |
| `OAUTH_TRUSTED_ORIGINS` | 동의 화면 없이 자동 승인할 Origin. 한 Origin에서 앱 여러 개를 운영하면 `OAUTH_ALLOWED_REDIRECT_URIS`로 전체 URI를 맞춰 보는 쪽을 권한다. |
| `MEMENTO_CORS_MODE` | 교차 출처 응답 헤더 방식. `observe`(기본, 요청 Origin을 돌려주고 처음 본 Origin을 로그에 남김), `reflect`, `allowlist`(`OAUTH_TRUSTED_ORIGINS`만 허용). |

`ALLOWED_ORIGINS`에는 실제로 쓰는 것만 넣는다. 흔한 후보는 claude.ai, claude.com, chatgpt.com, chat.openai.com, copilot.microsoft.com, gemini.google.com, aistudio.google.com, www.perplexity.ai, cursor.com, codeium.com, windsurf.com, sourcegraph.com, typingmind.com이다.

### enforce로 바꿀 설정

아래 설정은 기본이 "경고만 남기고 통과"다. 기존 클라이언트가 깨지지 않는지 로그를 본 뒤 거부로 바꾼다.

| 변수 | 기본 | 거부로 바꾸면 |
|------|------|--------------|
| `MEMENTO_TOOL_ARGS_VALIDATION` (`off`, `warn`, `enforce`) | `warn` | 호출 인자가 `tools/list`의 스키마와 맞지 않으면 -32602로 거절한다. |
| `MEMENTO_SESSION_ID_POLICY` (`warn`, `enforce`) | `warn` | 쿼리스트링의 세션 ID는 400, 서버가 발급한 형식(UUID)이 아닌 ID의 복구는 404로 거절한다. |
| `MEMENTO_RESERVED_AGENT_IDS` (`warn`, `enforce`) | `warn` | API 키 요청이 내부용 agentId(`system`, `admin`)를 쓰면 -32001로 거부한다. 마스터 키는 허용한다. |
| `MEMENTO_ANCHOR_PERMISSION` (`off`, `warn`, `enforce`) | `warn` | `anchor` 권한이 없는 키의 앵커 지정을 거부한다. |
| `MEMENTO_WORKSPACE_READ_AUTHZ` (`off`, `warn`, `enforce`) | `warn` | 키의 `allowed_workspaces` 밖을 읽거나, 마스터가 아닌 세션이 마스터 전용 preset을 요청하면 -32001로 거부한다. |
| `MEMENTO_OAUTH_REDIRECT_CHECK` (`warn`, `enforce`) | `warn` | `/authorize` 오류 응답이 등록되지 않은 `redirect_uri`로 이동하지 않고 400 JSON을 돌려준다. |
| `MEMENTO_SSE_QUERY_KEY` (`allow`, `deny`) | `allow` | 옛 SSE의 `?accessKey=` 쿼리 키를 받지 않고 401로 `Authorization` 헤더를 쓰라고 안내한다. `allow`는 마스터 키에 한해 받는다. |
| `MEMENTO_ADMIN_AUTH_BACKOFF` (`on`, `off`) | `off` | 관리 인증이 연속 5회 실패하면 다음 시도를 최대 60초 늦춘다. 지연 중에는 올바른 키도 429(`Retry-After`)를 받는다. |

`MEMENTO_WORKSPACE_READ_AUTHZ`는 `enforce` 전에 `warn` 기간 동안 쌓인 키별 기록(`memento_workspace_read_authz_total`과 경고 로그)을 확인한다.

`MEMENTO_FRAME_OPTIONS=deny`를 적으면 `X-Frame-Options: DENY` 헤더를 붙인다. 적지 않으면 이 헤더는 붙지 않는다.

## 항상 적용되는 보호

- 기본 권한 거부: `TOOL_PERMISSIONS`에 없는 도구 이름은 권한 설정과 무관하게 거부한다.
- 키별 격리: `forget`, `amend`, `link`, `fragment_history`는 SQL 조건에 `key_id`를 넣는다. 다른 키의 파편에 닿지 못하게 하기 위해서다. "없음"과 "권한 없음"에는 같은 메시지를 돌려 존재 여부도 드러내지 않는다.
- 세션 정보 위조 차단: 클라이언트가 `_keyId`, `_permissions` 같은 내부 필드를 보내더라도 서버의 인증 결과로 다시 덮어쓴다.
- 키 상태 재확인: API 키로 연 세션은 `MEMENTO_SESSION_KEY_RECHECK_MS`(기본 30000ms, 0이면 끔)마다 키 상태를 다시 읽는다. 키가 비활성화되거나 삭제되면 세션은 닫히고 404 `Session not found`를 받는다. 권한 변경도 열린 세션에 반영된다.
- 관리 API 권한: 요청마다 라우트에 지정된 능력을 확인한다. 표에 없는 경로는 owner만 쓴다. 관리자 계정은 TOTP(owner와 admin 필수)로 로그인하고, 세션 쿠키에는 `SameSite=Strict`와 이중 제출 CSRF 확인을 쓴다. 마스터 키 로그인은 비상용으로 남겨 둔다.
- 출처와 검토: 파편의 `origin`과 `trust_tier`를 확인해 신뢰가 낮은 내용은 ANCHOR와 CORE 주입에서 제외한다. 지시를 덮어쓰려는 문구는 검토 대기열로 보낸다.
- 키 수명: 만료, 허용 주소 대역, 교체, 폐기를 지원한다. 폐기한 키의 세션은 즉시 닫힌다.
- 호출 제한: `/auth`, `/keys` POST, `/import` POST에는 IP 기준 제한을 둔다. 그 밖의 요청은 API 키당 분당 100회, IP당 분당 30회이며 환경 변수로 조정할 수 있다. `initialize`, `GET /sse`, `/token`, `/register`, `/authorize`는 IP 한도를 함께 쓰고, 한도를 넘으면 429와 `Retry-After`를 돌려준다.
- 감사 기록: 도구 호출 기록에는 행위자(`key=`, `sid=` 앞 8자, `ip=`)를 남긴다. 관리 API의 변경 요청(GET 제외)과 관리 인증의 성공·실패도 기록한다.
- 응답 헤더: 모든 응답에 `X-Content-Type-Options: nosniff`와 `Referrer-Policy: no-referrer`를 붙인다.
- OpenAPI: `ENABLE_OPENAPI=true`이면 `GET /openapi.json`을 연다. 마스터 키는 전체 경로를 받고, API 키는 권한으로 걸러진 명세만 받는다.

## 운영 중 점검

### 상태 확인

| 주소 | 의미 |
|------|------|
| `/health` | DB, Redis, pgvector, 워커 상태를 함께 확인한다. 일부만 죽어 있으면 degraded로 응답한다. 인증 없는 요청에는 상태만 반환한다. |
| `/health/live` | 프로세스가 살아 있는지만 본다. 항상 200이다. |
| `/health/ready` | 주 DB가 `MEMENTO_HEALTH_READY_DB_TIMEOUT_MS`(기본 2000) 안에 응답하면 200이다. 응답하지 못하면 `db_timeout` 또는 `db_error`와 함께 503을 반환한다. |

`memento-watchdog.sh`는 `/health/live`가 응답하지 않을 때만 서비스를 재시작한다. 재시작이 연속으로 일어나면 간격을 지수로 늘리고, 잠금으로 중복 실행을 막는다.

### 자동으로 되는 것

- 워커 복구: 임베딩 워커와 평가 워커가 오류를 내면 1초부터 60초까지 지수 백오프로 다시 시도한다.
- 정상 종료: `SIGTERM`을 받으면 진행 중인 워커를 최대 30초까지 기다린 뒤 세션의 auto-reflect를 실행한다. 전체 종료 절차는 `MEMENTO_SHUTDOWN_DEADLINE_MS`(기본 60000, 0이면 제한 없음) 안에서 끝낸다. 시간을 넘기면 종료 코드 1로 강제 종료한다.
- OAuth 오류 응답: 인증에 실패하면 `WWW-Authenticate` 헤더를 반환해 OAuth 클라이언트가 인증 흐름을 시작할 수 있게 한다. 세션 TTL 기본값은 43200분(30일)이며 `SESSION_TTL_MINUTES`로 바꿀 수 있다.

### 직접 실행하는 것

- 백업: `scripts/ops/backup.sh`가 `agent_memory` 스키마를 `pg_dump`하고 기본 14일 동안 보관한다. `scripts/ops/restore-verify.mjs`는 일회용 시험 서버에 복원한 뒤 매니페스트와 맞는지 확인한다. 절차는 [backup-restore.md](backup-restore.md)에 있다.
- 큰 표의 색인: `scripts/ops/online-index.mjs`가 쓰기를 막지 않고 색인을 만든다(`--dry-run`, `--confirm`). 절차는 [online-migration.md](online-migration.md)를 따른다.
- 감사 기록 검증: `anchormind audit verify`가 해시 체인을 다시 계산한다. 끊어진 곳이 있으면 종료 코드 1로 끝난다. 관리자 계정을 잃었을 때는 `anchormind admin recover --confirm`로 비상 복구한다.
- 기능 스위치 점검: `npm run switches`가 스위치마다 적용값, 기본값, 상태를 표로 보여 준다. `--strict`를 붙이면 값이 잘못된 스위치가 있을 때 종료 코드 1로 끝난다.
- 마이그레이션 검사: `npm run lint:migrations`.
- 메트릭: `/metrics`는 Prometheus 형식으로 열린다. `MEMENTO_ACCESS_KEY`가 설정되어 있으면 마스터 키 인증이 필요하다. 공유 Prometheus용 설정은 [monitoring.md](monitoring.md)에 있다.

운영 문서는 이 디렉터리에 더 있다. LLM provider 체인, symbolic hard gate, agent worktree, upstream porting 등을 다룬다.

## 알려진 제한사항

- 자동 품질 평가는 `decision`, `preference`, `relation` 유형만 대상으로 한다. `fact`, `procedure`, `error`는 평가 대기열에 넣지 않는다.
- L1 Redis 색인은 API 키 단위다. 핫 캐시와 작업 기억을 채울 때 유효한 agent 범위를 다시 확인하며, agent 정보가 없는 옛 캐시 항목은 제외한다.
