/**
 * LexicalCoverage - 본문 어휘 채널의 키별 채움 지표
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * content_tokens가 NULL인 현행 파편은 어휘 채널에서 빠진다. 백필 완결도를 키마다 보도록 두 게이지를 둔다.
 *   memento_lexical_tokens_coverage_ratio{key_id} 현행 파편 가운데 content_tokens를 채운 비율
 *   memento_lexical_tokens_missing{key_id}        채우지 않은 현행 파편 수
 * 마스터 파편(key_id NULL)의 라벨은 MASTER_LABEL이다.
 *
 * 값은 /metrics 수집 시점에 COVERAGE_TTL_MS가 지났을 때만 다시 센다(현행 파편 전체를 키로 묶는 집계).
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

/** 마스터 파편의 key_id 라벨 */
export const MASTER_LABEL = "master";

/** 키별 현행 파편 수와 채운 수 */
export const COVERAGE_SQL = `SELECT key_id, count(*) AS total, count(content_tokens) AS filled
     FROM ${SCHEMA}.fragments
    WHERE valid_to IS NULL
    GROUP BY key_id`;

export const lexicalCoverageRatio = new promClient.Gauge({
  name      : "memento_lexical_tokens_coverage_ratio",
  help      : "키별 현행 파편 가운데 content_tokens를 채운 비율(본문 어휘 채널 백필 완결도)",
  labelNames: ["key_id"],
  registers : [register],
  async collect() { await refreshLexicalCoverage(); }
});

export const lexicalTokensMissing = new promClient.Gauge({
  name      : "memento_lexical_tokens_missing",
  help      : "키별 content_tokens를 채우지 않은 현행 파편 수",
  labelNames: ["key_id"],
  registers : [register]
});

const state = { refreshedAt: null, pending: null };

const defaultRun = (sql, params) => queryWithAgentVector("system", sql, params);

/**
 * 집계 행을 게이지 값으로 바꾼다. 현행 파편이 없는 키는 비율 1이다.
 *
 * @param {Array<{key_id: string|null, total: number|string, filled: number|string}>} rows
 * @returns {Array<{keyId: string, ratio: number, missing: number}>}
 */
export function coverageRows(rows) {
  return rows.map(row => {
    const total  = Number(row.total)  || 0;
    const filled = Number(row.filled) || 0;
    return { keyId: row.key_id ?? MASTER_LABEL, ratio: total > 0 ? filled / total : 1, missing: total - filled };
  });
}

function setGauges(rows) {
  lexicalCoverageRatio.reset();
  lexicalTokensMissing.reset();
  for (const { keyId, ratio, missing } of rows) {
    lexicalCoverageRatio.set({ key_id: keyId }, ratio);
    lexicalTokensMissing.set({ key_id: keyId }, missing);
  }
}

async function recount(run) {
  const schema = await loadLexicalSchema(run);
  if (!schema.column) return setGauges([]);
  const { rows } = await run(COVERAGE_SQL, []);
  setGauges(coverageRows(rows));
}

/**
 * 간격이 지났으면 다시 센다. 오류는 경고로 남기고 이전 값을 둔다(지표 수집을 실패시키지 않는다).
 *
 * @param {(sql: string, params: unknown[]) => Promise<{rows: Object[]}>} [run]
 * @param {number} [now]
 * @returns {Promise<void>}
 */
export async function refreshLexicalCoverage(run = defaultRun, now = Date.now()) {
  if (!lexicalChannelEnabled()) return setGauges([]);
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
  setGauges([]);
}
