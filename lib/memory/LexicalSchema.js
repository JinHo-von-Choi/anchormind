/**
 * LexicalSchema - 본문 어휘 채널의 스키마 상태
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * content_tokens 열(마이그레이션 053)과 그 열의 GIN 색인 상태를 카탈로그에서 읽는다. 색인은 이름이
 * 아니라 정의로 찾는다: fragments 표의 술어 없는 GIN 색인 가운데 첫 키 열이 content_tokens인 것.
 * 운영 색인 절차(scripts/ops/online-index.mjs)가 만든 idx_fragments_content_tokens가 기본이고,
 * 다른 이름으로 같은 정의를 가진 설치도 같게 다룬다.
 *
 * 상태는 프로세스마다 LEXICAL_SCHEMA_TTL_MS 동안 기억한다. 색인 생성, 백필, 마이그레이션을 실행 중에
 * 적용해도 재시작 없이 다음 확인에서 반영된다.
 *
 * 채널 참여 규칙
 *   열 없음         : 참여하지 않고 저장 경로도 열을 쓰지 않는다
 *   색인 무효       : 참여하지 않는다(색인을 만드는 중이거나 실패한 상태). 저장 경로는 열을 쓴다
 *   색인 없음       : 참여한다(대상 범위를 키, workspace 조건으로 좁힌 순차 검사)
 *   유효한 색인 있음 : 참여한다
 * 참여하지 않거나 색인이 없는 상태는 상태마다 경고를 한 번 남긴다.
 */

import { SCHEMA }  from "./schema.js";
import { logWarn } from "../logger.js";

/** 상태를 다시 읽기까지의 간격(ms) */
export const LEXICAL_SCHEMA_TTL_MS = 60_000;

/** 어휘 채널 열 이름 */
export const LEXICAL_COLUMN = "content_tokens";

/** 열 존재와 GIN 색인(이름, 유효 여부)을 한 번에 읽는다. $1은 스키마를 붙인 표 이름이다. */
export const LEXICAL_SCHEMA_SQL = `
  SELECT EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = to_regclass($1) AND a.attname = '${LEXICAL_COLUMN}'
              AND a.attnum > 0 AND NOT a.attisdropped
         ) AS column_present,
         COALESCE((
           SELECT json_agg(json_build_object('name', c.relname, 'valid', i.indisvalid) ORDER BY c.relname)
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_am am   ON am.oid = c.relam
            WHERE i.indrelid = to_regclass($1)
              AND am.amname = 'gin'
              AND i.indpred IS NULL
              AND EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0] AND a.attname = '${LEXICAL_COLUMN}')
         ), '[]'::json) AS indexes`;

/** 참여 판정 사유 */
export const LEXICAL_REASONS = Object.freeze({
  READY         : "ready",
  COLUMN_MISSING: "column_missing",
  INDEX_INVALID : "index_invalid",
  INDEX_ABSENT  : "index_absent"
});

const WARNINGS = Object.freeze({
  [LEXICAL_REASONS.COLUMN_MISSING]: "[LexicalSchema] fragments.content_tokens 열이 없어 어휘 채널이 참여하지 않고 저장 경로도 토큰을 기록하지 않는다(마이그레이션 053 적용 필요)",
  [LEXICAL_REASONS.INDEX_INVALID] : "[LexicalSchema] content_tokens GIN 색인이 무효 상태여서 어휘 채널이 참여하지 않는다(scripts/ops/online-index.mjs로 다시 만든다)",
  [LEXICAL_REASONS.INDEX_ABSENT]  : "[LexicalSchema] content_tokens GIN 색인이 없어 어휘 채널이 색인 없이 검색한다(scripts/ops/online-index.mjs --index idx_fragments_content_tokens)"
});

const state = { value: null, checkedAt: 0, pending: null, warned: new Set() };

/**
 * 카탈로그 행을 상태로 바꾼다.
 *
 * @param {{column_present?: boolean, indexes?: Array<{name: string, valid: boolean}>|string|null}|undefined} row
 * @returns {{column: boolean, index: "valid"|"invalid"|"absent", indexNames: string[]}}
 */
export function evaluateLexicalSchema(row) {
  const raw     = typeof row?.indexes === "string" ? JSON.parse(row.indexes) : row?.indexes;
  const indexes = Array.isArray(raw) ? raw : [];
  let index     = "absent";
  if (indexes.some(entry => entry?.valid === true)) index = "valid";
  else if (indexes.length > 0)                      index = "invalid";
  return { column: row?.column_present === true, index, indexNames: indexes.map(entry => String(entry?.name)) };
}

/**
 * 상태에서 검색 채널 참여 여부와 사유를 정한다.
 *
 * @param {{column: boolean, index: string}} schema
 * @returns {{participates: boolean, reason: string}}
 */
export function lexicalParticipation(schema) {
  if (!schema.column)              return { participates: false, reason: LEXICAL_REASONS.COLUMN_MISSING };
  if (schema.index === "invalid")  return { participates: false, reason: LEXICAL_REASONS.INDEX_INVALID };
  if (schema.index === "absent")   return { participates: true,  reason: LEXICAL_REASONS.INDEX_ABSENT };
  return { participates: true, reason: LEXICAL_REASONS.READY };
}

/**
 * 사유에 맞는 경고를 프로세스에서 한 번만 남긴다. 준비 상태는 경고하지 않는다.
 *
 * @param {string} reason
 */
export function warnLexicalOnce(reason) {
  if (!WARNINGS[reason] || state.warned.has(reason)) return;
  state.warned.add(reason);
  logWarn(WARNINGS[reason]);
}

/**
 * 스키마 상태를 읽는다. 기억한 값이 LEXICAL_SCHEMA_TTL_MS 안이면 그대로 쓰고, 같은 시점의 동시 요청은
 * 한 번의 조회를 나눠 쓴다. 조회 오류는 그대로 던진다.
 *
 * @param {(sql: string, params: unknown[]) => Promise<{rows: Object[]}>} run
 * @param {number} [now]
 * @returns {Promise<{column: boolean, index: string, indexNames: string[]}>}
 */
export async function loadLexicalSchema(run, now = Date.now()) {
  if (state.value && now - state.checkedAt < LEXICAL_SCHEMA_TTL_MS) return state.value;
  if (!state.pending) {
    state.pending = run(LEXICAL_SCHEMA_SQL, [`${SCHEMA}.fragments`])
      .then(result => {
        state.value     = evaluateLexicalSchema(result?.rows?.[0]);
        state.checkedAt = now;
        return state.value;
      })
      .finally(() => { state.pending = null; });
  }
  return state.pending;
}

/** 기억한 상태와 경고 기록을 지운다(시험과 운영 단계 직후 확인용). */
export function resetLexicalSchema() {
  state.value     = null;
  state.checkedAt = 0;
  state.pending   = null;
  state.warned.clear();
}
