---
name: anchormind
description: AnchorMind 장기 기억 MCP 도구(context, recall, remember, reflect, forget, link, amend 등) 사용 규칙의 핵심본. 세션 시작, "이전에/저번에" 언급, 에러 해결 착수, 설정·포트·경로 변경, 설계 결정, 세션 종료, "기억해/저장해/잊어" 요청이 있을 때 쓴다. 상세 규칙은 get_skill_guide 도구의 섹션으로 읽는다.
---

# AnchorMind 기억 도구 핵심 규칙

AnchorMind는 세션 사이의 지식을 파편(1~3문장의 자기완결 단위) 단위로 저장하고 회상하는 MCP 서버다. 이 문서는 매 세션에 필요한 핵심 규칙만 담는다. 파라미터 전체, 예시, 내부 동작은 서버의 `get_skill_guide` 도구가 돌려주는 정본(저장소 루트 SKILL.md)에서 섹션 단위로 읽는다. 상세 참조 목록은 맨 아래 "상세 참조"에 있다.

골격: `context`로 시작하고, 작업 중에는 `recall`을 먼저 부르고 확정된 사실은 즉시 `remember`하며, `reflect`로 마무리한다.

## 1. 세션 시작

- 이 플러그인의 SessionStart 훅이 세션 시작, 재개, 압축 직후에 `context` 결과를 주입한다. 컨텍스트에 `[ANCHOR MEMORY]`, `[CORE MEMORY]` 또는 기억 시스템 섹션이 있으면 그대로 적용하고 `context`를 다시 부르지 않는다.
- 주입된 섹션이 없을 때만(훅 실패, 키 권한 부족) `context`를 직접 부른다.
- `context`는 핵심 파편만 싣는다. 사용자의 첫 발화에 나온 프로젝트명, 서비스명, 에러 키워드로 `recall`을 한 번 더 부른다.
  - 예: `recall(topic="프로젝트명", contextText="오늘 작업 한 줄 요약")`
- preference 파편은 즉시 응답 방식에 적용하고, error와 procedure 파편은 현재 작업과 관련이 있는지 확인한다.
- `system_hints`에 미반영 세션 경고가 있으면 사용자에게 알린다.

## 2. recall 선행 의무

답변, 코드, 조언을 만들기 전에 recall을 먼저 부른다. 결과를 근거로 답하고, 결과가 없거나 부족할 때만 사용자에게 묻는다. 사용자에게 "이전 설정을 알려 달라"고 되묻기 전에 반드시 recall한다.

| 발화 신호 | 호출 |
|-|-|
| "이전에", "저번에", "지난번" | `recall(text=관련 내용, includeContext=true)` |
| 프로젝트명, 서비스명 등장 | `recall(topic=프로젝트명, contextText=현재 작업 요약)` |
| 에러, 실패, 이상 동작 보고 | `recall(type="error", keywords=[에러 키워드])` |
| 설정, 환경 변수, 포트, 경로 | `recall(type="fact", keywords=[설정명, 프로젝트명])` |
| 빌드, 배포, 테스트 절차 | `recall(type="procedure", keywords=[프로젝트명, "deploy"])` |
| "왜 X로 했지", 결정 회상 | `recall(type="decision", topic=프로젝트명)` |
| 과거 유사 사례 | `recall(caseMode=true, text=관련 내용)` |
| 지시대명사("그거", "그 문제") | `recall(text=직전 대화 맥락 요약)` |

- 검색어 선택: 정확한 용어를 알면 `keywords`, 개념만 알면 `text`, 둘 다 있으면 함께 준다.
- 결과 0건이면 포기하지 않는다. keywords 재구성, text 전환, contextText 추가, type 필터 제거 순으로 다시 부른다.
- 권장 최소 횟수: 단순 질의 1회, 코드 작업 3회, 에러 디버깅과 설계 논의 5회.

## 3. remember 즉시 저장

확정된 순간에 바로 저장한다. 세션 끝 reflect로 미루지 않는다.

| 상황 | type | importance |
|-|-|-|
| 사용자 선호, 스타일 명시 | preference | 0.9 |
| 에러 원인 파악 | error | 0.8 |
| 에러 해결책 확정 | procedure | 0.8 |
| 아키텍처, 기술 선택 | decision | 0.7 |
| 배포, 빌드 절차 확정 | procedure | 0.7 |
| 새 경로, 포트, 설정값 | fact | 0.6 |
| "기억해", "저장해", "메모해" | 지정한 type | 1.0, isAnchor=true |
| 검증 전 가설 | fact 또는 error | 0.6, assertionStatus="inferred" |

저장 품질:

