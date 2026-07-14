# AnchorMind 관리자 콘솔 사용 안내

## 접속

브라우저에서 아래 주소로 접속한다.

```
https://{도메인}/v1/internal/model/nothing/
```

마스터 키 입력 화면이 나타나면 `MEMENTO_ACCESS_KEY` 환경변수에 설정한 키를 입력한다. 인증에 성공하면 HttpOnly 세션 쿠키가 발급되어 24시간 동안 유지된다.

---

## Admin UI 아키텍처

Admin UI는 얇은 진입점(58줄) + 13개 ESM 모듈로 구성된다. Consolidator는 21개 stage(stageDefs 배열)를 순차 실행하며, 진행률 표시는 `stageDefs.length`(21)를 분모로 계산된다.

```
assets/admin/
├── index.html          # <script type="module"> 로 로드
├── admin.js            # 진입점 (58줄) — 모듈 초기화 오케스트레이션
└── modules/
    ├── state.js        # 전역 상태 관리
    ├── api.js          # API 호출 추상화
    ├── ui.js           # 공통 UI 유틸리티
    ├── format.js       # 날짜/숫자 포매팅
    ├── auth.js         # 인증/로그인
    ├── layout.js       # 레이아웃 구성
    ├── overview.js     # 개요 대시보드
    ├── keys.js         # API 키 관리
    ├── groups.js       # 그룹 관리
    ├── sessions.js     # 세션 관리
    ├── graph.js        # 지식 그래프
    ├── logs.js         # 로그 뷰어
    └── memory.js       # 메모리 운영
```

번들러 없이 브라우저 네이티브 ESM을 사용한다. index.html이 `<script type="module">` 태그로 진입점을 로드하고, 각 모듈은 ES import/export로 의존성을 해결한다.

---

## 화면 구성

좌측 사이드바에 8개 메뉴가 있다. 각 메뉴의 역할과 읽는 법을 설명한다.

상단 커맨드바:
- MASTER KEY 배지 -- 현재 세션이 master key 인증임을 표시한다.
- HEALTH -- `/stats`의 healthFlags 실측 기반. 플래그가 없으면 OK(녹색), 있으면 개수를 적색으로 표시하며 마우스를 올리면 플래그 이름(redis_disconnected, db_pool_pressure 등)이 보인다. 미로드 시 --.
- SYNCED -- 마지막 데이터 동기화 시각. 새로고침 버튼으로 stats를 재조회한다.
- 768px 이하 화면에서는 좌측 메뉴 버튼으로 사이드바를 여닫는다(오버레이·ESC로 닫기).

---

### 1. 개요

시스템 전반의 상태를 한눈에 파악하는 화면이다.

상단 KPI 카드 6장:
- 전체 파편 수 -- 저장된 기억 단위의 총 개수
- 활성 세션 -- 현재 연결된 AI 클라이언트 수
- 오늘 API 호출 -- 당일 누적 요청 횟수
- 활성 키 -- 사용 가능 상태인 API 키 수
- DB 크기 -- PostgreSQL 데이터베이스 용량
- Redis 상태 -- 캐시 서버 연결 상태

좌측 영역:
- 시스템 건전성 -- CPU, 메모리, 디스크 사용률을 막대로 표시한다. 85% 이상이면 빨간색으로 바뀌며 주의가 필요하다. 우측에 서버 가동 시간(uptime)이 표시된다.
- 최근 메모리 활동 -- 가장 최근에 저장되거나 조회된 기억 파편 10건을 시간순으로 보여준다. 각 행의 타입 뱃지(Vector, Semantic, Graph 등)는 어떤 경로로 처리됐는지를 나타낸다.

