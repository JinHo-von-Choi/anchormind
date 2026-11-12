/**
 * DigestLoader - recall 근거에 싣는 묶음 요약(fragment_digest) 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 *
 * 정리 주기가 만든 topic 시간선과 선호 목록(lib/memory/consolidate/DigestBuilder.js)을 recall과 같은 키,
 * workspace, agent 범위에서 읽는다. 출처 파편이 하나라도 유효하지 않은 요약은 읽지 않는다(다음 주기에
 * 다시 만들어진다).
 */

import { getPrimaryPool } from "../../tools/db.js";
import { SCHEMA }         from "../schema.js";
import { keyScopeClause } from "../keyScope.js";
import { queryScoped } from "../../tools/row-scope.js";

/** 선호를 묻는 질의 */
export const PREFERENCE_QUERY_RE =
  /선호|좋아하|싫어하|취향|즐겨|추천|\bprefer|\bfavou?rite|\blike\s+to\b|\benjoy|\bdislike|\brecommend|\bsuggest/i;

/** 한 recall에 싣는 topic 시간선 수 상한 */
export const DIGEST_TOPICS_MAX = 3;

/**
 * 묶음 요약을 읽는다.
 *
 * @param {{agentId?: string, keyId?: string|null, groupKeyIds?: string[], workspace?: string|null}} scope
 *   키 범위는 recall과 같은 생성기(keyScopeClause)로 건다. 마스터 키(keyId 없음)는 키로 거르지 않는다
 * @param {{topics?: string[], preference?: boolean}} want
 * @param {() => {query: Function}|null} [getPool]
 * @returns {Promise<Array<{kind: string, subject: string, content: string, item_count: number, updated_at: string}>>}
 */
export async function loadDigests(scope = {}, { topics = [], preference = false } = {}, getPool = getPrimaryPool) {
  const subjects = [...new Set((topics ?? []).filter(Boolean))].slice(0, DIGEST_TOPICS_MAX);
  if (subjects.length === 0 && !preference) return [];
  const pool = getPool();
  if (!pool) return [];

  const params    = [scope.workspace ?? null, scope.agentId || "default", subjects, preference === true];
  const keyFilter = keyScopeClause(params, "d.key_id", { keyId: scope.keyId ?? null, groupKeyIds: scope.groupKeyIds });
  const { rows } = await queryScoped(pool,
    `SELECT d.kind, d.subject, d.content, d.item_count, d.updated_at
       FROM ${SCHEMA}.fragment_digest d
      WHERE d.workspace IS NOT DISTINCT FROM $1
        AND (d.agent_id = $2 OR d.agent_id = 'default')
        AND ((d.kind = 'topic_timeline' AND d.subject = ANY($3::text[]))
             OR (d.kind = 'preference_profile' AND $4::boolean))
        AND NOT EXISTS (
          SELECT 1 FROM unnest(d.source_ids) AS s(id)
           WHERE NOT EXISTS (SELECT 1 FROM ${SCHEMA}.fragments f WHERE f.id = s.id AND f.valid_to IS NULL)
        )${keyFilter}
      ORDER BY d.kind, d.subject`,
    params
  );
  return rows.map(r => ({
    kind      : r.kind,
    subject   : r.subject,
    item_count: r.item_count,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    content   : r.content
  }));
}

/**
 * recall 결과와 인자로 읽을 요약을 고른다. 묶음 의도(aggregate, temporal, state)면 요청 topic, 없으면 결과
 * 상위 파편의 topic 시간선을, 선호 질문이면 선호 목록을 고른다.
 *
 * @param {object[]} fragments
 * @param {{topic?: string, type?: string, text?: string, keywords?: string[]}} args
 * @param {string} intent
 * @returns {{topics: string[], preference: boolean}}
 */
export function digestWants(fragments, args, intent) {
  const queryText  = args.text ?? (Array.isArray(args.keywords) ? args.keywords.join(" ") : "");
  const preference = args.type === "preference" || PREFERENCE_QUERY_RE.test(queryText);
  if (intent === "lookup") return { topics: [], preference };
  const topics = args.topic
    ? [args.topic]
    : [...new Set((fragments ?? []).map(f => f.topic).filter(Boolean))].slice(0, DIGEST_TOPICS_MAX);
  return { topics, preference };
}
