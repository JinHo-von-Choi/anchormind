/**
 * ContradictionDetector — 모순 감지, 대체 관계 감지, 보류 큐 처리
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 */

import { queryWithAgentVector } from "../tools/db.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../gemini.js";
import { detectContradiction as nliDetect, isNLIAvailable } from "./NLIClassifier.js";
import { logInfo, logWarn, logDebug } from "../logger.js";

/** 관계 판단 메서드가 공유하는 system prompt — 외부 LLM이 JSON 객체만 출력 */
const CONTRADICTION_SYSTEM_PROMPT =
  "You are a JSON object generator for knowledge fragment relation analysis. " +
  "Your ONLY output MUST be a valid JSON object matching the exact schema specified by the user. " +
  "Do NOT include markdown fences, explanations, reasoning outside the specified schema, preambles, or ANY other text. " +
  "Output must be directly parseable by JSON.parse(). " +
  "The reasoning field must be a single concise Korean sentence.";

const SCHEMA = "agent_memory";

/** 동일 파편 쌍에 대한 최대 모순 검사 횟수 */
export const MAX_CONTRADICTION_DEPTH = 3;

export class ContradictionDetector {
  /**
   * @param {import("./write/FragmentStore.js").FragmentStore} store
   */
  constructor(store) {
    this.store = store;

    /** @type {Map<string, number>} 파편 쌍별 검사 횟수 추적 */
    this._checkedPairs = new Map();
  }

  /**
   * consolidate 사이클 시작 시 호출하여 추적 상태 초기화
   */
  resetCheckedPairs() {
    this._checkedPairs.clear();
  }

  /**
   * 파편 쌍의 검사 가능 여부를 확인하고 카운트를 증가시킨다.
   * MAX_CONTRADICTION_DEPTH 이상이면 false를 반환하여 검사를 스킵한다.
   *
   * @param {string} idA
   * @param {string} idB
   * @returns {boolean} 검사 진행 가능 여부
   */
  _acquirePairCheck(idA, idB) {
    const a   = idA < idB ? idA : idB;
    const b   = idA < idB ? idB : idA;
    const key = `${a}_${b}`;

    const count = this._checkedPairs.get(key) || 0;
    if (count >= MAX_CONTRADICTION_DEPTH) {
      logDebug(`[ContradictionDetector] Pair ${key} reached depth limit (${MAX_CONTRADICTION_DEPTH}), skipping`);
      return false;
    }
    this._checkedPairs.set(key, count + 1);
    return true;
  }

