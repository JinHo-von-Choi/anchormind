/**
 * ConsolidatorGC — 피드백 리포트, stale 파편 수집/정리, 긴 파편 분할, 피드백 기반 보정
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 */

import { getPrimaryPool, queryWithAgentVector } from "../../tools/db.js";
import { MEMORY_CONFIG } from "../../../config/memory.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../../gemini.js";
import { logInfo, logWarn } from "../../logger.js";
import { isAcceptableSplitChild, clampChildImportance } from "./split-gate.js";
import { resolveSplitChainConfig } from "../../config.js";
import { recordSplitSkip } from "./split-metrics.js";
import { feedbackFactor } from "./feedbackFactor.js";

const SCHEMA = "agent_memory";

/**
 * 분할 후보 SELECT 쿼리를 구성한다. split 기원·메타 토픽·backoff 윈도우 내
 * 최근 실패 파편을 제외한다.
 *
 * @param {string[]} metaTopics  분할에서 제외할 topic 목록
 * @returns {{sql: string, params: {metaTopics: string[]}}}
 *   파라미터 바인딩 순서: [$1 threshold, $2 batchSize, $3 backoffHours, ($4 metaTopics?)]
 */
export function buildSplitCandidateQuery(metaTopics) {
  const hasMeta    = Array.isArray(metaTopics) && metaTopics.length > 0;
  const topicGuard = hasMeta ? "          AND topic <> ALL($4::text[])\n" : "";
  const sql =
    `SELECT id, content, topic, type, importance, agent_id, key_id\n` +
    `         FROM ${SCHEMA}.fragments\n` +
    `        WHERE length(content) > $1\n` +
    `          AND valid_to IS NULL\n` +
    `          AND is_anchor = FALSE\n` +
    `          AND (source IS NULL OR source NOT LIKE 'split:%')\n` +
    `          AND (split_attempt_failed_at IS NULL\n` +
    `               OR split_attempt_failed_at < NOW() - make_interval(hours => $3))\n` +
    topicGuard +
    `        ORDER BY length(content) DESC\n` +
    `        LIMIT $2`;
  return { sql, params: { metaTopics: hasMeta ? metaTopics : [] } };
}

export class ConsolidatorGC {
  /**
   * @param {import("../write/FragmentStore.js").FragmentStore} store
   */
  constructor(store) {
    this.store = store;
  }

