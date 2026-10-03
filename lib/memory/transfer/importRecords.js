/**
 * importRecords - 가져오기 입력을 기록 스트림으로 바꾸는 어댑터
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 텍스트 줄(JSON Lines)과 JSON 본문을 같은 모양의 기록 스트림으로 맞춘다. DB에 닿지 않는
 * 순수 함수라 관리 처리기가 가져오기 실행기를 불러오기 전에 입력을 읽을 수 있다.
 */

import { RECORD, FORMAT_NAME, CURRENT_VERSION, classifyRecord } from "./exportFormat.js";

/**
 * 텍스트 줄 스트림을 기록 스트림으로 바꾼다. 빈 줄은 건너뛰고 줄 번호는 입력 기준이다.
 *
 * @param {AsyncIterable<string>|Iterable<string>} lines
 * @returns {AsyncGenerator<Object>}
 */
export async function* recordsFromLines(lines) {
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    const text = typeof line === "string" ? line.trim() : "";
    if (text) yield { lineNo, ...classifyRecord(text) };
  }
}

/**
 * JSON 본문 {fragments, links?, versions?, header?}을 기록 스트림으로 바꾼다. header가 없으면 파일이
 * 아니라 버전 2 구조의 요청 본문으로 본다(synthetic 머리 줄).
 *
 * @param {Object} body
 * @returns {Generator<Object>}
 */
export function* recordsFromJsonBody(body) {
  let lineNo = 0;
  const links    = Array.isArray(body.links) ? body.links : [];
  const versions = Array.isArray(body.versions) ? body.versions : [];
  const asRecord = (item, kind) => (typeof item === "object" && item !== null && !Array.isArray(item))
    ? { ...item, record: kind }
    : item;

  if (body.header !== undefined) {
    yield { lineNo: ++lineNo, ...classifyRecord(asRecord(body.header, RECORD.HEADER)) };
  } else {
    /** 파일이 아닌 JSON 본문이다. 버전 2 구조로 읽되 끝 줄을 기대하지 않고 버전 1 폐지 표시도 붙이지 않는다. */
    yield { lineNo: 0, ...classifyRecord({ record: RECORD.HEADER, format: FORMAT_NAME, version: CURRENT_VERSION, synthetic: true }) };
  }
  for (const item of body.fragments ?? []) yield { lineNo: ++lineNo, ...classifyRecord(item) };
  for (const item of links)    yield { lineNo: ++lineNo, ...classifyRecord(asRecord(item, RECORD.LINK)) };
  for (const item of versions) yield { lineNo: ++lineNo, ...classifyRecord(asRecord(item, RECORD.VERSION)) };
}
