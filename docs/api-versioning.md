# API와 export 형식 버전 정책

작성자: 최진호
작성일: 2026-10-03

이 문서는 서버가 외부에 내놓는 표면(MCP 프로토콜, 도구 스키마, 관리 REST API, 데이터베이스 스키마, export 파일)이 버전 사이에서 어떻게 호환되는지 정한다. 영문판은 [api-versioning.en.md](api-versioning.en.md)다.

## 적용 범위

| 대상 | 버전 표기 | 호환 규칙 |
|-|-|-|
| MCP 프로토콜 | 규격 개정 날짜(예: `2025-11-25`) | 지원 개정 목록은 `lib/protocol-versions.js`. 개정 제거는 MCP 규격의 폐기 대장이 그 개정을 폐기로 표시한 뒤에만 한다 |
| 도구 스키마 | `package.json`의 주 버전 | 같은 주 버전 안에서는 추가만 한다 |
| 관리 REST API | `package.json`의 주 버전 | 호환되지 않는 변경은 `Deprecation` 헤더와 6개월 유예를 거친다 |
| 데이터베이스 스키마 | 마이그레이션 번호 | 확장 후 축소(expand/contract). 확장 단계는 직전 서버 버전(N-1)과 호환된다 |
| export 파일 | 형식 버전(정수) | 읽기는 현재 버전과 직전 버전 두 개를 유지한다 |

## MCP 프로토콜

`initialize`에서 클라이언트가 제안한 개정이 지원 목록에 있으면 그 개정으로 협상한다. 목록에 없으면 제안한 값 이하 중 가장 새로운 지원 개정으로, 그런 개정이 없으면 목록에서 가장 오래된 개정으로 협상한다. 협상 결과는 항상 지원 목록의 한 항목이다. 새 개정을 지원 목록에 추가하는 것은 하위 호환 변경이며, 개정을 목록에서 빼는 것은 규격의 폐기 대장에 올랐을 때만 한다.

## 도구 스키마

같은 주 버전 안에서 허용하는 변경은 다음이다.

- 선택 매개변수 추가
- 응답 필드 추가
- 새 도구 추가
- 설명 문구 보완

다음은 다음 주 버전에서만 한다.

- 필수 매개변수 추가
- 매개변수나 응답 필드의 제거, 이름 변경, 의미 변경
- 도구 이름 변경이나 제거

응답을 읽는 쪽은 알 수 없는 필드를 무시해야 한다.

## 관리 REST API

경로는 `/v1/internal/model/nothing/...`다. 필드나 선택 매개변수를 추가하는 변경에는 유예가 없다. 기존 응답 필드의 제거, 의미 변경, 필수 매개변수 추가처럼 기존 호출자를 깨는 변경은 다음 절차를 따른다.

1. 변경 공지일부터 최소 6개월 동안 기존 동작을 유지한다.
2. 그 기간 동안 영향을 받는 응답에 `Deprecation` 헤더를 싣고, 폐기 예정일을 `Sunset` 헤더로 알린다.
3. 유예가 끝난 뒤의 첫 주 버전에서 기존 동작을 제거한다.

## 데이터베이스 스키마

마이그레이션은 확장 후 축소(expand/contract)로 나눈다.

| 단계 | 허용 변경 | 조건 |
|-|-|-|
| 확장 | nullable 열 추가, 새 표, 새 색인, NOT VALID 제약 | 직전 서버 버전(N-1)이 그대로 동작해야 한다. 한 릴리스 안에서 적용한다 |
| 축소 | 열 제거, 제약 강화, 표 제거 | 모든 서버가 확장 단계를 포함한 버전 이상일 때만, 확장 단계와 다른 릴리스에서 적용한다 |

파일 규약과 대형 표의 색인 절차는 [마이그레이션 규약](migration-conventions.md)과 [온라인 마이그레이션](operations/online-migration.md)을 따른다.

## export 파일 형식

### 버전

| 버전 | 구조 | 읽기 | 쓰기 |
|-|-|-|-|
| 2 | 머리 줄, 파편 줄, 링크 줄, 선택 이력 줄, 끝 줄 | 예 | 기본 |
| 1 | 머리 줄 없는 파편 줄 17열 | 예. 2027-10-03 이전에는 읽기를 끊지 않는다 | 요청 시 |

읽기는 현재 버전과 직전 버전 두 개를 유지한다. 새 형식 버전이 나오면 그보다 두 단계 이전 버전의 읽기는 끊을 수 있고, 끊기 전에 이 표의 기한을 갱신해 공지한다. 읽을 수 없는 버전의 머리 줄은 아무것도 기록하기 전에 거부한다(관리 API는 400 `unsupported_format_version`, CLI는 종료 코드 1).

버전 1 파일을 가져오면 응답의 `format`에 `deprecated: true`와 `accepted_until`이 실린다.

### 버전 2 기록

한 줄이 기록 하나이며 `record` 필드가 종류를 정한다. `record`가 없는 객체는 파편(버전 1 줄)으로 읽는다.

| record | 내용 |
|-|-|
| `header` | `format`(`memento-fragments`), `version`, `schema_migration`(내보낸 서버의 마지막 마이그레이션 번호), `exported_at`, `scope`(내보내기 조건), `includes`(포함한 줄 종류) |
| `fragment` | 파편의 전 열(아래 목록) |
| `link` | `from_id`, `to_id`, `relation_type`, `created_at`, `weight`, `confidence`, `decay_rate`, `quarantine_state`. 양 끝이 모두 내보낸 파편이고 삭제되지 않은 링크만 싣는다 |
| `version` | 파편 수정 이력(`fragment_versions`). 요청했을 때만 싣는다 |
| `end` | `counts`: 종류별 줄 수. 가져오기가 읽은 수와 대조해 잘린 파일을 알린다 |

