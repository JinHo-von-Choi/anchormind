/**
 * Reconsolidation Engine
 * fragment_links의 weight/confidence를 동적으로 갱신하고 이력을 기록한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-03
 */

import { getPrimaryPool } from "../../tools/db.js";
import { SCHEMA } from "../schema.js";

const DELTAS = {
  reinforce  :  0.2,
  decay      : -0.15,
  quarantine : -0.3,
  restore    :  0.3,
  soft_delete:  0,
};

/** 동일 link 60초 내 재감쇠 방지 */
const RATE_LIMIT_MS  = 60_000;
const lastDecayAt    = new Map();
const DECAY_ACTIONS  = new Set(["decay", "quarantine"]);

export async function reconsolidate(linkId, action, { triggeredBy = null, keyId = null } = {}) {
  if (DECAY_ACTIONS.has(action)) {
    const last = lastDecayAt.get(linkId);
    if (last && Date.now() - last < RATE_LIMIT_MS) return null;
    lastDecayAt.set(linkId, Date.now());
  }

  const delta  = DELTAS[action] ?? 0;
  const pool   = getPrimaryPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query(`
      UPDATE ${SCHEMA}.fragment_links
      SET weight          = GREATEST(0, LEAST(2, weight + $1)),
          confidence      = CASE WHEN $1 < 0
                                 THEN GREATEST(0, confidence - 0.1)
                                 WHEN $1 > 0
                                 THEN LEAST(1, confidence + 0.05)
                                 ELSE confidence END,
          quarantine_state = CASE
                               WHEN $2 = 'quarantine' THEN 'soft'
                               WHEN $2 = 'restore'    THEN 'released'
                               ELSE quarantine_state
                             END,
          deleted_at      = CASE WHEN $2 = 'soft_delete' THEN NOW()  ELSE deleted_at  END,
          delete_reason   = CASE WHEN $2 = 'soft_delete' THEN $3     ELSE delete_reason END
      WHERE id = $4 AND deleted_at IS NULL
      RETURNING id,
                weight                        AS new_weight,
                confidence                    AS new_confidence,
                weight - $1                   AS old_weight,
                CASE WHEN $1 < 0 THEN confidence + 0.1
                     WHEN $1 > 0 THEN confidence - 0.05
                     ELSE confidence END       AS old_confidence
    `, [delta, action, triggeredBy, linkId]);

    if (!res.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = res.rows[0];

    await client.query(`
      INSERT INTO ${SCHEMA}.link_reconsolidations
        (link_id, action, old_weight, new_weight, old_confidence, new_confidence,
         reason, triggered_by, key_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [linkId, action,
        row.old_weight, row.new_weight,
        row.old_confidence, row.new_confidence,
        triggeredBy ?? action, triggeredBy, keyId]);

    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** contradicts 감지 시 인접 related/temporal 링크 soft quarantine */
export async function quarantineAdjacentLinks(fromId, toId, keyId) {
  const pool  = getPrimaryPool();
  const links = await pool.query(`
    SELECT id FROM ${SCHEMA}.fragment_links
    WHERE (from_id = $1 AND to_id = $2 OR from_id = $2 AND to_id = $1)
      AND relation_type IN ('related', 'temporal')
      AND deleted_at IS NULL
      AND (quarantine_state IS NULL OR quarantine_state = 'released')
  `, [fromId, toId]);

  return Promise.allSettled(
    links.rows.map(l => reconsolidate(l.id, "quarantine", {
      triggeredBy: `conflict:${fromId}<->${toId}`,
      keyId
    }))
  );
}