우측 영역:
- 리스크 및 이상 징후 -- 임베딩 대기열 적체, 품질 미검증 파편 비율 등 운영 경고를 표시한다. 빨간 배경 항목은 즉시 확인이 필요하다.
- 빠른 작업 -- 키 생성, 그룹 생성, 유지보수, 로그 열기 버튼. 클릭하면 해당 탭으로 이동하거나 동작을 실행한다.
- Search Latency p50 -- L1(키워드)/L2(벡터)/L3(하이브리드) 검색 계층별 p50 응답 시간(ms) 실측값을 막대로 비교한다. 막대에 마우스를 올리면 실제 수치가 표시되며, 지표가 없으면 --로 표시된다. L3가 비정상적으로 높으면 벡터 인덱스 점검이 필요하다.
- Quality Verified -- 품질 검증(quality_verified)을 통과한 파편의 비율과 실제 건수(N / M fragments)를 도넛으로 표시한다.
- Top Topics -- 저장 파편 수 기준 상위 5개 주제와 전체 대비 비율. 데이터가 없으면 --로 표시된다.

---

### 2. API 키

외부 클라이언트가 MCP 서버에 접속할 때 사용하는 인증 키를 관리한다.

상단 KPI 4장: 활성 키, 비활성 키, 그룹 수, 미소속 키 수.

필터 바:
- GROUP -- 소속 그룹으로 필터링하는 셀렉트박스. 특정 그룹 선택 시 해당 그룹 멤버만 표시된다.
- STATUS -- 키 상태로 필터링하는 셀렉트박스 (All / Active / Inactive).

키 목록 테이블:
- Name -- 키 식별 이름
- Prefix -- 키의 앞 6자 (전체 키는 생성 시 1회만 표시)
- Status -- 토글 스위치로 활성/비활성 전환
- Groups -- 소속 그룹 뱃지
- Created Date -- 생성일
- Usage (24h) -- 최근 24시간 호출 횟수 (스파크라인 차트)

키 생성:
1. 우측 상단 CREATE API KEY 버튼 클릭
2. 이름과 일일 호출 제한 입력
3. GENERATE AND VIEW SECRET 클릭
4. 표시되는 전체 키를 반드시 복사하여 안전한 곳에 저장한다. 이 키는 다시 표시되지 않는다.

키 행을 클릭하면 우측에 상세 패널이 열린다:
- Daily Rate Limit -- 일일 호출 제한을 인라인으로 편집한다. 숫자 입력 필드에 값을 입력하면 변경 즉시 `PUT /v1/internal/model/nothing/keys/:id/daily-limit` API로 저장된다.
- Default Mode -- API 키의 기본 mode preset을 설정한다. 값: `recall-only`, `write-only`, `onboarding`, `audit`, 또는 미설정(전체 도구 노출). 설정 시 해당 키로 연결된 세션의 기본 도구 집합이 제한된다. `X-Memento-Mode` 헤더가 있으면 DB 설정보다 우선한다.
- 소속 그룹 관리:
  - ADD GROUP 버튼을 클릭하면 모달이 열리며 그룹을 선택할 수 있다.
  - Groups Directory 섹션의 각 그룹 행에 ASSIGN 버튼이 표시되며, 클릭 시 해당 키를 그룹에 추가한다.
  - 소속 그룹 목록에서 그룹 옆 X 버튼을 클릭하면 그룹에서 제거된다.
- REVOKE KEY -- 키를 비활성화한다. 되돌릴 수 있다.
- DELETE PERMANENTLY -- 키를 완전히 삭제한다. 이 키로 저장된 파편은 남아있지만 더 이상 접근할 수 없다. 이중 확인 후 실행된다.

---

### 3. 그룹

API 키를 논리적 단위로 묶어 관리한다. 같은 그룹의 키들은 서로의 기억에 접근할 수 있다.

상단 KPI 4장: 그룹 수, 전체 멤버 수, 빈 그룹 수, 미소속 키 수.

그룹 목록에서 행을 클릭하면 우측 패널에 멤버 목록이 나타난다.

그룹 생성:
1. CREATE GROUP 클릭
2. 그룹 이름과 설명 입력
3. 생성 후 API 키를 멤버로 추가

멤버 관리:
- 우측 패널에서 ASSIGN 버튼으로 키 추가
- 멤버 옆 X 버튼으로 제거

---

### 4. 메모리 운영

저장된 기억 파편을 직접 열람·검색·반출하고, 검색 시스템의 실측 지표를 관측한다.

