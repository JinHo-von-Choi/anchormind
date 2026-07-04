/**
 * content 수신 길이 게이트.
 * 저장 절삭(MAX_FRAGMENT_LENGTH=300, episode 1000)과 별개로,
 * 절삭 전 대용량 페이로드 수신 자체를 차단한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-04
 */
export const MAX_CONTENT_INPUT_LENGTH = 4000;

export function validateContentInput(content) {
  if (typeof content === "string" && content.length > MAX_CONTENT_INPUT_LENGTH) {
    const err  = new Error(`content length ${content.length} exceeds max ${MAX_CONTENT_INPUT_LENGTH}`);
    err.code   = -32602;
    throw err;
  }
}