- 파편 하나에 사실 하나. 300자 이내(episode는 1000자). 대명사와 "이번 세션" 같은 자기 참조를 쓰지 않는다.
- keywords는 3~5개: 프로젝트명, 토픽, 고유 식별자(호스트명, 파일명, 에러 코드). topic은 프로젝트명.
- API 키, 비밀번호, 토큰은 저장하지 않는다.
- 정보가 바뀌면 `supersedes`로 옛 파편을 대체한다. 절대 바뀌지 않는 핵심 규칙만 `isAnchor=true`.
- 응답에 `validation_warnings`가 있으면 내용을 보강해 다시 저장한다(`sensitive.*` 경고는 서버가 이미 가렸으므로 다시 저장하지 않는다).
- 재시도할 수 있는 저장에는 `idempotencyKey`(예: `{작업명}-{날짜}-{순번}`)를 준다.
- 여러 건은 `batch_remember`(최대 200건)로 한 번에 저장한다.

## 4. workspace

- 한 API 키를 여러 프로젝트가 함께 쓰면 remember, batch_remember, reflect, recall, context에 매번 `workspace`를 준다. 생략하면 키 기본값을 쓰고, 기본값도 없으면 전역 기억만 읽고 쓰므로 의도한 프로젝트 기억이 누락될 수 있다.
- 키에 `default_workspace`가 지정된 프로젝트 전용 키만 생략할 수 있다.
- 모든 workspace에서 보여야 하는 전역 기억(예: 사용자 공통 선호)은 의도적으로 workspace를 비운다.
- recall에 workspace를 주면 그 workspace와 전역 파편이 함께 나온다.
- 이 플러그인의 훅은 현재 디렉터리와 git 원격 주소로 workspace를 고른다(키의 `allowed_workspaces` 안에서만).

## 5. recall 결과 활용과 피드백

- similarity 0.7 이상은 답변에 명시적으로 반영하고, 0.4~0.7은 참고하되 사용자 확인을 받는다.
- `stale_warning`이 있으면 "기록상 X였으나 오래된 정보"라고 밝히고 확인을 요청한다. 시점 판단은 응답 `_meta.serverTime`을 기준으로 한다.
- 응답 메타는 `_meta.searchEventId`, `_meta.hints`, `_meta.suggestion`으로만 읽는다.
- recall 뒤에는 `tool_feedback`을 보낸다: `tool_feedback(tool_name="recall", relevant=true|false, sufficient=true|false, fragment_ids=[...], search_event_id=_meta.searchEventId)`. 쓴 파편은 relevant=true, 무관한 파편은 relevant=false.
- `_meta.hints[0].signal`별 후속 행동:

| signal | 행동 |
|-|-|
| `topic_mismatch` | 제안된 유사 topic으로 다시 검색 |
| `no_results` | 다른 검색어로 재시도, 작업 뒤 remember |
| `contradiction_pending` | 상충 파편 확인 후 amend 또는 forget |
| `stale_results` | timeRange로 좁히거나 amend로 갱신 |
| `consider_context` | `includeContext=true`로 다시 검색 |
| `active_errors` | 해결된 error 파편은 forget |
| `feedback_sampled` | `hints[0].args`대로 직전 쓰기 결과에 tool_feedback |

- `_meta.suggestion.recommendedTool`이 있으면 그 도구를 다음 호출로 고려한다.

## 6. forget, link, amend

- 에러를 완전히 해결하면 그 error 파편을 `forget`한다. 사용자가 "잊어", "지워"라고 하면 즉시 forget. 대량 삭제 전에는 `dryRun=true`로 연결 링크 수를 확인한다.
- 인과 관계는 저장 직후 `link`로 잇는다: 에러에서 해결책 `resolved_by`, 원인에서 결과 `caused_by`, 모순 `contradicts`. `related`는 서버가 자동 생성하므로 따로 걸지 않는다.
- 가설을 검증하면 `amend(assertionStatus="verified")`, 틀렸으면 `rejected`.
- remember, link, amend, forget은 `dryRun=true`로 실행 없이 결과를 미리 볼 수 있다.

## 7. 케이스 추적(2단계 이상 작업)

- caseId 형식: `{debug|feat|incident}-{주제}-{YYYY-MM-DD}`.
- 시작: `remember(type="episode", caseId=..., goal=..., phase="planning", resolutionStatus="open", importance=0.8)`.
- 진행: 같은 caseId로 에러, 발견, 결정을 쌓고 phase를 planning, debugging, implementation, verification 순으로 바꾼다.
- 완료: 대표 파편을 `amend(resolutionStatus="resolved", outcome="...")`로 닫는다.
- 복기: `reconstruct_history(caseId=...)` 또는 `recall(caseMode=true)`.

## 8. 세션 종료

- 의미 있는 작업을 했으면 `reflect`를 부른다. 이 플러그인의 SessionEnd 훅은 최근 대화 발췌를 서버로 보내 서버가 회고를 남기지만, 핵심 결정과 해결책은 그 전에 remember로 저장되어 있어야 한다.
- reflect는 요약과 누락분 정리용이다: `reflect(summary=[...], decisions=[...], errors_resolved=["원인: X -> 해결: Y"], new_procedures=[...], open_questions=[...], narrative_summary="3~5문장", workspace=...)`.
- 배열의 각 항목은 독립적으로 이해되는 사실 1건이다. 여러 사실을 한 항목에 묶지 않는다.

