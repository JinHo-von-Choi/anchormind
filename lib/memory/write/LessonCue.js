/**
 * LessonCue - reflect 교훈(lessons) 입력 정규화와 상황 단서(cue) 등록
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * 교훈 하나는 cue(어떤 상황에 쓰는지), lesson(적용하고 확인할 수 있는 조작), evidence(근거가 된 관찰),
 * confidence(high, medium, low)로 들어온다. cue, lesson, evidence 중 하나라도 비면 저장하지 않는다.
 * 근거가 없어 교훈을 남기지 않을 때는 문자열 NO_ENTRY를 넣으며, 이는 거부가 아니라 정상 결과로 센다.
 *
 * 교훈은 procedure 파편(본문 lesson, 맥락 요약에 상황, 근거, 확신도)으로 저장하고, cue는
 * fragment_synthetic_query에 origin='cue' 행으로 넣는다(역질의 워커의 조회와 저장 문장을 그대로 쓴다). 그러면 기존 보조 벡터 검색이 지금 상황을 묻는
 * 질의를 cue에 맞춰 교훈으로 되돌린다. 행의 source_content_hash는 파편의 현재 content_hash라서
 * 본문이 바뀐 뒤의 신선도 검사도 역질의와 같다.
 */

import { generateEmbedding, prepareTextForEmbedding, EMBEDDING_ENABLED } from "../../tools/embedding.js";
import { loadSyntheticSource, storeSyntheticQuery } from "../embedding/SyntheticQueryWorker.js";
import { scanText }             from "../../security/SensitiveScanner.js";
import { sensitiveScanEffectiveMode } from "../../config.js";
import { logWarn }              from "../../logger.js";

export const NO_ENTRY = "NO_ENTRY";

/** 확신도별 파편 중요도와 사례 근거 confidence. low는 검증 전 추론으로 저장한다. */
export const LESSON_CONFIDENCE = Object.freeze({
  high  : Object.freeze({ importance: 0.8, evidenceConfidence: 1.0,  assertionStatus: "observed" }),
  medium: Object.freeze({ importance: 0.7, evidenceConfidence: 0.75, assertionStatus: "observed" }),
  low   : Object.freeze({ importance: 0.6, evidenceConfidence: 0.5,  assertionStatus: "inferred" })
});

const CUE_MAX_CHARS = 300;

const text = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * reflect lessons 입력을 정규화한다.
 *
 * @param {unknown} raw
 * @returns {{ lessons: Array<{cue: string, lesson: string, evidence: string, confidence: "high"|"medium"|"low"}>,
 *             noEntry: number, rejected: number }}
 */
export function normalizeLessons(raw) {
  const out = { lessons: [], noEntry: 0, rejected: 0 };
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item === "string" && item.trim() === NO_ENTRY) {
      out.noEntry++;
      continue;
    }
    const cue      = text(item?.cue).slice(0, CUE_MAX_CHARS);
    const lesson   = text(item?.lesson);
    const evidence = text(item?.evidence);
    if (!cue || !lesson || !evidence) {
      out.rejected++;
      continue;
    }
    const confidence = Object.hasOwn(LESSON_CONFIDENCE, item.confidence) ? item.confidence : "medium";
    out.lessons.push({ cue, lesson, evidence, confidence });
  }
  return out;
}

/**
 * 교훈 파편의 맥락 요약. 저장 관문의 민감 정보 단계가 이 필드도 검사한다.
 *
 * @param {{cue: string, evidence: string, confidence: string}} lesson
 * @returns {string}
 */
export function lessonContextSummary({ cue, evidence, confidence }) {
  return `상황: ${cue}\n근거: ${evidence}\n확신도: ${confidence}`;
}

/**
 * cue 본문에 저장 관문과 같은 민감 정보 처리를 적용한다.
 *
 * @param {string} cue
 * @returns {string}
 */
export function scrubCue(cue) {
  const mode = sensitiveScanEffectiveMode();
  return scanText(cue, mode === "off" ? { legacyOnly: true } : {}).text;
}

/**
 * 저장된 교훈 파편마다 cue 행을 넣는다. 임베딩이 꺼져 있으면 아무것도 하지 않는다.
 * 실패는 경고로 남기고 reflect 결과를 막지 않는다.
 *
 * @param {Array<{fragmentId: string, cue: string, agentId?: string}>} entries
 * @param {{ embed?: Function, load?: Function, store?: Function }} [deps]
 * @returns {Promise<number>} 넣은 행 수
 */
export async function registerLessonCues(entries, deps = {}) {
  if (!EMBEDDING_ENABLED && !deps.embed) return 0;
  const embed  = deps.embed  ?? ((t) => generateEmbedding(prepareTextForEmbedding(t, 500)));
  const load   = deps.load   ?? loadSyntheticSource;
  const store  = deps.store  ?? storeSyntheticQuery;
  let inserted = 0;
  for (const { fragmentId, cue } of entries) {
    try {
      const row = await load(fragmentId);
      if (!row) continue;
      const queryText = scrubCue(cue);
      const vector    = await embed(queryText);
      if (vector && await store(row, queryText, vector, "cue")) inserted++;
    } catch (err) {
      logWarn(`[LessonCue] cue registration failed for ${fragmentId}: ${err.message}`);
    }
  }
  return inserted;
}
