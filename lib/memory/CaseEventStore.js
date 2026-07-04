/**
 * CaseEventStore - case_events / case_event_edges / fragment_evidence CRUD
 *
 * 작성자: 최진호
 * 작성일: 2026-04-03
 */

import { getPrimaryPool, withTransaction } from "../tools/db.js";
import { buildSearchPath } from "../config.js";
import { logWarn }         from "../logger.js";
import { getBackprop }     from "./CaseRewardBackprop.js";

const SCHEMA = "agent_memory";

export class CaseEventStore {
  /**
   * case_events에 이벤트를 추가한다.
   * sequence_no는 동일 case_id 내 MAX + 1로 원자적으로 결정된다.
   *
   * @param {Object}      event
   * @param {string}      event.case_id
   * @param {string}      [event.session_id]
   * @param {string}      event.event_type
   * @param {string}      event.summary
   * @param {string[]}    [event.entity_keys]
   * @param {string}      [event.source_fragment_id]
   * @param {number}      [event.source_search_event_id]
   * @param {number|null} [event.key_id]
   * @returns {Promise<{ event_id: string, sequence_no: number }>}
   */
  async append(event) {
    const pool = getPrimaryPool();
    if (!pool) throw new Error("Database pool not available");

    if (!event.case_id || typeof event.case_id !== "string") {
      throw new Error("case_id is required and must be a string");
    }
    if (!event.event_type || typeof event.event_type !== "string") {
      throw new Error("event_type is required and must be a string");
    }
    const VALID_EVENT_TYPES = ["milestone_reached", "hypothesis_proposed", "hypothesis_rejected", "decision_committed", "error_observed", "fix_attempted", "verification_passed", "verification_failed"];
    if (!VALID_EVENT_TYPES.includes(event.event_type)) {
      throw new Error(`Invalid event_type: ${event.event_type}. Must be one of: ${VALID_EVENT_TYPES.join(", ")}`);
    }

    const insertResult = await withTransaction(pool, async (client) => {
      await client.query(buildSearchPath(SCHEMA));

      /** sequence_no: 동일 case_id 내 MAX(sequence_no) + 1, 없으면 0. READ COMMITTED — 동시 append 시 중복 가능하나 created_at 정렬로 순서 보존. */
      const seqResult = await client.query(
        `SELECT COALESCE(MAX(sequence_no), -1) + 1 AS next_seq
           FROM ${SCHEMA}.case_events
          WHERE case_id = $1`,
        [event.case_id]
      );
      const seqNo = seqResult.rows[0].next_seq;

      return client.query(
        `INSERT INTO ${SCHEMA}.case_events
                (case_id, session_id, sequence_no, event_type, summary,
                 entity_keys, source_fragment_id, source_search_event_id, key_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING event_id, sequence_no`,
        [
          event.case_id,
          event.session_id             ?? null,
          seqNo,
          event.event_type,
          event.summary,
          event.entity_keys            ?? [],
          event.source_fragment_id     ?? null,
          event.source_search_event_id ?? null,
          event.key_id                 ?? null
        ]
      );
    });

    const row = insertResult.rows[0];

    /** verification 이벤트 -> CaseRewardBackprop fire-and-forget */
    if (event.event_type === "verification_passed" || event.event_type === "verification_failed") {
      getBackprop().backprop(event.case_id, event.event_type, event.key_id ?? null)
        .catch(err => logWarn(`[CaseEventStore] reward backprop failed: ${err.message}`));
    }

    return { event_id: row.event_id, sequence_no: row.sequence_no };
  }

  /**
   * case_event_edges에 방향성 엣지를 추가한다.
   * 이미 존재하는 경우 무시한다.
   *
   * @param {string} fromEventId
   * @param {string} toEventId
   * @param {string} edgeType    - 'caused_by' | 'resolved_by' | 'preceded_by' | 'contradicts'
   * @param {number} [confidence=1.0]
   * @returns {Promise<void>}
   */
  async addEdge(fromEventId, toEventId, edgeType, confidence = 1.0) {
    const pool = getPrimaryPool();
    if (!pool) throw new Error("Database pool not available");

    await pool.query(
      `INSERT INTO ${SCHEMA}.case_event_edges
              (from_event_id, to_event_id, edge_type, confidence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (from_event_id, to_event_id, edge_type) DO NOTHING`,
      [fromEventId, toEventId, edgeType, confidence]
    );
  }

