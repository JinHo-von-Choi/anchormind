/**
 * LexicalCoverage - 본문 어휘 채널의 채움 지표
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 * 수정일: 2026-10-04 (키 라벨 없이 전체 집계)
 *
 * content_tokens가 NULL인 현행 파편은 어휘 채널에서 빠진다. 백필 완결도를 보도록 두 게이지를 둔다(라벨 없음,
 * 지표에 키 식별자를 싣지 않는다).
 *   memento_lexical_tokens_coverage_ratio 현행 파편 가운데 content_tokens를 채운 비율
 *   memento_lexical_tokens_missing        채우지 않은 현행 파편 수(백필 뒤 남은 NULL 행 포함)
 * 키별 수는 scripts/backfill-content-tokens.mjs 미리보기로 본다.
 *
 * 값은 /metrics 수집 시점에 COVERAGE_TTL_MS가 지났을 때만 다시 센다(현행 파편 전체 집계).
 * 스위치가 off이거나 열이 없으면 세지 않고 게이지를 비운다.
 */

import promClient                  from "prom-client";
import { register }                from "../metrics.js";
import { queryWithAgentVector }    from "../tools/db.js";
import { lexicalChannelEnabled }   from "../config.js";
import { logWarn }                 from "../logger.js";
import { SCHEMA }                  from "./schema.js";
import { loadLexicalSchema }       from "./LexicalSchema.js";

/** 다시 세기까지의 간격(ms) */
export const COVERAGE_TTL_MS = 10 * 60_000;

/** 현행 파편 수와 채운 수 */
export const COVERAGE_SQL = `SELECT count(*) AS total, count(content_tokens) AS filled
     FROM ${SCHEMA}.fragments
    WHERE valid_to IS NULL`;

export const lexicalCoverageRatio = new promClient.Gauge({
  name     : "memento_lexical_tokens_coverage_ratio",
  help     : "현행 파편 가운데 content_tokens를 채운 비율(본문 어휘 채널 백필 완결도)",
  registers: [register],
  async collect() { await refreshLexicalCoverage(); }
});

export const lexicalTokensMissing = new promClient.Gauge({
  name     : "memento_lexical_tokens_missing",
  help     : "content_tokens를 채우지 않은 현행 파편 수",
  registers: [register]
});

const state = { refreshedAt: null, pending: null };

const defaultRun = (sql, params) => queryWithAgentVector("system", sql, params);

/**
 * 집계 행을 게이지 값으로 바꾼다. 현행 파편이 없으면 비율 1이다.
 *
 * @param {{total: number|string, filled: number|string}|undefined} row
 * @returns {{ratio: number, missing: number}}
 */
export function coverageValues(row) {
  const total  = Number(row?.total)  || 0;
  const filled = Number(row?.filled) || 0;
  return { ratio: total > 0 ? filled / total : 1, missing: total - filled };
}

/** 값을 쓰거나(null이면) 게이지를 비운다. */
function setGauges(values) {
  lexicalCoverageRatio.reset();
  lexicalTokensMissing.reset();
  if (!values) return;
  lexicalCoverageRatio.set(values.ratio);
  lexicalTokensMissing.set(values.missing);
}

async function recount(run) {
  const schema = await loadLexicalSchema(run);
  if (!schema.column) return setGauges(null);
  const { rows } = await run(COVERAGE_SQL, []);
  setGauges(coverageValues(rows[0]));
}

/**
 * 간격이 지났으면 다시 센다. 오류는 경고로 남기고 이전 값을 둔다(지표 수집을 실패시키지 않는다).
 *
 * @param {(sql: string, params: unknown[]) => Promise<{rows: Object[]}>} [run]
 * @param {number} [now]
 * @returns {Promise<void>}
 */
export async function refreshLexicalCoverage(run = defaultRun, now = Date.now()) {
  if (!lexicalChannelEnabled()) return setGauges(null);
  if (state.refreshedAt !== null && now - state.refreshedAt < COVERAGE_TTL_MS) return undefined;
  if (!state.pending) {
    state.pending = recount(run)
      .then(() => { state.refreshedAt = now; })
      .catch(err => logWarn(`[LexicalCoverage] 키별 채움 집계 실패(${err.code ?? "no code"}): ${err.message}`))
      .finally(() => { state.pending = null; });
  }
  return state.pending;
}

/** 갱신 시각과 게이지를 지운다(시험용). */
export function resetLexicalCoverage() {
  state.refreshedAt = null;
  state.pending     = null;
  setGauges(null);
}
