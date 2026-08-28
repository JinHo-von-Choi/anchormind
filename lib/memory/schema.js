/**
 * 저장소 스키마 이름과 표 이름
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * `const SCHEMA = "agent_memory"`가 36개 파일에 각각 선언돼 있었다. 스키마
 * 이름을 바꾸면 36곳을 함께 고쳐야 하고, 한 곳을 빠뜨리면 그 모듈만 조용히
 * 다른 스키마를 본다. 선언을 한곳으로 모은다.
 *
 * 표 이름을 상수로 함께 둔 이유는 문자열 결합을 호출부마다 반복하지 않기
 * 위해서다. 새 질의를 쓸 때 `${SCHEMA}.fragments`와 `agent_memory.fragments`
 * 중 어느 쪽이 맞는지 다시 판단할 필요가 없어진다.
 */

/** 기억 저장소 스키마. 환경 변수로 바꾸지 않는다. 마이그레이션이 이 이름에 묶여 있다. */
export const SCHEMA = "agent_memory";

/** 파편 본체 표. */
export const T_FRAGMENTS = `${SCHEMA}.fragments`;

/** 파편 간 관계 표. */
export const T_FRAGMENT_LINKS = `${SCHEMA}.fragment_links`;

/** 파편 이력 표. */
export const T_FRAGMENT_HISTORY = `${SCHEMA}.fragment_history`;

/** 보조 역질의 벡터 표. */
export const T_SYNTHETIC_QUERY = `${SCHEMA}.fragment_synthetic_query`;

/** 재시도 기록 표. */
export const T_IDEMPOTENCY = `${SCHEMA}.idempotency_records`;