  /**
   * 최근 파편 중 증분 모순 탐지 (NLI → Gemini CLI 3단계 파이프라인)
   *
   * 후보 SELECT는 newFrag.key_id와 동일한 파편만 대상으로 하여
   * cross-tenant 모순 검출을 차단한다.
   *
   * @returns {Promise<{found: number, nliResolved: number, nliSkipped: number}>}
   */
  async detectContradictions() {
    const { redisClient } = await import("../redis.js");
    const LAST_CHECK_KEY  = "frag:contradiction_check_at";
    const PENDING_KEY     = "frag:pending_contradictions";

    let lastCheckAt = null;
    try {
      if (redisClient && redisClient.status === "ready") {
        const val   = await redisClient.get(LAST_CHECK_KEY);
        lastCheckAt = val || null;
      }
    } catch (err) { logWarn(`[ContradictionDetector] Redis lastCheckAt read failed: ${err.message}`); }

    let newFragsQuery = `
      SELECT id, content, topic, type, importance, embedding, created_at, key_id
      FROM ${SCHEMA}.fragments
      WHERE embedding IS NOT NULL`;

    const params = [];
    if (lastCheckAt) {
      params.push(lastCheckAt);
      newFragsQuery += ` AND created_at > $1`;
    }
    newFragsQuery += ` ORDER BY created_at DESC LIMIT 20`;

    const newFrags = await queryWithAgentVector("system", newFragsQuery, params);

    if (!newFrags.rows || newFrags.rows.length === 0) {
      return 0;
    }

    const nliAvail = isNLIAvailable();
    const cliAvail = await isGeminiCLIAvailable();
    let   found           = 0;
    let   nliResolved     = 0;
    let   nliSkipped      = 0;
    let   latestProcessed = null;

    for (const newFrag of newFrags.rows) {
      const candidates = await queryWithAgentVector("system",
        `SELECT c.id, c.content, c.topic, c.type, c.importance,
                c.created_at, c.is_anchor,
                1 - (c.embedding <=> (SELECT embedding FROM ${SCHEMA}.fragments WHERE id = $1)) AS similarity
         FROM ${SCHEMA}.fragments c
         WHERE c.id != $1
           AND c.topic = $2
           AND c.embedding IS NOT NULL
           AND c.key_id IS NOT DISTINCT FROM $3
           AND 1 - (c.embedding <=> (SELECT embedding FROM ${SCHEMA}.fragments WHERE id = $1)) > 0.85
           AND NOT EXISTS (
             SELECT 1 FROM ${SCHEMA}.fragment_links fl
             WHERE ((fl.from_id = $1 AND fl.to_id = c.id)
                 OR (fl.from_id = c.id AND fl.to_id = $1))
               AND fl.relation_type = 'contradicts'
           )
         ORDER BY similarity DESC
         LIMIT 3`,
        [newFrag.id, newFrag.topic, newFrag.key_id ?? null]
      );

      if (!candidates.rows || candidates.rows.length === 0) continue;

      for (const candidate of candidates.rows) {
        if (!this._acquirePairCheck(newFrag.id, candidate.id)) {
          continue;
        }

        if (nliAvail) {
          const nliResult = await nliDetect(newFrag.content, candidate.content);

          if (nliResult) {
            if (nliResult.contradicts && !nliResult.needsEscalation) {
              await this.resolveContradiction(newFrag, candidate,
                `NLI contradiction (conf=${nliResult.confidence.toFixed(3)})`);
              found++;
              nliResolved++;

              if (!latestProcessed || newFrag.created_at > latestProcessed) {
                latestProcessed = newFrag.created_at;
              }
              continue;
            }

            if (!nliResult.contradicts && !nliResult.needsEscalation) {
              nliSkipped++;

              if (!latestProcessed || newFrag.created_at > latestProcessed) {
                latestProcessed = newFrag.created_at;
              }
              continue;
            }
          }
        }

        if (!cliAvail) {
          if (parseFloat(candidate.similarity) > 0.92) {
            await this.flagPotentialContradiction(
              redisClient, PENDING_KEY, newFrag, candidate
            );
          }
          continue;
        }

        try {
          const verdict = await this.askGeminiContradiction(newFrag.content, candidate.content);
          if (verdict.contradicts) {
            await this.resolveContradiction(newFrag, candidate, verdict.reasoning);
            found++;
          }
          if (!latestProcessed || newFrag.created_at > latestProcessed) {
            latestProcessed = newFrag.created_at;
          }
        } catch (err) {
          logWarn(`[ContradictionDetector] Gemini contradiction check failed: ${err.message}`);
        }
      }
    }

    if (latestProcessed) {
      await this.updateContradictionTimestamp(redisClient, LAST_CHECK_KEY, latestProcessed);
    }

    if (nliResolved > 0 || nliSkipped > 0) {
      logInfo(`[ContradictionDetector] NLI stats: ${nliResolved} resolved, ${nliSkipped} skipped (saved ${nliResolved + nliSkipped} Gemini calls)`);
    }

    return { found, nliResolved, nliSkipped };
  }