  /**
   * fragment_evidence에 증거 링크를 추가한다.
   * 이미 존재하는 경우 무시한다.
   *
   * @param {string} fragmentId
   * @param {string} eventId
   * @param {string} kind        - 'supports' | 'contradicts' | 'produced_by'
   * @param {number} [confidence=1.0]
   * @returns {Promise<void>}
   */
  async addEvidence(fragmentId, eventId, kind, confidence = 1.0) {
    const pool = getPrimaryPool();
    if (!pool) throw new Error("Database pool not available");

    await pool.query(
      `INSERT INTO ${SCHEMA}.fragment_evidence
              (fragment_id, event_id, kind, confidence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (fragment_id, event_id, kind) DO NOTHING`,
      [fragmentId, eventId, kind, confidence]
    );
  }

  /**
   * 특정 case_id의 이벤트 목록을 시간순으로 조회한다.
   *
   * @param {string}      caseId
   * @param {Object}      [opts={}]
   * @param {number}      [opts.limit=100]
   * @param {string}      [opts.from]      - ISO8601 하한 (created_at >=)
   * @param {string}      [opts.to]        - ISO8601 상한 (created_at <=)
   * @param {string}      [opts.eventType] - 특정 event_type 필터
   * @param {number|null} [opts.keyId]     - API 키 격리 필터
   * @returns {Promise<Object[]>}
   */
  async getByCase(caseId, opts = {}) {
    const pool  = getPrimaryPool();
    if (!pool) return [];

    const limit     = Math.min(opts.limit ?? 100, 500);
    const keyId     = opts.keyId     ?? null;
    const eventType = opts.eventType ?? null;

    const params  = [caseId];
    const clauses = [];

    /** 시간 범위 */
    if (opts.from) {
      params.push(opts.from);
      clauses.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (opts.to) {
      params.push(opts.to);
      clauses.push(`created_at <= $${params.length}::timestamptz`);
    }

    /** event_type 필터 */
    if (eventType) {
      params.push(eventType);
      clauses.push(`event_type = $${params.length}`);
    }

    /** key_id 격리 */
    if (keyId != null) {
      params.push(keyId);
      clauses.push(`key_id = $${params.length}`);
    }

    /** limit */
    params.push(limit);
    const limitIdx = params.length;

    const whereExtra = clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";

    const sql = `
      SELECT event_id, case_id, session_id, sequence_no, event_type,
             summary, entity_keys, source_fragment_id, source_search_event_id,
             key_id, created_at
        FROM ${SCHEMA}.case_events
       WHERE case_id = $1
         ${whereExtra}
       ORDER BY created_at ASC, sequence_no ASC
       LIMIT $${limitIdx}`;

    const { rows } = await pool.query(sql, params);
    return rows;
  }

  /**
   * 특정 session_id의 이벤트 목록을 시간순으로 조회한다.
   *
   * @param {string}      sessionId
   * @param {Object}      [opts={}]
   * @param {number}      [opts.limit=50]
   * @param {number|null} [opts.keyId]
   * @returns {Promise<Object[]>}
   */
  async getBySession(sessionId, opts = {}) {
    const pool = getPrimaryPool();
    if (!pool) return [];

    const limit = Math.min(opts.limit ?? 50, 500);
    const keyId = opts.keyId ?? null;

    let   keyFilter = "";
    const params    = [sessionId];
    if (keyId != null) {
      params.push(keyId);
      keyFilter = `AND key_id = $${params.length}`;
    }
    params.push(limit);
    const limitIdx = params.length;

    const { rows } = await pool.query(
      `SELECT event_id, case_id, session_id, sequence_no, event_type,
              summary, entity_keys, source_fragment_id, source_search_event_id,
              key_id, created_at
         FROM ${SCHEMA}.case_events
        WHERE session_id = $1
          ${keyFilter}
        ORDER BY created_at ASC, sequence_no ASC
        LIMIT $${limitIdx}`,
      params
    );
    return rows;
  }

  /**
   * 이벤트 ID 배열에 연결된 엣지를 양방향으로 조회한다.
   * keyId가 지정된 경우 해당 키 소유 이벤트의 엣지만 반환한다.
   *
   * @param {string[]}    eventIds
   * @param {number|null} [keyId=null] - API 키 격리 필터
   * @returns {Promise<Object[]>}
   */
  async getEdgesByEvents(eventIds, keyId = null) {
    if (!eventIds || eventIds.length === 0) return [];

    const pool = getPrimaryPool();
    if (!pool) return [];

    if (keyId != null) {
      /** key_id 격리: case_events JOIN으로 from/to 양쪽 모두 해당 키 소유인 엣지만 반환 */
      const { rows } = await pool.query(
        `SELECT ee.from_event_id, ee.to_event_id, ee.edge_type, ee.confidence
           FROM ${SCHEMA}.case_event_edges ee
           JOIN ${SCHEMA}.case_events ce_from ON ce_from.event_id = ee.from_event_id
           JOIN ${SCHEMA}.case_events ce_to   ON ce_to.event_id   = ee.to_event_id
          WHERE (ee.from_event_id = ANY($1::uuid[]) OR ee.to_event_id = ANY($1::uuid[]))
            AND ce_from.key_id = $2
            AND ce_to.key_id   = $2`,
        [eventIds, keyId]
      );
      return rows;
    }

    const { rows } = await pool.query(
      `SELECT from_event_id, to_event_id, edge_type, confidence
         FROM ${SCHEMA}.case_event_edges
        WHERE from_event_id = ANY($1::uuid[])
           OR to_event_id   = ANY($1::uuid[])`,
      [eventIds]
    );
    return rows;
  }

  /**
   * 특정 case_event의 근거 파편 목록을 조회한다.
   * keyId가 지정된 경우 해당 키 소유 파편만 반환한다.
   *
   * @param {string}      eventId - case_events.event_id (UUID)
   * @param {number|null} [keyId=null] - API 키 격리 필터
   * @returns {Promise<Object[]>} { fragment_id, content, type, topic, keywords, kind, confidence }
   */
  async getEvidenceByEvent(eventId, keyId = null) {
    const pool = getPrimaryPool();
    if (!pool) return [];

    let   keyClause = "";
    const params    = [eventId];
    if (keyId != null) {
      params.push(keyId);
      keyClause = `AND f.key_id = $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT f.id AS fragment_id, f.content, f.type, f.topic, f.keywords,
              fe.kind, fe.confidence
         FROM ${SCHEMA}.fragment_evidence fe
         JOIN ${SCHEMA}.fragments f ON f.id = fe.fragment_id
        WHERE fe.event_id = $1
          ${keyClause}
        ORDER BY fe.confidence DESC`,
      params
    );
    return rows;
  }

  /**
   * 특정 파편이 근거로 참조된 case_events 목록을 조회한다.
   * keyId가 지정된 경우 해당 키 소유 이벤트만 반환한다.
   *
   * @param {string}      fragmentId
   * @param {number|null} [keyId=null] - API 키 격리 필터
   * @returns {Promise<Object[]>} { event_id, case_id, event_type, summary, created_at, kind, confidence }
   */
  async getEventsByFragment(fragmentId, keyId = null) {
    const pool = getPrimaryPool();
    if (!pool) return [];

    let   keyClause = "";
    const params    = [fragmentId];
    if (keyId != null) {
      params.push(keyId);
      keyClause = `AND ce.key_id = $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT ce.event_id, ce.case_id, ce.event_type, ce.summary, ce.created_at,
              fe.kind, fe.confidence
         FROM ${SCHEMA}.fragment_evidence fe
         JOIN ${SCHEMA}.case_events ce ON ce.event_id = fe.event_id
        WHERE fe.fragment_id = $1
          ${keyClause}
        ORDER BY ce.created_at ASC`,
      params
    );
    return rows;
  }

  /**
   * 90일 이상 경과한 이벤트를 삭제한다.
   * case_event_edges, fragment_evidence는 CASCADE로 자동 삭제된다.
   *
   * @returns {Promise<number>} 삭제된 이벤트 건수
   */
  async deleteExpired() {
    const pool = getPrimaryPool();
    if (!pool) return 0;

    const result = await pool.query(
      `DELETE FROM ${SCHEMA}.case_events
        WHERE created_at < NOW() - INTERVAL '90 days'`
    ).catch(err => {
      logWarn(`[CaseEventStore] deleteExpired failed: ${err.message}`);
      return { rowCount: 0 };
    });

    return result.rowCount ?? 0;
  }
}
