/**
 * ContradictionDetector — 모순 감지, 대체 관계 감지, 보류 큐 처리
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 * 수정일: 2026-10-20 (LLM 판정 쌍의 제시 순서를 쌍 해시로 정함)
 */

import crypto from "node:crypto";
import { queryWithAgentVector } from "../../tools/db.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../../gemini.js";
import { detectContradiction as nliDetect, isNLIAvailable } from "../signals/NLIClassifier.js";
import { logInfo, logWarn, logDebug } from "../../logger.js";
import { SCHEMA, DEINDEX_COLUMNS } from "../schema.js";
import { deindexRows } from "../FragmentIndex.js";
import { auditProvenance } from "./AuditProvenance.js";
import { isReviewHeld, notPendingReviewSql } from "../read/ReviewVisibility.js";
import { CONTRADICTION_AUDIT_TOPIC, contradictionAuditContent } from "./contradictionAudit.js";
import { EgressSkippedError } from "../../llm/EgressPolicy.js";
import { statedAtMs } from "../WorldTime.js";

/**
 * LLM 판정에 넘길 두 파편의 제시 순서. 같은 쌍은 어느 쪽에서 불러도 같은 순서가 되고,
 * 쌍마다 해시로 순서가 갈려 id가 작은 쪽이나 새 파편이 늘 A로 가지 않는다.
 * 두 판정(모순, 대체 관계)은 대칭이라 순서를 바꿔도 결과를 되돌릴 필요가 없다.
 *
 * @param {{ id: string, content: string }} a
 * @param {{ id: string, content: string }} b
 * @returns {[string, string]} [파편 A 본문, 파편 B 본문]
 */
export function judgeOrder(a, b) {
  const [lo, hi] = String(a.id) <= String(b.id) ? [a, b] : [b, a];
  const flip     = crypto.createHash("sha256").update(`${lo.id}\0${hi.id}`).digest()[0] & 1;
  return flip ? [hi.content, lo.content] : [lo.content, hi.content];
}

/** 모순 해소 기록 파편의 topic과 본문 함수. 모순·대체 탐지 대상에서 빼고, forget 삭제 연쇄가 찾는다. */
export { CONTRADICTION_AUDIT_TOPIC, contradictionAuditContent };

/** 관계 판단 메서드가 공유하는 system prompt — 외부 LLM이 JSON 객체만 출력 */
const CONTRADICTION_SYSTEM_PROMPT =
  "You are a JSON object generator for knowledge fragment relation analysis. " +
  "Your ONLY output MUST be a valid JSON object matching the exact schema specified by the user. " +
  "Do NOT include markdown fences, explanations, reasoning outside the specified schema, preambles, or ANY other text. " +
  "Output must be directly parseable by JSON.parse(). " +
  "The reasoning field must be a single concise Korean sentence.";

/**
 * 두 파편의 외부 전송 정책 문맥. 두 파편은 같은 키에 속하고, workspace는 둘 다 정책 판정에 쓴다.
 *
 * @param {{ key_id?: string|null, workspace?: string|null }} a
 * @param {{ workspace?: string|null }} b
 * @returns {{ stage: string, keyId: string|null, workspaces: Array<string|null> }}
 */
function pairEgress(a, b) {
  return { stage: "contradiction", keyId: a.key_id ?? null, workspaces: [a.workspace ?? null, b.workspace ?? null] };
}

/** 외부 전송 정책으로 건너뛴 판정은 디버그로, 그 밖의 실패는 경고로 남긴다. */
function logJudgeFailure(message, err) {
  if (err instanceof EgressSkippedError) logDebug(`${message}: ${err.message}`);
  else logWarn(`${message}: ${err.message}`);
}

/** 동일 파편 쌍에 대한 최대 모순 검사 횟수 */
export const MAX_CONTRADICTION_DEPTH = 3;

/** 처리에 반복 실패하는 파편이 뒤 파편의 검사를 막지 않도록 둔 파편별 실패 횟수 상한 */
export const MAX_FRAG_FAILURES = 3;

