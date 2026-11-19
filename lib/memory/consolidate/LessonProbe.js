/**
 * LessonProbe - 교훈 자기 점검(LLM 없음)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-19
 *
 * 정리 주기의 lesson_probe 단계다. 하루 한 번 교훈 파편을 점검하고 결과를 memory_daily_metrics(metric=lesson_probe,
 * key_id='')의 detail에 남긴다. 파편, 접근 기록, EMA, 검색 이벤트는 바꾸지 않는다. cue를 고치지도 않는다.
 *
 *   cue 미적중   교훈의 cue 벡터(fragment_synthetic_query origin=cue)로 같은 키의 열린 파편을 찾았을 때 교훈 자신이
 *                상위 PROBE_TOP_K 안에 없다. 새 임베딩은 만들지 않고 저장된 벡터만 쓴다
 *   간섭 후보    교훈 본문 벡터와 코사인 유사도가 INTERFERENCE_SIMILARITY 이상인 다른 procedure. 내용이 서로 다른지는
 *                사람이 본다
 *   적용 안 됨   lessons_applied에서 not_applicable이 NOT_APPLICABLE_MIN 이상 쌓인 교훈. cue가 넓다는 신호다
 *
 * 벡터 차원이 맞지 않는 등 검색이 실패하면 그 항목만 비우고 오류를 detail.errors에 적는다.
 */

import { queryWithAgentVector } from "../../tools/db.js";
import { SCHEMA }               from "../schema.js";
import { lessonPredicateSql }   from "../write/LessonSummary.js";
import { logWarn }              from "../../logger.js";

/** cue 검색에서 교훈이 들어야 하는 상위 순위 */
export const PROBE_TOP_K = 5;

/** 벡터 색인에서 먼저 꺼내는 이웃 수. 키와 유효성 조건은 그 뒤에 건다. */
const NEIGHBOR_POOL = 40;

/** 간섭 후보로 보는 코사인 유사도 하한 */
export const INTERFERENCE_SIMILARITY = 0.9;

/** 적용 안 됨으로 보고하는 not_applicable 수 하한 */
export const NOT_APPLICABLE_MIN = 2;

/** detail 목록 하나의 상한 */
const DETAIL_MAX = 50;

/** 점검 결과 지표 이름 */
export const LESSON_PROBE_METRIC = "lesson_probe";

const CUE_MISS_SQL = `
  SELECT q.fragment_id AS id,
         (q.fragment_id = ANY(ARRAY(
            SELECT c.id FROM (
              SELECT g.id, g.key_id, g.valid_to
                FROM ${SCHEMA}.fragments g
               WHERE g.embedding IS NOT NULL
               ORDER BY g.embedding <=> q.embedding
               LIMIT ${NEIGHBOR_POOL}
            ) c
            WHERE c.valid_to IS NULL AND c.key_id IS NOT DISTINCT FROM f.key_id
            LIMIT ${PROBE_TOP_K}
         ))) AS hit
    FROM ${SCHEMA}.fragment_synthetic_query q
    JOIN ${SCHEMA}.fragments f ON f.id = q.fragment_id
   WHERE q.origin = 'cue' AND q.embedding IS NOT NULL AND f.valid_to IS NULL`;

const INTERFERENCE_SQL = `
  SELECT f.id AS lesson_id, n.id AS other_id, round((1 - n.dist)::numeric, 3)::float8 AS similarity
    FROM ${SCHEMA}.fragments f
    CROSS JOIN LATERAL (
      SELECT c.id, c.dist FROM (
        SELECT g.id, g.type, g.key_id, g.valid_to, g.embedding <=> f.embedding AS dist
          FROM ${SCHEMA}.fragments g
         WHERE g.embedding IS NOT NULL
         ORDER BY g.embedding <=> f.embedding
         LIMIT ${NEIGHBOR_POOL}
      ) c
      WHERE c.id <> f.id AND c.valid_to IS NULL AND c.type = 'procedure'
        AND c.key_id IS NOT DISTINCT FROM f.key_id AND 1 - c.dist >= $1
      LIMIT 3
    ) n
   WHERE f.valid_to IS NULL AND f.embedding IS NOT NULL AND ${lessonPredicateSql("f")}`;

const NOT_APPLICABLE_SQL = `
  SELECT lesson_id AS id, count(*)::int AS n
    FROM ${SCHEMA}.lesson_outcomes
   WHERE outcome = 'not_applicable'
   GROUP BY lesson_id
  HAVING count(*) >= $1
   ORDER BY n DESC
   LIMIT ${DETAIL_MAX}`;

/**
 * 오늘(UTC) 날짜.
 *
 * @param {Date} [now]
 * @returns {string}
 */
function utcToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * 교훈 점검을 실행하고 결과를 쓴다. 오늘 이미 실행했으면 건너뛴다.
 *
 * @param {{query?: Function, today?: string, force?: boolean}} [options]
 * @returns {Promise<{status: string, affected: number, reason?: string}>}
 */
export async function runLessonProbe({
  query = (sql, params, opts) => queryWithAgentVector("system", sql, params, opts),
  today = utcToday(),
  force = false
} = {}) {
  if (!force) {
    const { rows } = await query(
      `SELECT 1 FROM ${SCHEMA}.memory_daily_metrics WHERE day = $1::date AND key_id = '' AND metric = $2`,
      [today, LESSON_PROBE_METRIC]
    );
    if (rows.length > 0) return { status: "skipped", affected: 0, reason: "already_ran_today" };
  }

  const errors = [];
  const attempt = async (name, sql, params) => {
    try { return (await query(sql, params)).rows; }
    catch (err) { errors.push({ check: name, error: err.message }); logWarn(`[LessonProbe] ${name} failed: ${err.message}`); return []; }
  };

  const cueRows      = await attempt("cue_miss", CUE_MISS_SQL, []);
  const interference = await attempt("interference", INTERFERENCE_SQL, [INTERFERENCE_SIMILARITY]);
  const notApplied   = await attempt("not_applicable", NOT_APPLICABLE_SQL, [NOT_APPLICABLE_MIN]);

  const missed = cueRows.filter(r => r.hit !== true).map(r => r.id);
  const detail = {
    cue_missed    : missed.slice(0, DETAIL_MAX),
    interference  : interference.slice(0, DETAIL_MAX).map(r => [r.lesson_id, r.other_id, r.similarity]),
    not_applicable: notApplied,
    ...(errors.length > 0 ? { errors } : {})
  };
  const probed = cueRows.length;
  await query(
    `INSERT INTO ${SCHEMA}.memory_daily_metrics (day, key_id, metric, value, numerator, denominator, detail)
     VALUES ($1::date, '', $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (day, key_id, metric) DO UPDATE
       SET value = EXCLUDED.value, numerator = EXCLUDED.numerator, denominator = EXCLUDED.denominator,
           detail = EXCLUDED.detail, computed_at = NOW()`,
    [today, LESSON_PROBE_METRIC, probed > 0 ? (probed - missed.length) / probed : null, probed - missed.length, probed, JSON.stringify(detail)],
    "write"
  );
  return { status: "ok", affected: missed.length + interference.length + notApplied.length };
}