파편 줄의 열: `id`, `content`, `content_hash`, `topic`, `type`, `keywords`, `importance`, `source`, `agent_id`, `key_id`, `is_anchor`, `ttl_tier`, `estimated_tokens`, `created_at`, `valid_from`, `valid_to`, `accessed_at`, `access_count`, `verified_at`, `utility_score`, `case_id`, `goal`, `outcome`, `phase`, `resolution_status`, `assertion_status`, `context_summary`, `session_id`, `workspace`, `workspace_source`, `idempotency_key`, `affect`, `validation_warnings`, `quality_verified`, `quality_rationale`.

싣지 않는 열: `embedding`(대상 서버가 다시 만든다), `linked_to`(링크 줄에서 다시 만들어진다), `ema_activation`, `ema_last_updated`, `last_decay_at`, `morpheme_indexed`, `split_attempt_failed_at`, `workspace_inferred`, `inference_confidence`, `backfill_batch_id`(서버 내부 상태). 만료로 닫힌 행(`valid_to`가 있는 행)은 내보내지 않는다.

### 협상과 다운그레이드

내보내기 형식 버전은 다음 순서로 정한다.

1. 명시한 값: 관리 API `format_version` 질의 매개변수, CLI `--format-version`
2. `Accept` 헤더의 `version` 매개변수(예: `application/x-ndjson; version=1`)
3. 현재 버전

읽을 수 없는 버전은 관리 API가 406과 지원 목록을 돌려주고, CLI는 종료 코드 1이다. 응답에는 실제 버전을 알리는 `X-Memento-Export-Format-Version`과 `Vary: Accept`가 실린다.

낮은 버전을 고르면(다운그레이드) 그 버전의 구조로 내보낸다. 버전 1로 내려가면 파편 17열만 싣고 머리 줄, 끝 줄, 링크, 이력, `key_id`, `workspace`, `context_summary`, `content_hash` 등 버전 2 열은 빠진다. 다운그레이드한 파일에는 빠진 정보가 되돌아오지 않는다. 높은 버전의 파일을 낮은 버전만 읽는 서버에 가져오면 거부하며, 같은 버전 안에서 알 수 없는 필드는 무시한다.

### 가져오기 규칙

| 항목 | 규칙 |
|-|-|
| 대상 키 | 기록 키는 호출자가 정한다(관리 API `key_id` 질의 매개변수, CLI `--key`). 없으면 마스터 범위(`key_id` NULL)다. 파일 행의 `key_id`는 읽지 않으며 무시한 수를 `ignored.key_id`로 센다 |
| 앵커 | `is_anchor`는 소유자 경로(관리 API, 서버 호스트의 CLI)에서만 파일 값을 따른다. 그 밖의 경로는 무시하고 `ignored.is_anchor`로 센다 |
| 쓰기 관문 | 모든 파편 줄은 의미 쓰기 관문(민감 정보 마스킹, 저장 길이 절삭, 최소 품질, 정책 판정, workspace 허가)을 거쳐 기록한다 |
| 보통 가져오기 | 관문이 본문을 바꾸거나 거부한다. 바뀐 행은 응답의 `transformed`로 센다. importance는 유형별 상한을 적용하고 `ttl_tier`는 `warm`으로 둔다 |
| 되살리기(`restore=trusted`, `--restore`) | 소유자 경로에서 형식 버전 2 파일에만 쓸 수 있다. 최소 품질 검사와 저장 길이 절삭을 건너뛰고 `importance`, `ttl_tier`, `workspace_source`를 파일 값 그대로 기록한다. 민감 정보 마스킹은 그대로 적용한다. 관리 API와 CLI는 감사 로그에 한 줄을 남긴다 |
| 시각 | `created_at`과 `valid_from`은 파일 값을 쓴다. 해석할 수 없거나 내일 이후의 값은 무시하고 서버 시각을 쓴다 |
| 초기화되는 열 | `access_count`, `accessed_at`, `verified_at`, `utility_score`는 가져온 시점의 서버 값이 된다. 임베딩은 다시 만들고(관리 API는 임베딩 큐에 올린다), `linked_to`는 링크 줄에서 다시 만든다 |
| 순서 | 링크와 이력은 파편 줄 뒤에 와야 한다. 링크는 양 끝 파편이 같은 실행에서 처리된 경우에만 기록한다 |
| dryRun | 같은 경로로 처리하고 끝에 트랜잭션을 되돌린다. 집계는 실제 실행과 같다 |

집계는 imported(새로 기록), duplicates(같은 본문이 이미 있음), rejected(유형이 있는 사유), errors(행 문제가 아닌 실패)로 나뉘며 한 행은 하나에만 들어간다. 응답 형식은 [API 레퍼런스](api-reference.md)의 가져오기 절을 따른다.

### 왕복 성질

저장 규칙(마스킹, 유형별 길이 상한, 최소 품질)을 이미 지킨 행은 내보낸 뒤 빈 데이터베이스에 가져와도 `content_hash`, 열 값, 링크가 같다. 보통 가져오기는 이 성질을 보장하지 않는 행(길이 상한을 넘기거나 최소 품질에 못 미치는 기존 행)을 `transformed`나 `rejected`로 드러낸다. 그런 행까지 저장된 값 그대로 되살려야 하면 소유자 경로에서 되살리기를 쓴다.
