/**
 * LLM 응답에서 JSON을 robust하게 파싱하는 유틸리티
 *
 * 많은 provider가 응답을 ```json 코드 블록으로 감싸거나 앞뒤에 설명 텍스트를 추가한다.
 * MiniMax-M2.7, DeepSeek-R1, Qwen-QwQ 등 reasoning 모델은 본문 앞에 `<think>...</think>`
 * 추론 블록을 항상 포함한다. 이 블록을 사전 제거한 후 4단계 휴리스틱으로 파싱을 시도한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 */

/** reasoning 모델의 think 블록을 제거한다 (닫힘 태그 누락 시 시작 태그 이후 본문은 보존). */
function stripThinkBlocks(text) {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");
  // 닫힘 태그가 있고 시작 태그가 누락된 비대칭 케이스 (모델이 max_tokens로 잘렸다 복귀)
  if (cleaned === text) {
    const closeIdx = text.search(/<\/think>/i);
    if (closeIdx >= 0 && text.indexOf("<think>") < 0) {
      cleaned = text.slice(closeIdx + "</think>".length).trimStart();
    }
  }
  return cleaned;
}

/**
 * LLM 텍스트 응답에서 JSON을 파싱한다.
 * 처리 순서:
 *  0. <think>...</think> reasoning 블록 제거 (제거 결과로 step 1~4 재시도, 실패 시 원본 fallback)
 *  1. 직접 JSON.parse
 *  2. markdown 코드 펜스(```json ... ```) 제거 후 파싱
 *  3. 첫 `{` ~ 마지막 `}` 추출 후 파싱
 *  4. 첫 `[` ~ 마지막 `]` 추출 후 파싱 (배열 응답)
 *
 * @param {string} text - LLM 원시 텍스트 응답
 * @returns {*} 파싱된 JavaScript 값
 * @throws {Error} 모든 휴리스틱 실패 시
 */
export function parseJsonResponse(text) {
  if (!text || typeof text !== "string") {
    throw new Error("empty LLM response");
  }

  const stripped = stripThinkBlocks(text);
  const candidates = stripped !== text && stripped.length > 0 ? [stripped, text] : [text];

  for (const candidate of candidates) {
    // 1. 직접 파싱
    try { return JSON.parse(candidate); } catch {}

    // 2. markdown 코드 펜스 제거
    const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try { return JSON.parse(fenceMatch[1].trim()); } catch {}
    }

    // 3. 첫 { ~ 마지막 } 추출 (객체 응답)
    const firstBrace = candidate.indexOf("{");
    const lastBrace  = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try { return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)); } catch {}
    }

    // 4. 첫 [ ~ 마지막 ] 추출 (배열 응답)
    const firstBracket = candidate.indexOf("[");
    const lastBracket  = candidate.lastIndexOf("]");
    if (firstBracket >= 0 && lastBracket > firstBracket) {
      try { return JSON.parse(candidate.slice(firstBracket, lastBracket + 1)); } catch {}
    }
  }

  throw new Error(`failed to parse JSON from LLM response: ${text.slice(0, 200)}`);
}