  /**
   * 모순 확인 시 contradicts 링크 + 시간 논리 기반 해소
   *
   * 양쪽 파편의 key_id가 다른 경우(cross-tenant) 처리를 거부하여
   * 한 테넌트가 다른 테넌트의 파편을 무효화하는 경로를 차단한다.
   *
   * @param {object} newFrag
   * @param {object} candidate
   * @param {string} reasoning
   */
  async resolveContradiction(newFrag, candidate, reasoning) {
    /** cross-tenant 보호: key_id가 다르면 처리 거부 */
    const nk = newFrag.key_id   ?? null;
    const ck = candidate.key_id ?? null;
    if (nk !== ck) {
      logWarn(`[ContradictionDetector] Cross-tenant resolveContradiction blocked: ` +
              `${newFrag.id}(key=${nk}) vs ${candidate.id}(key=${ck})`);
      return;
    }

    await this.store.createLink(newFrag.id, candidate.id, "contradicts", "system");

    const newDate = new Date(newFrag.created_at);
    const oldDate = new Date(candidate.created_at);

    if (newDate > oldDate) {
      if (!candidate.is_anchor) {
        await queryWithAgentVector("system",
          `UPDATE ${SCHEMA}.fragments SET importance = importance * 0.5 WHERE id = $1`,
          [candidate.id], "write"
        );
      }
      await this.store.createLink(candidate.id, newFrag.id, "superseded_by", "system");
      await queryWithAgentVector("system",
        `UPDATE ${SCHEMA}.fragments SET valid_to = NOW()
         WHERE id = $1 AND valid_to IS NULL`,
        [candidate.id], "write"
      );
    } else {
      await queryWithAgentVector("system",
        `UPDATE ${SCHEMA}.fragments SET importance = importance * 0.5 WHERE id = $1`,
        [newFrag.id], "write"
      );
      await this.store.createLink(newFrag.id, candidate.id, "superseded_by", "system");
      await queryWithAgentVector("system",
        `UPDATE ${SCHEMA}.fragments SET valid_to = NOW()
         WHERE id = $1 AND valid_to IS NULL`,
        [newFrag.id], "write"
      );
    }

    try {
      const winner  = newDate > oldDate ? newFrag   : candidate;
      const loser   = newDate > oldDate ? candidate : newFrag;
      const { MemoryManager } = await import("./MemoryManager.js");
      const mgr = MemoryManager.getInstance();

      await mgr.remember({
        content   : `[모순 해결] "${(loser.content  || "").substring(0, 80)}" 파편이 "${(winner.content || "").substring(0, 80)}" 으로 대체됨. 판단 근거: ${reasoning || "시간 순서 기준"}`,
        type      : "decision",
        topic     : newFrag.topic || "contradiction",
        keywords  : ["contradiction", "superseded", "resolved", ...(newFrag.keywords || []).slice(0, 3)],
        importance: 0.6,
        isAnchor  : false,
        linkedTo  : [winner.id, loser.id]
      });
    } catch (auditErr) {
      logWarn(`[ContradictionDetector] Contradiction audit record failed: ${auditErr.message}`);
    }

    logInfo(`[ContradictionDetector] Contradiction resolved: ${newFrag.id} <-> ${candidate.id}: ${reasoning}`);
  }

