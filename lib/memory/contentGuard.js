/**
 * content 수신 길이 게이트.
 * 저장 절삭(MAX_FRAGMENT_LENGTH=300, episode 1000)과 별개로,
 * 절삭 전 대용량 페이로드 수신 자체를 차단한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-04
 */
export const MAX_CONTENT_INPUT_LENGTH = 4000;

/** 저장 본문 상한. 초과분은 폐기되고 끝에 "..."이 붙는다. episode 외 유형과 episode가 다르다. */
export const MAX_FRAGMENT_LENGTH         = 300;
export const MAX_EPISODE_FRAGMENT_LENGTH = 1000;

export function validateContentInput(content) {
  if (typeof content === "string" && content.length > MAX_CONTENT_INPUT_LENGTH) {
    const err  = new Error(`content length ${content.length} exceeds max ${MAX_CONTENT_INPUT_LENGTH}`);
    err.code   = -32602;
    throw err;
  }
}

/**
 * 서버 instructions 상단에 싣는 저장 계약. 수치는 위 상수에서 만들어 문구와 동작이 갈라지지 않게 한다.
 * 앞 줄바꿈 한 개와 뒤 빈 줄 한 개를 포함한다.
 */
export const STORAGE_CONTRACT_TEXT = `
## 저장 계약

- 파편은 1~2개의 원자적 사실이다. 본문은 ${MAX_FRAGMENT_LENGTH}자 이내(type=episode는 ${MAX_EPISODE_FRAGMENT_LENGTH}자).
- 초과분은 폐기되고 끝에 "..."이 붙는다. 응답의 content_truncated(original_length, stored_length)와 validation_warnings의 contentTruncated로 알려준다.
- 긴 내용은 통째로 넣지 말고 원자 파편 여러 개로 나눠 저장한다. 작업의 경과와 맥락은 type=episode로 저장한다.
- ${MAX_CONTENT_INPUT_LENGTH}자는 content 필드의 입력 상한이다. 이 길이에 맞춰 쓰라는 뜻이 아니다.

`;
