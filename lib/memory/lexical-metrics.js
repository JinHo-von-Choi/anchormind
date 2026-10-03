/**
 * 본문 어휘 채널 계수기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 *   memento_lexical_channel_skipped_total{reason}   어휘 질의를 그 요청에서 뺀 횟수
 *     timeout : 질의 시간 상한(MEMENTO_LEXICAL_TIMEOUT_MS) 초과(57014)
 *     error   : 그 밖의 조회 오류
 *   memento_lexical_tokenize_skipped_total{reason}  저장 경로가 content_tokens를 채우지 못한 횟수
 *     long_run    : 공백 없이 이어진 한글, 한자, 가나 연속이 상한을 넘는 본문(NULL로 저장)
 *     probe_error : 열 확인 질의 실패(열을 쓰지 않고 저장)
 */

import promClient   from "prom-client";
import { register } from "../metrics.js";

export const lexicalChannelSkippedTotal = new promClient.Counter({
  name      : "memento_lexical_channel_skipped_total",
  help      : "본문 어휘 질의를 그 요청에서 뺀 횟수(reason: timeout, error)",
  labelNames: ["reason"],
  registers : [register]
});

export const lexicalTokenizeSkippedTotal = new promClient.Counter({
  name      : "memento_lexical_tokenize_skipped_total",
  help      : "저장 경로가 content_tokens를 채우지 못한 횟수(reason: long_run, probe_error)",
  labelNames: ["reason"],
  registers : [register]
});

/**
 * @param {"timeout"|"error"} reason
 */
export function recordLexicalChannelSkipped(reason) {
  lexicalChannelSkippedTotal.inc({ reason });
}

/**
 * @param {"long_run"|"probe_error"} reason
 */
export function recordLexicalTokenizeSkipped(reason) {
  lexicalTokenizeSkippedTotal.inc({ reason });
}