/** @type {Map<string, number>} 파편 id 별 연속 처리 실패 횟수 */
const failureCounts = new Map();

/** Redis 가 없거나 값을 읽지 못할 때 프로세스 안에서 쓰는 워터마크 */
let memoryWatermark = null;

/** 대체 관계 탐지: 한 주기에 보는 새 파편 수, 파편당 이웃 수, 유사도 구간, LLM 판정 쌍 수, 첫 실행의 되돌아보기 */
export const SUPERSESSION_SCAN_LIMIT          = 1000;
export const SUPERSESSION_NEIGHBORS           = 20;
export const SUPERSESSION_BAND                = Object.freeze([0.7, 0.85]);
/** 대체 관계 이웃을 한 질의로 묻는 파편 수. 임베딩을 문자열로 넘기므로 묶음 크기를 제한한다. */
export const SUPERSESSION_LOOKUP_BATCH       = 100;
export const SUPERSESSION_JUDGE_LIMIT         = 10;
export const SUPERSESSION_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SUPERSESSION_CHECK_KEY = "frag:supersession_check_at";

let supersessionMemoryWatermark = null;

/**
 * 워터마크 문자열을 해석한다.
 * "<마이크로초 ISO>|<파편 id>" 형식이면 (created_at, id) 쌍 비교에 쓰고,
 * id 가 없는 시각 문자열이면 created_at 만 비교한다.
 *
 * @param {string|null} raw
 * @returns {{at: string, id: string|null}|null}
 */
function parseWatermark(raw) {
  if (!raw) return null;
  const s   = String(raw);
  const sep = s.indexOf("|");
  if (sep < 0) return { at: s, id: null };
  return { at: s.slice(0, sep), id: s.slice(sep + 1) };
}

/**
 * 처리 완료 파편의 워터마크 문자열. 시각은 DB 가 준 마이크로초 문자열을 그대로 써
 * 같은 created_at 을 가진 파편 묶음에서도 id 로 순서를 이어 간다.
 *
 * @param {{id: string, created_at: Date|string, watermark_at?: string}} frag
 * @returns {string}
 */
function watermarkOf(frag) {
  const at = frag.watermark_at ?? new Date(frag.created_at).toISOString();
  return `${at}|${frag.id}`;
}