## 도구 목록

권한: read 키로 쓸 수 있는 도구와 write가 필요한 도구가 나뉜다. `memory_stats`, `memory_consolidate`, `check_update`, `apply_update`는 마스터 키 세션에만 보인다.

| 도구 | 용도 |
|-|-|
| `context` | 세션 시작 핵심 기억(앵커, 고중요도 파편, 워킹 메모리) 로드 |
| `recall` | 키워드, 시맨틱, 하이브리드 검색. caseMode, depth, timeRange 필터 |
| `remember` | 원자적 파편 하나 저장 |
| `batch_remember` | 최대 200건 일괄 저장(`async: true`면 jobId 반환) |
| `batch_status` | 비동기 일괄 저장 처리 상태 조회 |
| `reflect` | 세션 요약, 결정, 해결 에러, 절차, 미해결 질문 영속화 |
| `forget` | 파편 또는 토픽 삭제 |
| `link` | 파편 사이 관계(resolved_by, caused_by, part_of, contradicts, related) 설정 |
| `amend` | 기존 파편 수정, 확인 상태와 케이스 상태 전환 |
| `tool_feedback` | 검색과 도구 결과의 유용성 피드백 |
| `graph_explore` | 인과 체인 추적 |
| `fragment_history` | 파편 변경 이력 조회 |
| `reconstruct_history` | caseId 또는 entity(topic, keywords) 단위 작업 흐름 재구성 |
| `search_traces` | 정확 매칭 탐색 |
| `get_skill_guide` | 정본 활용 가이드 전체 또는 섹션 조회 |
| `session_rotate` | 현재 세션을 같은 맥락의 새 세션으로 교체 |
| `memory_stats` | 기억 통계(마스터 키) |
| `memory_consolidate` | 기억 유지보수 실행(마스터 키) |
| `check_update` | 서버 업데이트 확인(마스터 키) |
| `apply_update` | 서버 업데이트 적용(마스터 키) |

도구가 목록에 보이지 않으면(지연 로딩 클라이언트) 서버에 없다고 단정하지 말고 `context recall remember reflect` 같은 넓은 검색어로 다시 찾는다.

## 기억 도구를 쓸 수 없을 때

`Session not found`, `Session expired`, `401`, `403`, `ECONNREFUSED`로 기억 도구가 실패해도 저장을 포기하거나 다음 세션으로 미루지 않는다.

1. 지금까지의 결정, 해결책, 새 사실을 몇 문장으로 정리해 둔다.
2. 셸에 `MEMENTO_CLI_REMOTE`, `MEMENTO_CLI_KEY`가 있으면 원격 CLI로 저장한다(키를 명령줄에 쓰지 않는다):

   ```bash
   anchormind remember "저장할 내용" --topic 프로젝트명 --type decision
   anchormind recall "검색어"
   ```

3. CLI도 쓸 수 없으면 사용자에게 한 줄로 알리고 정리한 내용을 그대로 보여 준다. curl 직접 호출 절차는 정본의 "MCP 도구 사용 불가 시 curl 직접 호출" 절에 있다(`get_skill_guide`를 섹션 없이 부르면 전체가 온다).

## 상세 참조

`get_skill_guide(section=...)`로 정본에서 필요한 섹션만 읽는다.

| 필요한 것 | 호출 |
|-|-|
| v6.0.0 핵심 변경 | `get_skill_guide(section="release")` |
| 도구별 파라미터 전체 | `get_skill_guide(section="tools")` |
| 세션 시작, 작업 중, 종료 절차 | `get_skill_guide(section="lifecycle")` |
| 키워드 작성 규칙 | `get_skill_guide(section="keywords")` |
| workspace 기입 규칙 | `get_skill_guide(section="workspace")` |
| 검색 전략 의사결정 | `get_skill_guide(section="search")` |
| 타입별 중요도 기본값과 상한 | `get_skill_guide(section="importance")` |
| 에피소드 기억 | `get_skill_guide(section="episode")` |
| 확산 활성화, 케이스 추적, 확인 상태 | `get_skill_guide(section="experiential")` |
| 유사 사례 검색(CBR) | `get_skill_guide(section="cbr")` |
| 상황별 트리거와 힌트 처리 | `get_skill_guide(section="triggers")` |
| 여러 플랫폼과 기기의 키 구성 | `get_skill_guide(section="multiplatform")` |
| 여러 에이전트의 공동 기억 | `get_skill_guide(section="collaboration")` |
| 지연 로딩 클라이언트 재검색 | `get_skill_guide(section="codex")` |
| 피해야 할 사용 방식 | `get_skill_guide(section="antipatterns")` |