  /**
   * 같은 topic + type + key_id이면서 임베딩 유사도 0.7~0.85 구간의 파편 쌍을 대상으로
   * Gemini CLI에 "대체 관계인가?" 판단을 요청한다.
   *
   * JOIN 조건에 `a.key_id IS NOT DISTINCT FROM b.key_id`를 추가하여
   * cross-tenant 파편 쌍이 supersession 대상이 되지 않도록 차단한다.
   *
   * @returns {Promise<number>} 감지된 supersession 수
   */
  async detectSupersessions() {
    const cliAvail = await isGeminiCLIAvailable();
    if (!cliAvail) return 0;

    const candidates = await queryWithAgentVector("system",
      `SELECT a.id AS id_a, a.content AS content_a, a.created_at AS created_a,
              b.id AS id_b, b.content AS content_b, b.created_at AS created_b,
              1 - (a.embedding <=> b.embedding) AS similarity
       FROM ${SCHEMA}.fragments a
       JOIN ${SCHEMA}.fragments b ON a.topic = b.topic
                                  AND a.type = b.type
                                  AND a.id < b.id
                                  AND a.key_id IS NOT DISTINCT FROM b.key_id
       WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
         AND a.valid_to IS NULL AND b.valid_to IS NULL
         AND 1 - (a.embedding <=> b.embedding) BETWEEN 0.7 AND 0.85
         AND NOT EXISTS (
           SELECT 1 FROM ${SCHEMA}.fragment_links fl
           WHERE (fl.from_id = a.id AND fl.to_id = b.id)
              OR (fl.from_id = b.id AND fl.to_id = a.id)
         )
       ORDER BY similarity DESC
       LIMIT 10`,
      []
    );

    if (!candidates.rows || candidates.rows.length === 0) return 0;

    let detected = 0;

    for (const pair of candidates.rows) {
      try {
        const verdict = await this.askGeminiSupersession(
          pair.content_a, pair.content_b
        );

        if (verdict.supersedes) {
          const older = new Date(pair.created_a) < new Date(pair.created_b)
            ? { id: pair.id_a, content: pair.content_a, created_at: pair.created_a }
            : { id: pair.id_b, content: pair.content_b, created_at: pair.created_b };
          const newer = older.id === pair.id_a
            ? { id: pair.id_b, content: pair.content_b, created_at: pair.created_b }
            : { id: pair.id_a, content: pair.content_a, created_at: pair.created_a };

          await this.store.createLink(older.id, newer.id, "superseded_by", "system");
          await queryWithAgentVector("system",
            `UPDATE ${SCHEMA}.fragments
             SET valid_to = NOW(), importance = GREATEST(0.05, importance * 0.5)
             WHERE id = $1 AND valid_to IS NULL`,
            [older.id], "write"
          );

          logInfo(`[ContradictionDetector] Supersession: ${older.id} -> ${newer.id}: ${verdict.reasoning}`);
          detected++;
        }
      } catch (err) {
        logWarn(`[ContradictionDetector] Supersession check failed: ${err.message}`);
      }
    }

    return detected;
  }

  /**
   * Gemini CLI에 두 파편의 대체 관계 판단 요청
   *
   * @param {string} contentA
   * @param {string} contentB
   * @returns {Promise<{supersedes: boolean, reasoning: string}>}
   */
  async askGeminiSupersession(contentA, contentB) {
    const userPrompt = `두 개의 지식 파편이 "대체 관계"인지 판단하라.

파편 A: "${contentA}"
파편 B: "${contentB}"

대체 관계란: 동일 주제에 대해 한쪽이 다른 쪽의 정보를 갱신·교체·전환한 경우.
예: "cron으로 스케줄링" -> "Airflow로 전환" = 대체 관계
예: "Redis 캐시 사용" + "Redis 포트 6379" = 보완 관계 (대체 아님)

반드시 다음 JSON 형식으로만 응답하라:
{"supersedes": true 또는 false, "reasoning": "판단 근거 1문장"}`;

    try {
      return await geminiCLIJson(userPrompt, {
        timeoutMs   : 40_000,
        systemPrompt: CONTRADICTION_SYSTEM_PROMPT
      });
    } catch (err) {
      logWarn(`[ContradictionDetector] Gemini supersession parse failed: ${err.message}`);
      return { supersedes: false, reasoning: "Gemini CLI 응답 파싱 실패" };
    }
  }

  /**
   * Gemini CLI로 두 파편의 모순 여부를 판단 요청
   *
   * @param {string} contentA
   * @param {string} contentB
   * @returns {Promise<{contradicts: boolean, reasoning: string}>}
   */
  async askGeminiContradiction(contentA, contentB) {
    const userPrompt = `두 개의 지식 파편이 서로 모순되는지 판단하라.

파편 A: "${contentA}"
파편 B: "${contentB}"

모순이란: 동일 주제에 대해 서로 양립 불가능한 주장을 하는 경우.
유사하지만 보완적인 정보는 모순이 아니다.
시간 경과에 의한 정보 갱신도 모순으로 판단한다 (구 정보 vs 신 정보).

예시:
A: "데이터베이스 포트는 5432"
B: "데이터베이스 포트는 15432"
응답: {"contradicts": true, "reasoning": "동일 포트 필드에 대해 서로 다른 값을 주장함"}

A: "Redis는 캐시로 사용"
B: "Redis는 세션 저장소로 사용"
응답: {"contradicts": false, "reasoning": "Redis의 상이한 활용 사례로 양립 가능"}

반드시 다음 JSON 형식으로만 응답하라:
{"contradicts": true 또는 false, "reasoning": "판단 근거 1문장"}`;

    try {
      return await geminiCLIJson(userPrompt, {
        timeoutMs   : 40_000,
        systemPrompt: CONTRADICTION_SYSTEM_PROMPT
      });
    } catch (err) {
      logWarn(`[ContradictionDetector] Gemini CLI parse failed: ${err.message}`);
      return { contradicts: false, reasoning: "Gemini CLI 응답 파싱 실패" };
    }
  }