필터 바:
- CONTENT SEARCH -- 파편 본문 부분 일치 검색 (`q` 파라미터, ILIKE)
- TOPIC -- 주제별 필터 (텍스트 입력, 부분 일치)
- TYPE -- 파편 유형 (fact, error, decision, procedure, preference, episode, relation)
- KEY / GROUP -- 특정 API 키 또는 키 그룹의 파편만 조회
- SEARCH 버튼 또는 입력창에서 Enter로 검색 실행
- EXPORT JSONL -- 현재 필터(KEY/GROUP/TOPIC/TYPE)에 해당하는 파편을 JSON Lines 파일로 다운로드한다. KEY 또는 GROUP 필터가 필수다(무필터 전체 반출은 API에서 `confirm=full` 명시 시에만 허용).

검색 결과:
- 각 파편은 고유 ID(#MEM_XXXXX), 주제, 본문 미리보기(200자), 중요도, 접근 횟수를 표시한다.
- 행을 클릭하면 우측 인스펙터에 파편 상세가 열린다(목록은 그대로 유지되고 인스펙터만 갱신된다): 전문, keywords, 메타(anchor·assertion·case·agent 등), 1-hop 링크(관계 유형·방향·상대 파편 미리보기), VIEW IN GRAPH 버튼(지식 그래프로 이동).

우측 패널:
- Retrieval Analytics (7d) -- 최근 7일 실측: 검색 수, zero-result 비율, 검색 레이턴시 p50/p90/p99/avg, 피드백 품질(relevance/sufficiency). 값이 없으면 --.
- Anomaly Insights:
  - Failed Searches (7d) -- 최근 7일 결과 0건 검색 수
  - Superseded Candidates -- 더 최신 기억으로 대체 가능한 후보 수
  - Low Quality Fragments -- 품질 검증 미통과 파편 수
  - Stale Fragments -- 검증 주기를 초과한 파편 수

하단 Search Activity (7d):
- 검색 경로 분포(L1/L2/L3 등 경로별 건수 막대)와 상위 검색 키워드를 표시한다.

페이지네이션:
- 하단에 10개 단위 페이지 버튼이 표시된다. 화살표로 이전/다음 페이지 이동.

---

### 5. 세션

현재 MCP 서버에 연결된 클라이언트 세션을 관리한다.

상단 KPI 4장:
- STREAMABLE -- 현재 방식(HTTP 기반) 세션 수
- LEGACY SSE -- 구 방식(상시 연결) 세션 수
- UNREFLECTED -- 비정상 종료 후 요약이 안 된 고아 세션 수
- TOTAL -- 전체 활성 세션 수

세션 테이블:
- Session ID -- 세션 식별자 앞 8자
- Type -- STREAM 또는 SSE
- Key -- 어떤 API 키로 연결했는지 (master는 마스터 키 접속)
- Created / Last Active -- 생성 시각과 마지막 활동 시각
- Tools -- 해당 세션에서 호출한 도구 횟수 합계
- Reflected -- 세션 종료 시 요약이 생성됐는지 여부 (녹색 점 = 완료, 빨간 점 = 미완료)

세션을 클릭하면 우측 패널에 상세 정보가 표시된다:
- 도구별 호출 횟수
- 사용된 키워드
- 참조한 파편 수
- 최근 검색 이벤트
- FORCE REFLECT -- 종료된 세션의 요약을 수동 생성
- TERMINATE -- 활성 세션을 강제 종료 (이중 확인)

하단 버튼:
- REFLECT ALL -- 미반영 고아 세션을 일괄 요약 처리
- CLEANUP -- 만료된 세션 정리

---

### 6. 로그

서버의 Winston 로그 파일을 실시간으로 조회한다.

상단 KPI 4장: 오늘 INFO/WARN/ERROR 건수, 전체 로그 파일 수.

필터 컨트롤:
- 파일 선택 -- 날짜별/유형별 로그 파일 드롭다운 (combined, error, agent, exceptions, rejections)
- 레벨 필터 -- ALL, INFO, WARN, ERROR, DEBUG
- 키워드 검색 -- 로그 메시지 내 텍스트 검색
- 줄 수 -- 파일 끝에서 읽을 줄 수 (100/200/500/1000)
- Apply 버튼으로 조회 실행

로그 뷰어:
- 모노스페이스 글꼴로 로그를 표시한다.
- 레벨별 색상 구분: INFO(시안), WARN(보라), ERROR(빨강, 굵게), DEBUG(회색)

우측 사이드바:
- 파일 브라우저 -- 날짜별로 그룹핑된 로그 파일 목록. 클릭하면 해당 파일을 로드.
- 최근 에러 -- 오늘 발생한 에러 로그 최근 5건 미리보기
- 디스크 사용량 -- 전체 로그 용량, 보관 기간

---

### 7. 메트릭

Prometheus 기반 핵심 지표를 한 화면에서 확인하는 대시보드다. 외부 Grafana 탭 없이 즉각 진단을 목적으로 하며, 심층 분석은 Grafana에서 수행한다.

엔드포인트: `GET /v1/internal/model/nothing/metrics-summary`
- master 키 또는 admin 권한 전용. 일반 API 키는 403을 반환한다.
- 응답 캐시 TTL: 10초. 운영자 폴링(30초)과 조합하여 서버 부하를 최소화한다.
- `?windowSec=N` 쿼리 파라미터로 rate 계산 윈도우 변경 가능 (기본 60초).

상단 카드 (8종):

| 카드 | 설명 | 소스 메트릭 |
|-|-|-|
| Active Sessions | 현재 연결된 세션 수 | mcp_active_sessions_streamable + mcp_active_sessions_legacy |
| Auth Denied (5m) | 인증 거부 발생률 (건/분) | memento_auth_denied_total rate |
| RBAC Denied (5m) | 권한 거부 발생률 (건/분) | memento_rbac_denied_total rate |
| Tenant Blocked | 테넌트 격리 차단 누적 수 | memento_tenant_isolation_blocked_total |
| RPC p50 / p99 | JSON-RPC 레이턴시 백분위 (ms) | mcp_rpc_method_duration_seconds histogram |
| Tool Errors (5m) | 도구 에러 발생률 (건/분) | mcp_errors_total{type="tool"} rate |
| Symbolic Gate Blocked | Symbolic hard-gate 차단 누적 수 | memento_symbolic_gate_blocked_total |
| OAuth Tokens (1h) | OAuth 토큰 발급률 (건/시간) | mcp_oauth_tokens_issued_total rate |

도구별 호출 통계 테이블 (하단 좌):

| 컬럼 | 설명 |
|-|-|
| tool | MCP 도구 이름 (remember, recall, context 등) |
| total_calls | 전체 호출 횟수 |
| success_rate | 성공 비율 (0.0 ~ 1.0) |
| p95_ms | 95번째 백분위 레이턴시 (밀리초) |

에러 타입별 분포 테이블 (하단 우):

| 컬럼 | 설명 |
|-|-|
| error_type | 에러 분류 레이블 (rpc_invalid_params 등) |
| count | 누적 발생 횟수 |
| last_seen | 마지막 발생 시각 (ISO 8601) |

폴링 및 새로고침:
- Admin UI는 30초 간격으로 자동 폴링한다.
- 즉시 갱신이 필요하면 상단 바의 새로고침 아이콘을 클릭한다.
- 서버 측 캐시 TTL(10초)로 인해 갱신 후에도 최대 10초의 지연이 있을 수 있다.

Admin 메트릭 메뉴는 운영자 즉각 진단(at-a-glance health) 용도다. DB/Redis 의존 없이 prom-client in-memory에서 직접 산출하며, 심층 시계열 분석은 외부 Prometheus + Grafana 스택에서 `/metrics` 엔드포인트를 scrape하여 수행한다.

---

### 8. 지식 그래프

파편 간 관계를 시각적으로 탐색하는 화면이다.

상단 컨트롤:
- Topic 필터 -- 특정 토픽의 파편만 표시 (빈칸이면 전체)
- Group / Key 필터 -- 키 그룹 또는 특정 키의 파편으로 한정
- Limit 슬라이더 -- 표시할 최대 노드 수 (10~10000, 기본 50)
- Load 버튼 -- 그래프 데이터를 서버에서 불러와 렌더링
- COLOR 토글 -- 노드 색상 기준 전환. TYPE(기본, 파편 유형별)과 AGENT(agent_id 해시 색 — 멀티에이전트 케이스에서 기여 에이전트 구분) 두 모드이며, 범례가 함께 전환된다.

그래프 영역:
- 노드: 파편. 크기는 importance, 색상은 색상 모드에 따름(TYPE 모드: fact=파랑, decision=보라, error=빨강, procedure=녹색, preference=주황, episode=분홍)
- 엣지: 파편 간 관계. 두께는 weight(반복 연결 시 증가)
- 노드 위에 마우스를 올리면 파편 내용·토픽·기여 agent_id 표시
- 드래그로 노드 위치 조정 가능

하단 통계: 표시 중인 노드 수와 엣지 수.

렌더링 최적화:
- SVG blur 필터 비활성화: 시뮬레이션/드래그 중 blur 필터를 끄고 안정화 후 복원한다. 프레임 비용 약 70% 감소.
- 인접맵(adjMap) 사전 구축: hover 시 O(1)로 연결된 링크를 하이라이트한다. 매 hover마다 전체 엣지를 순회하지 않는다.
- 위성 rAF 제어: force 시뮬레이션 진행 중에는 위성 애니메이션을 정지하고, document.hidden 상태에서는 requestAnimationFrame을 중단한다.
- 행성 크기 결정적 난수: fragRng 기반으로 노드 크기에 +-15% 변동을 적용한다. 동일 데이터에 대해 항상 같은 시각적 결과를 보장한다.

API: `GET /memory/graph?topic=xxx&limit=50` -> `{ nodes: [...], edges: [...] }` (노드에 agent_id·is_anchor 포함)

---

## Admin API Rate Limit

일부 Admin API 엔드포인트에 IP 기반 rate limit이 적용된다.

| 경로 | 메서드 | Rate Limit 적용 |
|------|--------|----------------|
| `/v1/internal/model/nothing/auth` | POST | 적용 |
| `/v1/internal/model/nothing/keys` | POST | 적용 |
| `/v1/internal/model/nothing/import` | POST | 적용 |

제한 초과 시 `429 Too Many Requests`와 `Retry-After` 헤더가 반환된다. 제한값은 서버의 `RATE_LIMIT_PER_IP` / `RATE_LIMIT_WINDOW_MS` 환경변수로 조정한다 (기본값: 30건/분).

반복 로그인 시도, 대량 키 생성, 대규모 파편 가져오기 작업은 이 제한에 걸릴 수 있다. import 작업이 대량이라면 단일 JSON 배열로 묶어 한 번에 요청하는 것이 권장된다.

---

## X-RateLimit 응답 헤더

MCP 엔드포인트와 Admin API 응답 모두에 `X-RateLimit-*` 헤더가 포함된다.

| 헤더 | 설명 |
|------|------|
| `X-RateLimit-Limit` | 해당 리소스의 윈도우 내 최대 요청 허용 횟수 |
| `X-RateLimit-Remaining` | 현재 윈도우에서 남은 요청 횟수 |
| `X-RateLimit-Resource` | 제한이 적용된 리소스 식별자 (ip, key 등) |

이 헤더는 Admin UI의 브라우저 개발자 도구 > Network 탭에서 확인할 수 있다. 클라이언트 측에서 `Remaining` 값을 모니터링하여 429 오류 전에 요청 속도를 조절할 수 있다.

## _meta 응답 구조 호환성

`_meta` 래퍼는 Admin UI 화면에 영향을 주지 않는다. Admin UI는 내부 REST API(`/v1/internal/model/nothing/*`)를 사용하며 MCP 도구 응답 포맷(`_meta`)에 의존하지 않는다.

---

## 일반 조작

공통적으로 적용되는 조작 방법:

- 삭제/비활성화 같은 파괴적 동작은 확인 모달이 뜬다. 실수로 누르더라도 한 번 더 확인을 거친다.
- 동작 결과는 우측 상단 토스트 알림으로 표시된다: 시안(정보), 녹색(성공), 빨강(실패), 보라(경고).
- 데이터는 탭 전환 시 자동으로 최신화된다. 수동 새로고침은 상단 바의 새로고침 아이콘 클릭.
- 로그아웃은 사이드바 하단의 LOGOUT 클릭. 세션 키가 브라우저에서 제거된다.