export class ContradictionDetector {
  /**
   * @param {import("../write/FragmentStore.js").FragmentStore} store
   * @param {{rememberAudit?: ((params: object) => Promise<unknown>)|null}} [deps]
   */
  constructor(store, { rememberAudit = null } = {}) {
    this.store         = store;
    this.rememberAudit = rememberAudit;

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
    const { redisClient } = await import("../../redis.js");
    const LAST_CHECK_KEY  = "frag:contradiction_check_at";
    const PENDING_KEY     = "frag:pending_contradictions";

    let lastCheckAt = null;
    try {
      if (redisClient && redisClient.status === "ready") {
        const val   = await redisClient.get(LAST_CHECK_KEY);
        lastCheckAt = val || null;
      }
    } catch (err) { logWarn(`[ContradictionDetector] Redis lastCheckAt read failed: ${err.message}`); }
    if (!lastCheckAt) lastCheckAt = memoryWatermark;
    const watermark = parseWatermark(lastCheckAt);

    let newFragsQuery = `
      SELECT id, content, topic, type, importance, embedding, created_at, mention_time, key_id, workspace, is_anchor,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS watermark_at
      FROM ${SCHEMA}.fragments
      WHERE embedding IS NOT NULL
        AND valid_to IS NULL${notPendingReviewSql()}
        AND topic IS DISTINCT FROM '${CONTRADICTION_AUDIT_TOPIC}'`;

    const params = [];
    if (watermark?.id) {
      params.push(watermark.at, watermark.id);
      newFragsQuery += ` AND (created_at, id) > ($1::timestamptz, $2::text)`;
    } else if (watermark) {
      params.push(watermark.at);
      newFragsQuery += ` AND created_at > $1`;
    }
    newFragsQuery += ` ORDER BY created_at ASC, id ASC LIMIT 20`;

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
    /** 오래된 것부터 훑으므로, 처리에 실패한 파편 이후로는 워터마크를 전진시키지 않는다.
     *  같은 파편이 MAX_FRAG_FAILURES 번 실패하면 경고를 남기고 처리된 것으로 본다. */
    let   blocked         = false;

    for (const newFrag of newFrags.rows) {
      let fragOk = true;
      try {
        const candidates = await queryWithAgentVector("system",
          `SELECT c.id, c.content, c.topic, c.type, c.importance,
                  c.created_at, c.mention_time, c.is_anchor, c.key_id, c.workspace,
                  1 - (c.embedding <=> (SELECT embedding FROM ${SCHEMA}.fragments WHERE id = $1)) AS similarity
           FROM ${SCHEMA}.fragments c
           WHERE c.id != $1
             AND c.topic = $2
             AND c.embedding IS NOT NULL
             AND c.valid_to IS NULL${notPendingReviewSql("c")}
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

        // iron-laws: ignore[PERF-102] 안쪽 반복 대상의 크기가 작게 제한돼 있다
        for (const candidate of (candidates.rows || [])) {
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

                continue;
              }

              if (!nliResult.contradicts && !nliResult.needsEscalation) {
                nliSkipped++;

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
            const verdict = await this.askGeminiContradiction(...judgeOrder(newFrag, candidate), pairEgress(newFrag, candidate));
            if (verdict.contradicts) {
              await this.resolveContradiction(newFrag, candidate, verdict.reasoning);
              found++;
            }
          } catch (err) {
            fragOk = false;
            logWarn(`[ContradictionDetector] Gemini contradiction check failed: ${err.message}`);
          }
        }
      } catch (err) {
        fragOk = false;
        logWarn(`[ContradictionDetector] fragment ${newFrag.id} check failed: ${err.message}`);
      }

      if (fragOk) {
        failureCounts.delete(newFrag.id);
      } else {
        const failures = (failureCounts.get(newFrag.id) ?? 0) + 1;
        if (failures >= MAX_FRAG_FAILURES) {
          failureCounts.delete(newFrag.id);
          fragOk = true;
          logWarn(`[ContradictionDetector] fragment ${newFrag.id} skipped after ${failures} failed checks`);
        } else {
          failureCounts.set(newFrag.id, failures);
        }
      }

      if (fragOk && !blocked) latestProcessed = watermarkOf(newFrag);
      else blocked = true;
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
   * 오래된 쪽을 superseded_by로 잇고 닫는다. 앵커는 만료 대상에서 제외되는 고정
   * 파편이므로 모순이어도 닫지 않는다. 해소 기록은 탐지 대상에서 빠지는 별도
   * topic에 남겨, 기록끼리 다시 모순으로 판정되는 재귀를 막는다.
   *
   * 양쪽 파편의 key_id가 다른 경우(cross-tenant) 처리를 거부하여
   * 한 테넌트가 다른 테넌트의 파편을 무효화하는 경로를 차단한다.
   *
   * @param {object} newFrag
   * @param {object} candidate
   * @param {string} reasoning
   */
  async resolveContradiction(newFrag, candidate, reasoning) {
    /** 검토 대기나 거절 파편은 다른 파편을 대체하거나 닫지 않고, 그 자신도 이 경로로 닫히지 않는다. */
    if (isReviewHeld(newFrag) || isReviewHeld(candidate)) {
      logInfo(`[ContradictionDetector] Contradiction skipped (review held): ${newFrag.id} <-> ${candidate.id}`);
      return;
    }
    /** cross-tenant 보호: key_id가 다르면 처리 거부 */
    const nk = newFrag.key_id   ?? null;
    const ck = candidate.key_id ?? null;
    if (nk !== ck) {
      logWarn(`[ContradictionDetector] Cross-tenant resolveContradiction blocked: ` +
              `${newFrag.id}(key=${nk}) vs ${candidate.id}(key=${ck})`);
      return;
    }

    /** 선후는 말한 시각으로 정한다. 지난 대화를 늦게 가져와도 나중에 말한 쪽이 이긴다. */
    const newerIsNew = statedAtMs(newFrag) > statedAtMs(candidate);
    const winner     = newerIsNew ? newFrag   : candidate;
    const loser      = newerIsNew ? candidate : newFrag;

    if (loser.is_anchor) {
      await this.store.createLink(newFrag.id, candidate.id, "contradicts", "system");
      logInfo(`[ContradictionDetector] Contradiction kept (anchor): ${loser.id} <-> ${winner.id}: ${reasoning}`);
      return;
    }

    /**
     * 단계마다 따로 커밋되므로 중간에 실패해도 다시 돌리면 끝까지 가도록 순서를 둔다. 대체 링크는 upsert라
     * 반복해도 같고, 중요도 반감과 닫기는 아직 닫히지 않은 행에만 한 번 일어난다. 재탐지를 막는 contradicts
     * 링크는 패자를 닫은 뒤에 만든다. 먼저 만들면 닫기가 실패했을 때 다시 탐지되지 않는다.
     */
    await this.store.createLink(loser.id, winner.id, "superseded_by", "system");
    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments SET importance = importance * 0.5, valid_to = NOW()
       WHERE id = $1 AND valid_to IS NULL RETURNING ${DEINDEX_COLUMNS}`,
      [loser.id], "write"
    ).then(r => deindexRows(r.rows));
    await this.store.createLink(newFrag.id, candidate.id, "contradicts", "system");

    await this.recordResolutionAudit(winner, loser, reasoning, {
      topic: CONTRADICTION_AUDIT_TOPIC, keywords: newFrag.keywords, logPrefix: "ContradictionDetector"
    });

    logInfo(`[ContradictionDetector] Contradiction resolved: ${newFrag.id} <-> ${candidate.id}: ${reasoning}`);
  }

  /**
   * 모순 해소 감사 파편을 remember로 남긴다. 패자와 승자 본문 앞 80자와 판단 근거를 담고, 키 상한은
   * 두 원본 중 낮은 등급이다(auditProvenance). 기록 실패는 경고로 남기고 해소를 되돌리지 않는다.
   *
   * @param {{id: string, content?: string}} winner
   * @param {{id: string, content?: string}} loser
   * @param {string} reasoning
   * @param {{topic: string, keywords?: string[], logPrefix: string}} options
   */
  async recordResolutionAudit(winner, loser, reasoning, { topic, keywords, logPrefix }) {
    try {
      if (typeof this.rememberAudit !== "function") {
        logWarn(`[${logPrefix}] Contradiction audit record skipped: rememberAudit dependency is not configured`);
        return;
      }

      await this.rememberAudit({
        content   : contradictionAuditContent(loser, winner, reasoning),
        type      : "decision",
        topic,
        keywords  : ["contradiction", "superseded", "resolved", ...(keywords || []).slice(0, 3)],
        importance: 0.6,
        isAnchor  : false,
        linkedTo  : [winner.id, loser.id],
        ...await auditProvenance(this.store, [winner.id, loser.id])
      });
    } catch (auditErr) {
      logWarn(`[${logPrefix}] Contradiction audit record failed: ${auditErr.message}`);
    }
  }

  /**
   * 대체 관계 후보 탐지.
   *
   * 워터마크 이후 새로 들어온 파편을 오래된 순으로 최대 SUPERSESSION_SCAN_LIMIT개 보고, 파편마다 같은
   * topic + type + key_id 안의 가까운 이웃 SUPERSESSION_NEIGHBORS개 중 유사도 0.7~0.85 구간이면서
   * 아직 링크가 없는 파편을 후보로 모은다. 후보 쌍 가운데 유사도가 높은 SUPERSESSION_JUDGE_LIMIT쌍만
   * Gemini CLI에 "대체 관계인가?"를 묻는다.
   *
   * 같은 key_id끼리만 짝지어 cross-tenant 파편 쌍이 supersession 대상이 되지 않게 한다. 새 파편과
   * 기존 파편의 쌍만 보므로 매 주기 전체 쌍을 다시 비교하지 않는다.
   *
   * @returns {Promise<number>} 감지된 supersession 수
   */
  async detectSupersessions() {
    const cliAvail = await isGeminiCLIAvailable();
    if (!cliAvail) return 0;

    const { redisClient } = await import("../../redis.js");
    const watermark = parseWatermark(await this._readSupersessionWatermark(redisClient)
      ?? new Date(Date.now() - SUPERSESSION_INITIAL_LOOKBACK_MS).toISOString());

    const params = [watermark.at];
    let   since  = "created_at > $1::timestamptz";
    if (watermark.id) {
      params.push(watermark.id);
      since = "(created_at, id) > ($1::timestamptz, $2::text)";
    }
    params.push(SUPERSESSION_SCAN_LIMIT);
    const newFrags = await queryWithAgentVector("system",
      `SELECT id, content, topic, type, key_id, workspace, embedding::text AS embedding,
              COALESCE(mention_time, created_at) AS stated_at, created_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS watermark_at
       FROM ${SCHEMA}.fragments
       WHERE embedding IS NOT NULL
         AND valid_to IS NULL${notPendingReviewSql()}
         AND topic IS DISTINCT FROM '${CONTRADICTION_AUDIT_TOPIC}'
         AND ${since}
       ORDER BY created_at ASC, id ASC
       LIMIT $${params.length}`,
      params
    );
    if (!newFrags.rows || newFrags.rows.length === 0) return 0;

    const { pairs, latestProcessed } = await this._collectSupersessionPairs(newFrags.rows);
    if (latestProcessed) await this._writeSupersessionWatermark(redisClient, latestProcessed);

    const judged = [...pairs.values()]
      .sort((x, y) => y.similarity - x.similarity)
      .slice(0, SUPERSESSION_JUDGE_LIMIT);
    if (judged.length === 0) return 0;

    let detected = 0;

    for (const pair of judged) {
      try {
        const verdict = await this.askGeminiSupersession(
          ...judgeOrder({ id: pair.id_a, content: pair.content_a }, { id: pair.id_b, content: pair.content_b }),
          pairEgress({ key_id: pair.key_id, workspace: pair.workspace_a }, { workspace: pair.workspace_b })
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
             WHERE id = $1 AND valid_to IS NULL RETURNING ${DEINDEX_COLUMNS}`,
            [older.id], "write"
          ).then(r => deindexRows(r.rows));

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
   * 새 파편들의 이웃을 묶음마다 한 번의 질의로 조회해 후보 쌍을 모은다. 같은 쌍은 한 번만 담는다.
   * 조회가 실패한 묶음부터는 워터마크를 전진시키지 않아 다음 주기에 다시 본다.
   *
   * @returns {Promise<{pairs: Map<string, Object>, latestProcessed: string|null}>}
   */
  async _collectSupersessionPairs(frags) {
    const pairs = new Map();
    let   latestProcessed = null;
    for (let i = 0; i < frags.length; i += SUPERSESSION_LOOKUP_BATCH) {
      const chunk = frags.slice(i, i + SUPERSESSION_LOOKUP_BATCH);
      let neighbors;
      try {
        neighbors = await this._supersessionNeighbors(chunk);
      } catch (err) {
        logWarn(`[ContradictionDetector] Supersession candidate lookup failed: ${err.message}`);
        break;
      }
      for (const frag of chunk) {
        for (const c of neighbors.get(frag.id) ?? []) {
          const key = frag.id < c.id ? `${frag.id}|${c.id}` : `${c.id}|${frag.id}`;
          if (pairs.has(key)) continue;
          pairs.set(key, {
            id_a: frag.id, content_a: frag.content, created_a: frag.stated_at,
            id_b: c.id,    content_b: c.content,    created_b: c.stated_at,
            key_id: frag.key_id ?? null, workspace_a: frag.workspace ?? null, workspace_b: c.workspace ?? null,
            similarity: c.similarity
          });
        }
      }
      latestProcessed = watermarkOf(chunk.at(-1));
    }
    return { pairs, latestProcessed };
  }

  /**
   * 파편마다 대체 관계 후보 이웃. 같은 topic, type, key_id의 가까운 이웃 중 유사도 구간에 들고
   * 아직 링크가 없는 유효 파편. 파편마다 따로 묻지 않고 LATERAL로 한 번에 조회한다.
   *
   * @param {Array<{id: string, topic: string, type: string, key_id: string|null, embedding: string}>} frags
   * @returns {Promise<Map<string, Array<{id: string, content: string, stated_at: Date, workspace: string|null, similarity: number}>>>}
   */
  async _supersessionNeighbors(frags) {
    const { rows } = await queryWithAgentVector("system",
      `SELECT s.src_id, c.id, c.content, c.stated_at, c.workspace, c.similarity
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
              AS s(src_id, embedding, topic, type, key_id)
       CROSS JOIN LATERAL (
         SELECT c.id, c.content, COALESCE(c.mention_time, c.created_at) AS stated_at, c.workspace,
                1 - (c.embedding <=> s.embedding::vector) AS similarity
         FROM ${SCHEMA}.fragments c
         WHERE c.id != s.src_id
           AND c.topic = s.topic
           AND c.type = s.type
           AND c.key_id IS NOT DISTINCT FROM s.key_id
           AND c.embedding IS NOT NULL
           AND c.valid_to IS NULL${notPendingReviewSql("c")}
           AND NOT EXISTS (
             SELECT 1 FROM ${SCHEMA}.fragment_links fl
             WHERE (fl.from_id = s.src_id AND fl.to_id = c.id)
                OR (fl.from_id = c.id AND fl.to_id = s.src_id)
           )
         ORDER BY c.embedding <=> s.embedding::vector
         LIMIT $6
       ) c`,
      [
        frags.map(f => f.id), frags.map(f => String(f.embedding)), frags.map(f => f.topic),
        frags.map(f => f.type), frags.map(f => f.key_id ?? null), SUPERSESSION_NEIGHBORS
      ]
    );
    const byFragment = new Map();
    for (const r of rows) {
      const similarity = parseFloat(r.similarity);
      if (similarity < SUPERSESSION_BAND[0] || similarity > SUPERSESSION_BAND[1]) continue;
      const list = byFragment.get(r.src_id) ?? [];
      list.push({ id: r.id, content: r.content, stated_at: r.stated_at, workspace: r.workspace, similarity });
      byFragment.set(r.src_id, list);
    }
    return byFragment;
  }

  /** 대체 관계 탐지 워터마크. Redis가 없으면 프로세스 안의 값을 쓴다. */
  async _readSupersessionWatermark(redisClient) {
    try {
      if (redisClient && redisClient.status === "ready") {
        const val = await redisClient.get(SUPERSESSION_CHECK_KEY);
        if (val) return val;
      }
    } catch (err) { logWarn(`[ContradictionDetector] Supersession watermark read failed: ${err.message}`); }
    return supersessionMemoryWatermark;
  }

  async _writeSupersessionWatermark(redisClient, value) {
    supersessionMemoryWatermark = value;
    try {
      if (redisClient && redisClient.status === "ready") await redisClient.set(SUPERSESSION_CHECK_KEY, value);
    } catch (err) { logWarn(`[ContradictionDetector] Supersession watermark update failed: ${err.message}`); }
  }

  /**
   * Gemini CLI에 두 파편의 대체 관계 판단 요청
   *
   * @param {string} contentA
   * @param {string} contentB
   * @param {{ stage: string, keyId?: string|null, workspaces?: Array<string|null> }} [egress] - 외부 전송 정책 문맥
   * @returns {Promise<{supersedes: boolean, reasoning: string}>}
   */
  async askGeminiSupersession(contentA, contentB, egress = { stage: "contradiction" }) {
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
        systemPrompt: CONTRADICTION_SYSTEM_PROMPT,
        egress
      });
    } catch (err) {
      logJudgeFailure("[ContradictionDetector] Gemini supersession parse failed", err);
      return { supersedes: false, reasoning: "Gemini CLI 응답 파싱 실패" };
    }
  }

  /**
   * Gemini CLI로 두 파편의 모순 여부를 판단 요청
   *
   * @param {string} contentA
   * @param {string} contentB
   * @param {{ stage: string, keyId?: string|null, workspaces?: Array<string|null> }} [egress] - 외부 전송 정책 문맥
   * @returns {Promise<{contradicts: boolean, reasoning: string}>}
   */
  async askGeminiContradiction(contentA, contentB, egress = { stage: "contradiction" }) {
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
        systemPrompt: CONTRADICTION_SYSTEM_PROMPT,
        egress
      });
    } catch (err) {
      logJudgeFailure("[ContradictionDetector] Gemini CLI parse failed", err);
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

    const { redisClient } = await import("../../redis.js");
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

        /** 판정 전에 두 파편을 읽어 외부 전송 정책 문맥(키, workspace)을 얻는다. 없어진 파편 쌍은 판정하지 않는다. */
        const fragAResult = await queryWithAgentVector("system",
          `SELECT id, content, created_at, mention_time, is_anchor, key_id, workspace, review_state FROM ${SCHEMA}.fragments WHERE id = $1`,
          [entry.idA]
        );
        const fragBResult = await queryWithAgentVector("system",
          `SELECT id, content, created_at, mention_time, is_anchor, key_id, workspace, review_state FROM ${SCHEMA}.fragments WHERE id = $1`,
          [entry.idB]
        );
        if (!fragAResult.rows.length || !fragBResult.rows.length) continue;

        const verdict = await this.askGeminiContradiction(
          ...judgeOrder({ id: entry.idA, content: entry.contentA }, { id: entry.idB, content: entry.contentB }),
          pairEgress(fragAResult.rows[0], fragBResult.rows[0])
        );

        if (verdict.contradicts) {
          /** resolveContradiction 내부에서 cross-tenant 보호가 적용됨 */
          await this.resolveContradiction(fragAResult.rows[0], fragBResult.rows[0], verdict.reasoning);
          processed++;
        }
      } catch (err) {
        logWarn(`[ContradictionDetector] Pending contradiction processing failed: ${err.message}`);
        try {
          await redisClient.rpush(PENDING_KEY, raw);
        } catch (requeueErr) {
          logWarn(`[ContradictionDetector] Pending contradiction requeue failed, item dropped: ${requeueErr.message}`);
        }
        break;
      }
    }

    if (processed > 0) {
      logInfo(`[ContradictionDetector] Processed ${processed} pending contradictions`);
    }
    return processed;
  }

  /**
   * 모순 탐지 워터마크 갱신. Redis 가 없어도 프로세스 안의 값은 항상 갱신한다.
   *
   * @param {object}      redisClient
   * @param {string}      key
   * @param {string|Date} timestamp - "<시각>|<파편 id>" 워터마크 또는 시각
   */
  async updateContradictionTimestamp(redisClient, key, timestamp) {
    const ts = timestamp instanceof Date ? timestamp.toISOString()
             : (typeof timestamp === "string" ? timestamp : new Date().toISOString());
    memoryWatermark = ts;
    try {
      if (redisClient && redisClient.status === "ready") {
        await redisClient.set(key, ts);
      }
    } catch (err) { logWarn(`[ContradictionDetector] Contradiction timestamp update failed: ${err.message}`); }
  }
}
