/**
 * TopicResolver - topic 필터 0건 시 근접 topic 후보 제안
 *
 * 작성자: 최진호
 * 작성일: 2026-08-06
 *
 * topic은 L1/L2/L3/Temporal 전 계층에서 정확일치로 평가되므로 오기 한 글자에도
 * 전 계층이 동시에 0건이 된다. 본 모듈은 필터 의미를 바꾸지 않고, 키 스코프 내
 * 실제 topic 분포를 집계하여 형태소 임베딩 코사인 유사도 상위 후보만 되돌려준다.
 *
 * 실패(pool 부재, 쿼리 오류, 임베딩 오류)는 전부 삼켜 빈 배열로 강등한다.
 * 제안은 advisory 신호이므로 recall 본류를 실패시키지 않는다.
 */

import { getPrimaryPool }   from "../../tools/db.js";
import { keyScopeClause }   from "../keyScope.js";
import { MorphemeIndex }    from "../embedding/MorphemeIndex.js";
import { cosineSimilarity } from "../../tools/embedding.js";
import { SCHEMA } from "../schema.js";

/** 유사도 평가 대상으로 끌어올 topic 집계 상한.
 *  파편 수 상위만 자르면 소규모 topic이 오기 후보에서 빠지므로 넓게 잡는다
 *  (운영 실측 distinct topic 수백 규모). */
const CANDIDATE_POOL_SIZE = 500;

/** 형태소 벡터 평가를 수행할 후보 상한(파편 수 내림차순 선두).
 *  나머지 후보는 비용이 0에 가까운 어휘 겹침으로만 평가한다. */
const VECTOR_EVAL_LIMIT   = 50;

/** 이 값 미만의 코사인 유사도는 오기 후보로 보지 않는다 */
const MIN_SIMILARITY      = 0.5;

/**
 * 키 스코프 내 topic 분포를 파편 수 내림차순으로 집계한다.
 *
 * @param {Object}      pool        - pg Pool 호환 객체
 * @param {Object}      scope
 * @param {string|null} scope.keyId
 * @param {string[]}    [scope.groupKeyIds]
 * @param {string}      wrongTopic  - 집계에서 제외할 입력 topic
 * @returns {Promise<Array<{topic: string, count: number}>>}
 */
async function aggregateTopics(pool, scope, wrongTopic) {
  const params    = [wrongTopic];
  const keyClause = keyScopeClause(params, "key_id", {
    keyId      : scope.keyId ?? null,
    groupKeyIds: scope.groupKeyIds
  });

  const result = await pool.query(
    `SELECT topic, COUNT(*)::int AS count
       FROM ${SCHEMA}.fragments
      WHERE valid_to IS NULL
        AND topic IS NOT NULL
        AND topic <> $1${keyClause}
      GROUP BY topic
      ORDER BY count DESC
      LIMIT ${CANDIDATE_POOL_SIZE}`,
    params
  );

  return (result?.rows ?? [])
    .filter(row => row && row.topic)
    .map(row => ({ topic: String(row.topic), count: Number(row.count) || 0 }));
}

/**
 * 하이픈 토큰 겹침 기반 어휘 유사도 (0~1).
 * 완전 부분문자열 포함은 0.75, 그 외에는 공유 토큰 수 / max(토큰 수).
 * 임베딩이 없거나(사전 NULL 캐시 등) 코사인이 임계 미달인 근접 topic을
 * 놓치지 않기 위한 보조 신호다.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function lexicalScore(a, b) {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1;
  if (la.includes(lb) || lb.includes(la)) return 0.75;

  const ta = la.split("-").filter(Boolean);
  const tb = new Set(lb.split("-").filter(Boolean));
  if (ta.length === 0 || tb.size === 0) return 0;

  const shared = ta.filter(token => tb.has(token)).length;
  return shared / Math.max(ta.length, tb.size);
}

/**
 * 후보를 형태소 임베딩 코사인과 어휘 토큰 겹침의 합집합으로 랭킹한다.
 * 코사인 임계 통과 후보를 앞에 두고, 벡터 부재·임계 미달이지만 어휘로 근접한
 * 후보를 (어휘 점수, 파편 수) 순으로 뒤에 잇는다.
 *
 * @param {string} wrongTopic
 * @param {Array<{topic: string, count: number}>} candidates
 * @returns {Promise<Array<{topic: string, count: number, similarity: number|null}>>}
 */
async function rankBySimilarity(wrongTopic, candidates) {
  const index        = new MorphemeIndex();
  const targetVector = await index.textToMorphemeVector(wrongTopic).catch(() => null);

  const scored  = [];
  const lexical = [];

  for (const [rank, candidate] of candidates.entries()) {
    if (targetVector && rank < VECTOR_EVAL_LIMIT) {
      const vector = await index.textToMorphemeVector(candidate.topic).catch(() => null);
      if (vector) {
        let similarity;
        try {
          similarity = cosineSimilarity(targetVector, vector);
        } catch {
          similarity = null;
        }
        if (similarity !== null && similarity >= MIN_SIMILARITY) {
          scored.push({ ...candidate, similarity });
          continue;
        }
      }
    }

    const lex = lexicalScore(wrongTopic, candidate.topic);
    if (lex > 0) {
      lexical.push({ ...candidate, similarity: null, _lex: lex });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  lexical.sort((a, b) => (b._lex - a._lex) || (b.count - a.count));

  return [...scored, ...lexical.map(({ _lex, ...rest }) => rest)];
}

/**
 * 입력 topic과 유사한 실제 topic 후보를 반환한다.
 *
 * @param {Object}   store          - FragmentStore (pool 보유 시 우선 사용)
 * @param {Object}   scopeOptions   - { keyId, groupKeyIds }
 * @param {string}   wrongTopic     - 0건을 만든 입력 topic
 * @param {Object}   [opts]
 * @param {number}   [opts.limit=3] - 최대 후보 수
 * @returns {Promise<Array<{topic: string, count: number, similarity: number|null}>>}
 */
export async function suggestTopics(store, scopeOptions = {}, wrongTopic, { limit = 3 } = {}) {
  const target = typeof wrongTopic === "string" ? wrongTopic.trim() : "";
  if (!target) return [];

  try {
    const pool = store?.pool ?? getPrimaryPool();
    if (!pool) return [];

    const candidates = await aggregateTopics(pool, scopeOptions ?? {}, target);
    if (candidates.length === 0) return [];

    const ranked = await rankBySimilarity(target, candidates);
    return ranked.slice(0, limit);
  } catch {
    return [];
  }
}