  /**
   * 피드백 리포트 생성
   *
   * tool_feedback + task_feedback 데이터를 집계하여
   * 도구별 관련성/충분성 비율, 주요 개선 제안을 산출한다.
   * 최소 피드백 10건 이상인 도구만 통계 표시.
   *
   * @returns {Promise<boolean>} 리포트 생성 여부
   */
  async generateFeedbackReport() {
    const pool = getPrimaryPool();
    if (!pool) return false;

    try {
      const { redisClient } = await import("../../redis.js");
      const LAST_REPORT_KEY = "frag:feedback_report_at";

      let lastReportAt = null;
      try {
        if (redisClient && redisClient.status === "ready") {
          lastReportAt = await redisClient.get(LAST_REPORT_KEY);
        }
      } catch (err) { logWarn(`[ConsolidatorGC] Redis lastReportAt read failed: ${err.message}`); }

      const params     = [];
      let dateFilter   = "";
      if (lastReportAt) {
        params.push(lastReportAt);
        dateFilter     = `AND created_at > $1`;
      }

      const toolStats  = await this._collectToolFeedbackStats(pool, dateFilter, params);

      const totalFeedbacks = toolStats.rows.reduce((sum, r) => sum + r.total, 0);
      if (totalFeedbacks === 0) return false;

      const suggestions = await this._collectFeedbackSuggestions(pool, dateFilter, params);

      const taskStats = await this._collectTaskStats(pool, dateFilter, params);

      const now        = new Date().toISOString().split("T")[0];
      const reportFrom = lastReportAt ? lastReportAt.split("T")[0] : "전체";
      const lines      = [];

      lines.push("# 도구 유용성 피드백 리포트");
      lines.push("");
      lines.push(`생성일: ${now}`);
      lines.push(`기간: ${reportFrom} ~ ${now}`);
      lines.push(`전체 피드백 수: ${totalFeedbacks}건`);
      lines.push("");

      lines.push("## 도구별 통계");
      lines.push("");
      lines.push("| 도구 | 피드백 수 | 관련성 | 충분성 | 샘플링 | 자발적 | 경고 |");
      lines.push("|------|-----------|--------|--------|--------|--------|------|");

      for (const row of toolStats.rows) {
        const relevantPct   = row.total > 0 ? Math.round((row.relevant_count / row.total) * 100) : 0;
        const sufficientPct = row.total > 0 ? Math.round((row.sufficient_count / row.total) * 100) : 0;
        const warning       = [];

        if (row.total < 10) {
          warning.push("데이터 부족");
        } else {
          if (relevantPct < 50)   warning.push("관련성 낮음");
          if (sufficientPct < 50) warning.push("충분성 낮음");
        }

        const warningStr = warning.length > 0 ? warning.join(", ") : "-";

        lines.push(
          `| ${row.tool_name} | ${row.total} | ${relevantPct}% | ${sufficientPct}% ` +
          `| ${row.sampled_count} | ${row.voluntary_count} | ${warningStr} |`
        );
      }

      if (suggestions.rows.length > 0) {
        lines.push("");
        lines.push("## 주요 개선 제안");
        lines.push("");

        const grouped = {};
        for (const s of suggestions.rows) {
          if (!grouped[s.tool_name]) grouped[s.tool_name] = [];
          grouped[s.tool_name].push(s.suggestion);
        }

        for (const [tool, sugs] of Object.entries(grouped)) {
          lines.push(`### ${tool}`);
          for (const sug of sugs.slice(0, 5)) {
            lines.push(`- ${sug}`);
          }
          lines.push("");
        }
      }

      const ts = taskStats.rows[0];
      if (ts && ts.total_sessions > 0) {
        const successRate = Math.round((ts.success_count / ts.total_sessions) * 100);
        lines.push("## 작업 레벨 통계");
        lines.push("");
        lines.push(`| 지표 | 값 |`);
        lines.push(`|------|-----|`);
        lines.push(`| 평가된 세션 수 | ${ts.total_sessions} |`);
        lines.push(`| 성공 비율 | ${successRate}% |`);
        lines.push("");
      }

      const fs   = await import("fs");
      const path = await import("path");

      const reportsDir  = path.default.join(process.cwd(), "docs", "reports");
      const reportPath  = path.default.join(reportsDir, "tool-feedback-report.md");

      await fs.promises.mkdir(reportsDir, { recursive: true });
      await fs.promises.writeFile(reportPath, lines.join("\n"), "utf-8");

      logInfo(`[ConsolidatorGC] Feedback report generated: ${reportPath}`);

      try {
        if (redisClient && redisClient.status === "ready") {
          await redisClient.set(LAST_REPORT_KEY, new Date().toISOString());
        }
      } catch (err) { logWarn(`[ConsolidatorGC] Redis lastReportAt write failed: ${err.message}`); }

      return true;
    } catch (err) {
      logWarn(`[ConsolidatorGC] Feedback report generation failed: ${err.message}`);
      return false;
    }
  }

  /** 도구별 피드백 통계(관련성/충분성/트리거유형) 수집 */
  async _collectToolFeedbackStats(pool, dateFilter, params) {
    return pool.query(
      `SELECT
         tool_name,
         count(*)::int                                       AS total,
         count(*) FILTER (WHERE relevant  = true)::int       AS relevant_count,
         count(*) FILTER (WHERE sufficient = true)::int      AS sufficient_count,
         count(*) FILTER (WHERE trigger_type = 'sampled')::int  AS sampled_count,
         count(*) FILTER (WHERE trigger_type = 'voluntary')::int AS voluntary_count
       FROM agent_memory.tool_feedback
       WHERE 1=1 ${dateFilter}
       GROUP BY tool_name
       ORDER BY total DESC`,
      params
    );
  }

