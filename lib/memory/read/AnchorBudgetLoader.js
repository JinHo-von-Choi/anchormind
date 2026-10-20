/**
 * 앵커 토큰 예산 판정용 현재 주입 앵커 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * 앵커 지정 판정(WriteGate anchor 단계)이 쓴다. 같은 키 소유(master는 key_id 없음)이고 같은 workspace
 * (없으면 전역) 범위의 살아 있는 앵커를 context와 같은 순서(importance 내림차순, created_at 내림차순,
 * id)로 상위 limit개만 읽는다. context는 workspace 앵커와 전역 앵커를 섞어 고르므로 이 값은 후보가 속한
 * 범위만 본 추정치다.
 */

import { getPrimaryPool }   from "../../tools/db.js";
import { SCHEMA }           from "../schema.js";
import { keyScopeNullable } from "../keyScope.js";

/**
 * @param {{keyId: string|null, workspace: string|null, limit: number}} scope
 * @returns {Promise<Array<{id: string, importance: number, tokens: number}>>}
 */
export async function loadInjectedAnchors({ keyId, workspace, limit }) {
  const params   = [workspace ?? null, limit];
  const keyScope = keyScopeNullable(params, "key_id", keyId);
  const { rows } = await getPrimaryPool().query(
    `SELECT id, importance, estimated_tokens AS tokens
       FROM ${SCHEMA}.fragments
      WHERE is_anchor = TRUE
        AND valid_to IS NULL
        AND workspace IS NOT DISTINCT FROM $1${keyScope}
      ORDER BY importance DESC, created_at DESC NULLS LAST, id COLLATE "C" ASC
      LIMIT $2`,
    params
  );
  return rows.map(r => ({ id: r.id, importance: Number(r.importance), tokens: Number(r.tokens) || 0 }));
}