  /**
   * CLI 불가 시 고유사도 쌍을 pending 큐에 적재
   *
   * @param {object}      redisClient
   * @param {string}      key
   * @param {object}      fragA
   * @param {object}      fragB
   */
  async flagPotentialContradiction(redisClient, key, fragA, fragB) {
    try {
      if (redisClient && redisClient.status === "ready") {
        const entry = JSON.stringify({
          idA:       fragA.id,
          idB:       fragB.id,
          contentA:  fragA.content,
          contentB:  fragB.content,
          flaggedAt: new Date().toISOString()
        });
        await redisClient.rpush(key, entry);
        logDebug(`[ContradictionDetector] Flagged potential contradiction: ${fragA.id} <-> ${fragB.id}`);
      }
    } catch (err) {
      logWarn(`[ContradictionDetector] Failed to flag contradiction: ${err.message}`);
    }
  }

  /**
   * pending 큐의 모순 후보들을 Gemini CLI로 재처리
   *
   * @returns {Promise<number>} 처리된 모순 수
   */
  async processPendingContradictions() {
    if (!(await isGeminiCLIAvailable())) return 0;

    const { redisClient } = await import("../redis.js");
    const PENDING_KEY     = "frag:pending_contradictions";

    if (!redisClient || redisClient.status !== "ready") return 0;

    let processed = 0;
    const batchSize = 10;

    for (let i = 0; i < batchSize; i++) {
      const raw = await redisClient.lpop(PENDING_KEY);
      if (!raw) break;

      try {
        const entry = JSON.parse(raw);

        if (!this._acquirePairCheck(entry.idA, entry.idB)) {
          continue;
        }

        const verdict = await this.askGeminiContradiction(entry.contentA, entry.contentB);

        if (verdict.contradicts) {
          const fragAResult = await queryWithAgentVector("system",
            `SELECT id, content, created_at, is_anchor, key_id FROM ${SCHEMA}.fragments WHERE id = $1`,
            [entry.idA]
          );
          const fragBResult = await queryWithAgentVector("system",
            `SELECT id, content, created_at, is_anchor, key_id FROM ${SCHEMA}.fragments WHERE id = $1`,
            [entry.idB]
          );

          if (fragAResult.rows.length && fragBResult.rows.length) {
            /** resolveContradiction 내부에서 cross-tenant 보호가 적용됨 */
            await this.resolveContradiction(fragAResult.rows[0], fragBResult.rows[0], verdict.reasoning);
            processed++;
          }
        }
      } catch (err) {
        logWarn(`[ContradictionDetector] Pending contradiction processing failed: ${err.message}`);
        try { await redisClient.rpush(PENDING_KEY, raw); } catch { /* 무시 */ }
        break;
      }
    }

    if (processed > 0) {
      logInfo(`[ContradictionDetector] Processed ${processed} pending contradictions`);
    }
    return processed;
  }

  /**
   * 모순 탐지 타임스탬프 갱신
   *
   * @param {object}      redisClient
   * @param {string}      key
   * @param {string|Date} timestamp
   */
  async updateContradictionTimestamp(redisClient, key, timestamp) {
    try {
      if (redisClient && redisClient.status === "ready") {
        const ts = timestamp instanceof Date ? timestamp.toISOString()
                 : (typeof timestamp === "string" ? timestamp : new Date().toISOString());
        await redisClient.set(key, ts);
      }
    } catch (err) { logWarn(`[ContradictionDetector] Contradiction timestamp update failed: ${err.message}`); }
  }
}