  /** 개선 제안 텍스트가 있는 최근 피드백 50건 수집 */
  async _collectFeedbackSuggestions(pool, dateFilter, params) {
    return pool.query(
      `SELECT tool_name, suggestion
       FROM agent_memory.tool_feedback
       WHERE suggestion IS NOT NULL AND suggestion != ''
       ${dateFilter}
       ORDER BY created_at DESC
       LIMIT 50`,
      params
    );
  }

  /** 작업 레벨(task_feedback) 성공률 통계 수집 */
  async _collectTaskStats(pool, dateFilter, params) {
    return pool.query(
      `SELECT
         count(*)::int                                           AS total_sessions,
         count(*) FILTER (WHERE overall_success = true)::int     AS success_count
       FROM agent_memory.task_feedback
       WHERE 1=1 ${dateFilter}`,
      params
    );
  }

  /**
   * 검증 주기 초과 파편 목록 반환
   *
   * @returns {Promise<Array>} stale fragment 요약 목록
   */
  async collectStaleFragments() {
    const pool = getPrimaryPool();
    if (!pool) return [];

    const result = await pool.query(
      `SELECT id, content, type, verified_at,
              EXTRACT(DAY FROM NOW() - verified_at)::int AS days_since_verification
       FROM agent_memory.fragments
       WHERE (type = 'procedure' AND verified_at < NOW() - INTERVAL '30 days')
          OR (type = 'fact'      AND verified_at < NOW() - INTERVAL '60 days')
          OR (type = 'decision'  AND verified_at < NOW() - INTERVAL '90 days')
          OR (type NOT IN ('procedure', 'fact', 'decision') AND verified_at < NOW() - INTERVAL '60 days')
       ORDER BY days_since_verification DESC
       LIMIT 20`
    );

    return result.rows.map(r => ({
      id                    : r.id,
      content               : r.content.substring(0, 80) + (r.content.length > 80 ? "..." : ""),
      type                  : r.type,
      verified_at           : r.verified_at,
      days_since_verification: r.days_since_verification
    }));
  }

  /**
   * session_reflect 토픽의 오래되고 낮은 importance 파편을 정리한다.
   *
   * @returns {Promise<number>} 삭제된 행 수
   */
  async purgeStaleReflections() {
    const policy   = MEMORY_CONFIG.reflectionPolicy || {};
    const maxDays  = Number(policy.maxAgeDays) || 30;
    const maxImp   = Number(policy.maxImportance) || 0.3;
    const keepN    = Number(policy.keepPerType) || 5;
    const maxDel   = Number(policy.maxDeletePerCycle) || 30;

    const result = await queryWithAgentVector("system",
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (PARTITION BY type ORDER BY importance DESC, created_at DESC) AS rn
         FROM ${SCHEMA}.fragments
         WHERE topic = 'session_reflect'
       )
       DELETE FROM ${SCHEMA}.fragments
       WHERE id IN (
         SELECT r.id FROM ranked r
         JOIN ${SCHEMA}.fragments f ON f.id = r.id
         WHERE r.rn > $1
           AND f.importance < $2
           AND f.created_at < NOW() - make_interval(days => $3)
           AND f.is_anchor = FALSE
           AND f.ttl_tier != 'permanent'
         LIMIT $4
       )`,
      [keepN, maxImp, maxDays, maxDel],
      "write"
    );

    if (result.rowCount > 0) {
      logInfo(`[ConsolidatorGC] Purged ${result.rowCount} stale session_reflect fragments`);
    }
    return result.rowCount;
  }

  /**
   * 긴 파편을 Gemini CLI로 원자 파편들로 분할
   *
   * @returns {Promise<number>} 분할 처리된 원본 파편 수
   */
  async splitLongFragments({ pool: injectedPool } = {}) {
    if (!await isGeminiCLIAvailable()) return 0;

    const pool = injectedPool ?? getPrimaryPool();
    if (!pool)  return 0;

    const cfg        = MEMORY_CONFIG.fragmentSplit || {};
    const candidates = await this._querySplitCandidates(pool, cfg);

    if (candidates.rows.length === 0) return 0;

    const { randomUUID } = await import("crypto");
    let splitCount = 0;

    for (const frag of candidates.rows) {
      const committed = await this._processFragmentSplit(frag, pool, cfg, randomUUID);
      if (committed) splitCount++;
    }

    return splitCount;
  }

  /**
   * 분할 후보 파편 조회
   *
   * @param {import("pg").Pool}  pool
   * @param {Object}             cfg  - MEMORY_CONFIG.fragmentSplit
   * @returns {Promise<import("pg").QueryResult>}
   */
  async _querySplitCandidates(pool, cfg) {
    const threshold    = cfg.lengthThreshold    ?? 300;
    const batchSize    = cfg.batchSize          ?? 10;
    const metaTopics   = cfg.excludeMetaTopics  ?? [];
    const backoffHours = cfg.failureBackoffHours ?? 24;

    const { sql, params } = buildSplitCandidateQuery(metaTopics);
    const queryArgs = params.metaTopics.length > 0
      ? [threshold, batchSize, backoffHours, params.metaTopics]
      : [threshold, batchSize, backoffHours];

    return pool.query(sql, queryArgs);
  }

  /**
   * 단일 파편의 분할 처리 (LLM 호출 → gate → commit).
   *
   * two-phase gate-then-commit 의미를 보존한다:
   *   Phase 1: 게이트 통과 항목만 accepted 배열에 수집 (DB 접촉 없음).
   *   Phase 2: minItems 이상일 때만 INSERT 커밋. 부족 시 rolled back 후 backoff 기록.
   *
   * @param {Object}   frag       - 분할 대상 파편 row
   * @param {Object}   pool       - pg Pool
   * @param {Object}   cfg        - MEMORY_CONFIG.fragmentSplit
   * @param {Function} randomUUID - crypto.randomUUID 함수
   * @returns {Promise<boolean>} 분할 커밋 성공 여부
   */
  async _processFragmentSplit(frag, pool, cfg, randomUUID) {
    const minItems     = cfg.minItems  ?? 2;
    const maxItems     = cfg.maxItems  ?? 8;
    const timeoutMs    = cfg.timeoutMs ?? 40_000;
    const splitProviders = resolveSplitChainConfig();

    try {
      /** System prompt — 외부 LLM이 JSON 배열만 출력하도록 엄격히 지시 */
      const systemPrompt =
        "You are a JSON array generator for text splitting. " +
        "Your ONLY output MUST be a valid JSON array of strings. " +
        "Do NOT include markdown fences, explanations, reasoning, preambles, or ANY other text. " +
        "Output must be directly parseable by JSON.parse(). " +
        "Format: [\"sentence1\",\"sentence2\",\"sentence3\"]";

      /** User prompt — 한국어 규칙 + few-shot 예시 */
      const userPrompt =
        `다음 텍스트를 ${minItems}~${maxItems}개의 원자적 사실로 분리하라.\n` +
        `각 항목은 1~2문장의 독립적으로 이해 가능한 단일 사실이어야 한다.\n` +
        `원문 정보를 손실 없이 유지한다.\n\n` +
        `예시:\n` +
        `입력: "Redis는 포트 6379로 동작하고 메모리 기반 key-value 저장소이며 TTL 만료 정책을 지원한다"\n` +
        `출력: ["Redis는 포트 6379로 동작한다","Redis는 메모리 기반 key-value 저장소다","Redis는 TTL 만료 정책을 지원한다"]\n\n` +
        `이제 다음을 분리하라:\n` +
        `입력: "${frag.content.replace(/"/g, '\\"')}"\n` +
        `출력:`;

      const items = await geminiCLIJson(userPrompt, {
        timeoutMs,
        systemPrompt,
        ...(splitProviders ? { providers: splitProviders } : {})
      });

      if (!Array.isArray(items) || items.length < minItems) return false;

      const agentId = frag.agent_id || "default";
      const keyId   = frag.key_id   ?? null;

      /** Phase 1 — gate every candidate WITHOUT touching the DB. */
      const accepted = [];
      for (const item of items.slice(0, maxItems)) {
        const text = typeof item === "string" ? item.trim() : String(item).trim();
        if (!isAcceptableSplitChild(text, frag.type)) continue;

        const childImportance = clampChildImportance(frag.importance, frag.type);
        if (childImportance === null) continue;

        accepted.push({ text, childImportance });
      }

      /** Partial-yield guard: fewer than minItems clean children ⇒ abort this
       *  fragment entirely. No child insert, no tombstone — original stays as-is
       *  for a future cycle (Task 3 backoff prevents an infinite retry loop). */
      if (accepted.length < minItems) {
        await pool.query(
          `UPDATE ${SCHEMA}.fragments SET split_attempt_failed_at = NOW() WHERE id = $1`,
          [frag.id]
        ).catch(() => {});
        recordSplitSkip("low_yield");
        logWarn(`[ConsolidatorGC] split skipped for ${frag.id}: only ${accepted.length} clean child(ren) (< ${minItems})`);
        return false;
      }

      /** Phase 2 — commit accepted children. */
      const newIds = [];
      for (const { text, childImportance } of accepted) {
        const newId    = randomUUID();
        const inserted = await this.store.insert({
          id        : newId,
          content   : text,
          topic     : frag.topic,
          type      : frag.type,
          importance: childImportance,
          keywords  : [],
          source    : `split:${frag.id}`,
          linked_to : [],
          ttl_tier  : "warm",
          is_anchor : false,
          agent_id  : agentId,
          key_id    : keyId
        });

        if (inserted) newIds.push(inserted);
      }

      /** Insert-level failure (DB rejected some rows) can still drop us below
       *  minItems. Roll back the partial inserts and leave the original intact. */
      if (newIds.length < minItems) {
        for (const childId of newIds) {
          await this.store.delete(childId, agentId, keyId).catch(() => {});
        }
        await pool.query(
          `UPDATE ${SCHEMA}.fragments SET split_attempt_failed_at = NOW() WHERE id = $1`,
          [frag.id]
        ).catch(() => {});
        recordSplitSkip("insert_shortfall");
        logWarn(`[ConsolidatorGC] split rolled back for ${frag.id}: ${newIds.length} inserted (< ${minItems})`);
        return false;
      }

      for (let i = 1; i < newIds.length; i++) {
        await this.store.createLink(newIds[i - 1], newIds[i], "related", agentId).catch(() => {});
      }

      for (const childId of newIds) {
        await this.store.createLink(childId, frag.id, "part_of", agentId).catch(() => {});
      }

      await pool.query(
        `UPDATE ${SCHEMA}.fragments
            SET valid_to   = NOW(),
                importance = GREATEST(0.2, importance * 0.3),
                ttl_tier   = 'cold'
          WHERE id = $1`,
        [frag.id]
      );

      logInfo(`[ConsolidatorGC] Split fragment ${frag.id} → ${newIds.length} atomic fragments`);
      return true;

    } catch (err) {
      await pool.query(
        `UPDATE ${SCHEMA}.fragments SET split_attempt_failed_at = NOW() WHERE id = $1`,
        [frag.id]
      ).catch(() => {});
      const reason = /no LLM provider available/.test(err.message) ? "provider_error" : "llm_error";
      recordSplitSkip(reason);
      logWarn(`[ConsolidatorGC] splitLongFragments failed for ${frag.id} (${reason}): ${err.message}`);
      return false;
    }
  }

  /**
   * 최근 7일 피드백 데이터를 기반으로 파편 importance를 승산(multiplicative) 보정한다.
   *
   * 긍정 피드백: importance *= 1.1
   * 부정 피드백: importance *= 0.85
   * 피드백 0건 + access_count 0 + 90일 경과: importance *= 0.5
   *
   * @returns {Promise<number>} 업데이트된 파편 수
   */
  async calibrateByFeedback() {
    const pool = getPrimaryPool();
    if (!pool) return 0;

    let redisClient;
    try {
      const redis = await import("../../redis.js");
      redisClient = redis.redisClient;
    } catch { return 0; }

    if (!redisClient || redisClient.status !== "ready") return 0;

    const feedbackResult = await pool.query(`
      SELECT session_id,
             bool_and(relevant)   AS all_relevant,
             bool_and(sufficient) AS all_sufficient,
             count(*)::int         AS cnt
      FROM ${SCHEMA}.tool_feedback
      WHERE session_id IS NOT NULL
        AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY session_id
      HAVING count(*) >= 2
    `).catch(() => ({ rows: [] }));

    const { SessionActivityTracker } = await import("../processors/SessionActivityTracker.js");
    let updated = 0;

    /** 피드백 기반 보정 */
    for (const row of feedbackResult.rows) {
      const activity = await SessionActivityTracker.getActivity(row.session_id);
      if (!activity || !activity.fragments || activity.fragments.length === 0) continue;

      const fragIds = activity.fragments.slice(0, 20);

      const factor = feedbackFactor(row.all_relevant, row.all_sufficient);

      for (const fragId of fragIds) {
        try {
          await queryWithAgentVector("default",
            `UPDATE ${SCHEMA}.fragments
             SET importance = LEAST(1.0, GREATEST(0.05, importance * $2::float))
             WHERE id = $1 AND is_anchor = false`,
            [fragId, factor],
            "write"
          );
          updated++;
        } catch { /* 무시 */ }
      }
    }

    /** 피드백 0건 + access_count 0 + 90일 경과 파편 하향 */
    try {
      const staleResult = await pool.query(`
        UPDATE ${SCHEMA}.fragments
        SET importance = GREATEST(0.05, importance * 0.5)
        WHERE is_anchor = false
          AND valid_to IS NULL
          AND access_count = 0
          AND created_at < NOW() - INTERVAL '90 days'
        RETURNING id
      `);
      updated += (staleResult.rows?.length || 0);
    } catch { /* 무시 */ }

    return updated;
  }

  /**
   * 오래된 저-importance 파편을 topic 기반 KNN 그룹으로 압축
   *
   * 대상: accessed_at < COMPRESS_AGE_DAYS, importance < 0.5,
   *       is_anchor IS NOT TRUE, valid_to IS NULL, embedding IS NOT NULL
   *
   * 그룹 내 importance 최고 파편을 유지하고 나머지에 valid_to 설정.
   * 유지 파편에 supersedes 링크 생성, access_count 합산.
   *
   * @returns {Promise<number>} 압축된 파편 수
   */
  async compressOldFragments() {
    const pool = getPrimaryPool();
    if (!pool) return 0;

    const cfg      = MEMORY_CONFIG.compress || {};
    const ageDays  = cfg.ageDays  || 30;
    const minGroup = cfg.minGroup || 3;

    const candidates = await this._queryCompressCandidates(ageDays);
    if (candidates.rows.length === 0) return 0;

    const groups         = await this._buildCompressionGroups(candidates.rows, ageDays, minGroup);
    const compressedCount = await this._commitCompressionGroups(groups);

    if (compressedCount > 0) {
      logInfo(`[ConsolidatorGC] Compressed ${compressedCount} old fragments`);
    }

    return compressedCount;
  }

  /**
   * 압축 대상 파편 조회
   *
   * @param {number} ageDays - accessed_at 기준 최소 경과 일수
   * @returns {Promise<import("pg").QueryResult>}
   */
  async _queryCompressCandidates(ageDays) {
    return queryWithAgentVector("system",
      `SELECT id, topic, importance, access_count, embedding
       FROM ${SCHEMA}.fragments
       WHERE accessed_at < NOW() - make_interval(days => $1)
         AND importance < 0.5
         AND is_anchor IS NOT TRUE
         AND valid_to IS NULL
         AND embedding IS NOT NULL
       ORDER BY topic, importance DESC`,
      [ageDays]
    );
  }

  /**
   * 후보 파편 rows를 topic별로 그룹핑하고 KNN으로 압축 그룹을 형성한다.
   *
   * @param {Array}  rows     - _queryCompressCandidates 반환 rows
   * @param {number} ageDays  - KNN 이웃 조회 시 age 조건
   * @param {number} minGroup - 그룹 최소 크기
   * @returns {Promise<Array<Array>>} 압축 그룹 배열 (각 그룹은 파편 row 배열)
   */
  async _buildCompressionGroups(rows, ageDays, minGroup) {
    /** topic별 그룹핑 */
    const topicMap = new Map();
    for (const row of rows) {
      if (!row.topic) continue;
      if (!topicMap.has(row.topic)) topicMap.set(row.topic, []);
      topicMap.get(row.topic).push(row);
    }

    const allGroups  = [];

    for (const [topic, frags] of topicMap) {
      if (frags.length < minGroup) continue;

      /** KNN 그룹 형성: 각 파편에서 cos >= 0.80인 이웃 찾기 (배치 병렬화) */
      const assigned   = new Set();
      const BATCH_SIZE = 20;

      for (let i = 0; i < frags.length; i += BATCH_SIZE) {
        const batch           = frags.slice(i, i + BATCH_SIZE);
        const unassignedBatch = batch.filter(f => !assigned.has(f.id));
        if (unassignedBatch.length === 0) continue;

        const neighborResults = await Promise.all(
          unassignedBatch.map(frag =>
            queryWithAgentVector("system",
              `SELECT id, importance, access_count,
                      1 - (embedding <=> $1) AS cosine_similarity
               FROM ${SCHEMA}.fragments
               WHERE topic = $2
                 AND id != $3
                 AND embedding IS NOT NULL
                 AND valid_to IS NULL
                 AND accessed_at < NOW() - make_interval(days => $4)
                 AND importance < 0.5
                 AND is_anchor IS NOT TRUE
               ORDER BY embedding <=> $1
               LIMIT 10`,
              [frag.embedding, topic, frag.id, ageDays]
            ).catch(() => ({ rows: [] }))
          )
        );

        for (let j = 0; j < unassignedBatch.length; j++) {
          const frag      = unassignedBatch[j];
          const knnResult = neighborResults[j];
          if (assigned.has(frag.id)) continue;

          const group = [frag];
          assigned.add(frag.id);

          for (const neighbor of knnResult.rows) {
            if (assigned.has(neighbor.id)) continue;
            const cos = parseFloat(neighbor.cosine_similarity);
            if (cos < 0.80) break;
            if (group.length >= 10) break;
            group.push(neighbor);
            assigned.add(neighbor.id);
          }

          if (group.length >= minGroup) {
            allGroups.push(group);
          }
        }
      }
    }

    return allGroups;
  }

  /**
   * 압축 그룹을 DB에 커밋한다.
   *
   * 각 그룹의 importance 최고 파편을 유지(keeper)하고 나머지에 valid_to 설정 후
   * supersedes 링크 생성 및 access_count 합산.
   *
   * @param {Array<Array>} groups - _buildCompressionGroups 반환값
   * @returns {Promise<number>} 압축된(soft-deleted) 파편 수
   */
  async _commitCompressionGroups(groups) {
    let compressedCount = 0;

    for (const group of groups) {
      group.sort((a, b) => parseFloat(b.importance) - parseFloat(a.importance));
      const keeper      = group[0];
      const others      = group.slice(1);
      let totalAccess   = parseInt(keeper.access_count) || 0;

      for (const old of others) {
        totalAccess += parseInt(old.access_count) || 0;

        /** soft delete */
        await queryWithAgentVector("system",
          `UPDATE ${SCHEMA}.fragments SET valid_to = NOW() WHERE id = $1 AND valid_to IS NULL`,
          [old.id], "write"
        );

        /** supersedes 링크 */
        await queryWithAgentVector("system",
          `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight)
           VALUES ($1, $2, 'supersedes', 1)
           ON CONFLICT (from_id, to_id) DO UPDATE SET relation_type = 'supersedes'`,
          [keeper.id, old.id], "write"
        ).catch(() => {});

        compressedCount++;
      }

      /** access_count 합산 */
      await queryWithAgentVector("system",
        `UPDATE ${SCHEMA}.fragments SET access_count = $1 WHERE id = $2`,
        [totalAccess, keeper.id], "write"
      );
    }

    return compressedCount;
  }

  /**
   * search_events 30일 초과 레코드 정리
   * @returns {Promise<number>} 삭제된 행 수
   */
  async _gcSearchEvents() {
    const pool = getPrimaryPool();
    if (!pool) return 0;

    try {
      const result = await pool.query(
        `DELETE FROM agent_memory.search_events
         WHERE created_at < NOW() - INTERVAL '30 days'`
      );
      return result.rowCount || 0;
    } catch (err) {
      logWarn(`[ConsolidatorGC] search_events GC failed: ${err.message}`);
      return 0;
    }
  }
}
