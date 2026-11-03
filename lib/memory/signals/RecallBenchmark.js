/**
 * RecallBenchmark - 회상 품질 오프라인 정량 평가
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 골드셋은 (저장문 A, 질의 B) 패러프레이즈 쌍이다. A를 격리 스코프에 적재한 뒤
 * B로 recall하여 A의 순위를 구한다. 정답이 구성상 확정되므로 별도 라벨링 없이
 * Recall@k / MRR / HitRate를 산출할 수 있다.
 *
 * 격리: 전용 agentId와 workspace로만 적재하고 실행 종료 시 deleteByAgent로 회수한다.
 * 운영 파편은 읽지도 쓰지도 않는다.
 *
 * 시간 질의: 항목의 mention_days_ago로 적재 시각을 정하고, distractor 항목(질의 없음)은 적재만 해 같은 주제의
 * 다른 시점 기록으로 경쟁시킨다. time_range가 있으면 recall의 timeRange로 넘긴다.
 *
 * 격리 누출 탐지(isolationProbe): 같은 저장문을 다른 하네스 키의 같은 agentId, 같은 workspace 이름에 한 벌 더
 * 적재하고, 평가 키의 recall 결과에 그 파편이 하나라도 섞이면 위반으로 센다. workspace는 키 안의 이름일 뿐이라
 * 이름이 같아도 다른 키의 파편은 보이지 않아야 한다. 위반 수는 언제나 0이어야 한다.
 */

import { EmbeddingWorker }       from "../embedding/EmbeddingWorker.js";
import { queryWithAgentVector }  from "../../tools/db.js";
import { logWarn }               from "../../logger.js";
import { SCHEMA } from "../schema.js";
import { activeLinkCondition } from "../link/LinkVisibility.js";
import { computeRecallAt, computeMRR, percentile } from "./RecallRankStats.js";
import { computeContentHash } from "../../tools/embedding.js";
import { keyScopeNullable }   from "../keyScope.js";

export { computeRecallAt, computeMRR, percentile };

/** 골드셋 질의 분류. 지표를 이 축으로 분해한다. */
export const QUERY_CLASSES = ["exact_symbol", "concept_intent", "hybrid", "temporal"];

/** 격리 누출 탐지용 두 번째 하네스 키 접미사 */
export const ISOLATION_PROBE_SUFFIX = "-isolation-probe";

/** 질의가 있는 평가 항목(방해 항목 제외) */
export const queryEntries = (goldset) => goldset.filter((entry) => entry?.distractor !== true);

/**
 * 평가 행 배열에서 지표 묶음을 산출한다.
 *
 * @param {Array<{rank: number|null, latencyMs: number, queryClass: string}>} rows
 * @returns {Object}
 */
export function summarize(rows) {
  const ranks     = rows.map(r => r.rank);
  const latencies = rows.map(r => r.latencyMs).filter(v => Number.isFinite(v));

  const byClass = {};
  for (const cls of QUERY_CLASSES) {
    const subset = rows.filter(r => r.queryClass === cls);
    if (subset.length === 0) continue;
    byClass[cls] = {
      cases                : subset.length,
      offline_recall_at_1  : computeRecallAt(subset.map(r => r.rank), 1),
      offline_recall_at_5  : computeRecallAt(subset.map(r => r.rank), 5),
      offline_recall_at_10 : computeRecallAt(subset.map(r => r.rank), 10),
      offline_mrr          : computeMRR(subset.map(r => r.rank)),
    };
  }

  return {
    cases                : rows.length,
    offline_recall_at_1  : computeRecallAt(ranks, 1),
    offline_recall_at_5  : computeRecallAt(ranks, 5),
    offline_recall_at_10 : computeRecallAt(ranks, 10),
    offline_mrr          : computeMRR(ranks),
    offline_hit_rate_at_5: computeRecallAt(ranks, 5),
    misses               : ranks.filter(r => r === null).length,
    latency_ms           : {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length > 0 ? Math.max(...latencies) : null,
    },
    by_query_class       : byClass,
  };
}

/**
 * 기준선과 현재 실행의 임베딩 모델이 다른지 판정한다.
 * 기준선에 임베딩 정보가 없으면 판정하지 않는다.
 *
 * @param {{model?: string, dimensions?: number}|undefined} baselineEmbedding
 * @param {{model: string, dimensions: number}} current
 * @returns {string|null} 다르면 안내 문구, 같거나 판정 불가면 null
 */
export function embeddingMismatch(baselineEmbedding, current) {
  if (!baselineEmbedding || !baselineEmbedding.model) return null;

  const baseDim  = Number(baselineEmbedding.dimensions);
  const curDim   = Number(current.dimensions);
  const dimKnown = Number.isFinite(baseDim) && Number.isFinite(curDim);

  if (baselineEmbedding.model === current.model && (!dimKnown || baseDim === curDim)) return null;

  const describe = (model, dim) => Number.isFinite(dim) ? `${model}, ${dim}차원` : model;
  return `기준선 임베딩(${describe(baselineEmbedding.model, baseDim)})과 ` +
         `현재 임베딩(${describe(current.model, curDim)})이 다르다. isolated 수치는 모델 간에 비교하지 않는다.`;
}

/**
 * 두 지표 묶음을 비교하여 회귀 여부를 판정한다.
 *
 * @param {Object} baseline
 * @param {Object} current
 * @param {{recallTolerance?: number, latencyTolerance?: number}} [opts]
 * @returns {{regressed: boolean, deltas: Object, reasons: string[]}}
 */
export function compareToBaseline(baseline, current, opts = {}) {
  /** 같은 적재분 안에서는 회차 간 편차가 0이지만, 적재를 다시 하면 1pp 안팎으로 움직인다.
   *  허용 하락폭을 그 변동폭보다 좁게 잡으면 게이트가 잡음에 오작동한다. */
  const recallTolerance  = opts.recallTolerance  ?? 0.02;  // 2pp
  const latencyTolerance = opts.latencyTolerance ?? 0.15;  // 15%

  const reasons = [];
  const deltas  = {};

  const core = ["offline_recall_at_1", "offline_recall_at_5", "offline_recall_at_10", "offline_mrr"];
  const unavailable = core.filter(key => Object.hasOwn(current ?? {}, key) && !Number.isFinite(current?.[key]));
  if (unavailable.length > 0) {
    return {
      comparable: false,
      regressed : false,
      deltas,
      reasons   : [`현재 실행의 핵심 지표가 없어 비교할 수 없다: ${unavailable.join(", ")}`]
    };
  }

  for (const key of core) {
    const before = baseline?.[key];
    const after  = current?.[key];
    if (typeof before !== "number" || typeof after !== "number") continue;
    deltas[key] = after - before;
    if (after < before - recallTolerance) {
      reasons.push(`${key} ${before.toFixed(4)} -> ${after.toFixed(4)} (허용 하락폭 ${recallTolerance})`);
    }
  }

  const p95Before = baseline?.latency_ms?.p95;
  const p95After  = current?.latency_ms?.p95;
  if (Number.isFinite(p95Before) && Number.isFinite(p95After) && p95Before > 0) {
    deltas.latency_p95_ratio = p95After / p95Before;
    if (p95After > p95Before * (1 + latencyTolerance)) {
      reasons.push(`latency p95 ${p95Before}ms -> ${p95After}ms (허용 증가율 ${latencyTolerance})`);
    }
  }

  reasons.push(...isolationReasons(current));
  return { comparable: true, regressed: reasons.length > 0, deltas, reasons };
}

/**
 * 격리 위반은 허용 폭 없이 언제나 퇴행이다.
 *
 * @param {object} current
 * @returns {string[]}
 */
function isolationReasons(current) {
  const violations = current?.isolation?.violations;
  if (!Number.isFinite(violations) || violations === 0) return [];
  return [`isolation violations ${violations} (다른 키의 같은 workspace 이름 파편이 결과에 섞였다)`];
}

/**
 * 골드셋 항목의 형식을 검증한다. 실패 사유 배열을 반환하며 비어 있으면 유효하다.
 *
 * @param {Object} entry
 * @param {number} index
 * @returns {string[]}
 */
export function validateGoldsetEntry(entry, index) {
  const errors = [];
  const at     = `#${index + 1}`;

  if (!entry || typeof entry !== "object") return [`${at}: 객체가 아니다`];
  if (!entry.id || typeof entry.id !== "string")       errors.push(`${at}: id 누락`);
  if (!entry.store || typeof entry.store !== "string") errors.push(`${at}: store 누락`);
  if (entry.mention_days_ago !== undefined && !(Number.isInteger(entry.mention_days_ago) && entry.mention_days_ago >= 0)) {
    errors.push(`${at}: mention_days_ago는 0 이상의 정수다`);
  }
  if (entry.distractor === true) {
    if (entry.query !== undefined) errors.push(`${at}: distractor 항목은 query를 갖지 않는다`);
    return errors;
  }
  if (!entry.query || typeof entry.query !== "string") errors.push(`${at}: query 누락`);
  if (!QUERY_CLASSES.includes(entry.query_class))      errors.push(`${at}: query_class가 ${QUERY_CLASSES.join("|")} 중 하나가 아니다`);
  if (entry.store && entry.query && entry.store.trim() === entry.query.trim()) {
    errors.push(`${at}: store와 query가 동일하다 (패러프레이즈여야 한다)`);
  }
  return errors;
}

/**
 * 골드셋 전체를 검증한다. id 중복도 함께 잡는다.
 *
 * @param {Object[]} goldset
 * @returns {string[]}
 */
export function validateGoldset(goldset) {
  if (!Array.isArray(goldset) || goldset.length === 0) return ["골드셋이 비어 있다"];

  const errors = goldset.flatMap((e, i) => validateGoldsetEntry(e, i));
  const seen   = new Set();
  for (const entry of goldset) {
    if (!entry?.id) continue;
    if (seen.has(entry.id)) errors.push(`id 중복: ${entry.id}`);
    seen.add(entry.id);
  }
  return errors;
}

/**
 * 여러 회차의 지표에서 중앙값 요약을 만든다.
 * 단일 회차 변동에 결론이 좌우되지 않도록 회차별 최소·최대도 함께 남긴다.
 *
 * @param {Object[]} runs summarize 결과 배열
 * @returns {Object}
 */
export function medianMetrics(runs) {
  const pick = (key) => runs.map(r => r[key]).filter(v => typeof v === "number");
  const med  = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid    = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };

  const base = runs[runs.length - 1];
  const r5   = pick("offline_recall_at_5");

  return {
    ...base,
    offline_recall_at_1  : med(pick("offline_recall_at_1")),
    offline_recall_at_5  : med(r5),
    offline_recall_at_10 : med(pick("offline_recall_at_10")),
    offline_mrr          : med(pick("offline_mrr")),
    offline_hit_rate_at_5: med(r5),
    misses               : med(pick("misses")),
    latency_ms           : {
      p50: med(runs.map(r => r.latency_ms.p50).filter(Number.isFinite)),
      p95: med(runs.map(r => r.latency_ms.p95).filter(Number.isFinite)),
      max: Math.max(...runs.map(r => r.latency_ms.max ?? 0)),
    },
    spread               : {
      recall_at_5_min: r5.length ? Math.min(...r5) : null,
      recall_at_5_max: r5.length ? Math.max(...r5) : null,
      runs           : runs.length,
    },
  };
}

export class RecallBenchmark {
  /**
   * @param {import("../MemoryManager.js").MemoryManager} manager
   * @param {Object}  [opts]
   * @param {string}  [opts.agentId]      격리 agentId. 정리 시 이 값으로 일괄 삭제한다
   * @param {string}  [opts.workspace]    격리 workspace
   * @param {string}  [opts.topic]        적재 파편 topic
   * @param {number}  [opts.pageSize]     recall 결과 상한
   * @param {boolean} [opts.includeLinks] 연결 파편 포함 여부. 검색 순위만 재려면 false
   * @param {string|null} [opts.keyId]     격리 API 키 스코프. null이면 운영 코퍼스와 경쟁한다
   * @param {number}  [opts.ageSpreadDays] 0보다 크면 적재 파편의 mentionTime을 0~이 값-1일 전으로 흩는다. 0이면 적재 시각 그대로라
   *   골드셋이 언제나 가장 최근 파편이 되어 최근성 가중치의 영향을 재지 못한다
   */
  constructor(manager, opts = {}) {
    this.manager      = manager;
    this.agentId      = opts.agentId      ?? "benchmark-harness";
    this.workspace    = opts.workspace    ?? "__benchmark__";
    this.topic        = opts.topic        ?? "recall-benchmark";
    this.pageSize     = opts.pageSize     ?? 10;
    this.includeLinks = opts.includeLinks ?? false;
    this.tokenBudget  = opts.tokenBudget  ?? 4000;
    this.keyId        = opts.keyId !== undefined ? opts.keyId : "benchmark-harness-key";
    this.ageSpreadDays = Number.isInteger(opts.ageSpreadDays) && opts.ageSpreadDays > 0 ? opts.ageSpreadDays : 0;
    /** 격리 누출 탐지. 평가 키가 있어야 한다(마스터는 모든 키를 본다). */
    this.isolationProbe = opts.isolationProbe === true && this.keyId != null;
    this.probeKeyId     = this.isolationProbe ? `${this.keyId}${ISOLATION_PROBE_SUFFIX}` : null;
    /** 탐지용으로 적재한 파편 id */
    this.probeIds       = new Set();
  }

  /**
   * i번째 골드셋 항목의 mentionTime. 37은 365와 서로소라 항목 번호가 늘어도 같은 날에 몰리지 않는다(실행마다 같다).
   *
   * @param {number} index
   * @param {number} now
   * @returns {string|undefined}
   */
  _mentionTime(index, now, entry = null) {
    if (Number.isInteger(entry?.mention_days_ago)) return new Date(now - entry.mention_days_ago * 86400000).toISOString();
    if (this.ageSpreadDays === 0) return undefined;
    return new Date(now - ((index * 37) % this.ageSpreadDays) * 86400000).toISOString();
  }

  /**
   * 키 격리 파라미터를 만든다. keyId가 null이면 빈 객체를 반환해 마스터 스코프로 동작한다.
   *
   * @returns {Object}
   */
  _keyScope() {
    if (this.keyId == null) return {};
    return { _keyId: this.keyId, _groupKeyIds: [this.keyId] };
  }

  /**
   * 골드셋 저장문을 격리 스코프에 적재하고 id 대응표를 만든다.
   *
   * 적재 전에 같은 스코프의 잔여물을 먼저 회수한다. 실행이 중간에 종료되면
   * cleanup이 걸린 finally 블록이 실행되지 않아 적재분이 남는데, 그 상태로
   * 다음 실행이 적재하면 이전 파편이 방해 요소로 섞여 측정이 오염된다.
   *
   * @param {Object[]} goldset
   * @returns {Promise<Map<string, string>>} goldset.id -> fragment id
   */
  async seed(goldset) {
    await this.ensureHarnessKey();
    const stale = await this.cleanup();
    if (stale > 0) {
      logWarn(`[RecallBenchmark] 이전 실행 잔여 파편 ${stale}건을 회수하고 시작한다`);
    }

    const idMap = new Map();
    const now   = Date.now();

    for (const [index, entry] of goldset.entries()) {
      const mentionTime = this._mentionTime(index, now, entry);
      const res = await this.manager.remember({
        content    : entry.store,
        topic      : this.topic,
        type       : entry.type ?? "fact",
        keywords   : entry.keywords,
        importance : entry.importance ?? 0.7,
        agentId    : this.agentId,
        workspace  : this.workspace,
        source     : "recall-benchmark",
        ...(mentionTime ? { mentionTime } : {}),
        ...this._keyScope(),
      });

      const fragmentId = res?.id ?? res?.fragment?.id;
      if (!fragmentId) {
        logWarn(`[RecallBenchmark] seed 실패: ${entry.id}`);
        continue;
      }
      idMap.set(entry.id, fragmentId);
    }

    if (this.isolationProbe) await this._seedIsolationProbe(goldset, now);
    return idMap;
  }

  /**
   * 같은 저장문을 탐지 키의 같은 agentId, 같은 workspace 이름에 적재한다.
   *
   * @param {Object[]} goldset
   * @param {number} now
   */
  async _seedIsolationProbe(goldset, now) {
    await this._ensureKey(this.probeKeyId);
    for (const [index, entry] of goldset.entries()) {
      const mentionTime = this._mentionTime(index, now, entry);
      const res = await this.manager.remember({
        content    : entry.store,
        topic      : this.topic,
        type       : entry.type ?? "fact",
        keywords   : entry.keywords,
        importance : entry.importance ?? 0.7,
        agentId    : this.agentId,
        workspace  : this.workspace,
        source     : "recall-benchmark-isolation-probe",
        ...(mentionTime ? { mentionTime } : {}),
        _keyId     : this.probeKeyId,
        _groupKeyIds: [this.probeKeyId]
      });
      const id = res?.id ?? res?.fragment?.id;
      if (id) this.probeIds.add(id);
    }
  }

  /**
   * --no-seed 실행에서 탐지 키에 남아 있는 탐지 파편 id를 읽는다.
   *
   * @param {Object[]} goldset
   */
  async _resolveIsolationProbe(goldset) {
    const hashes = goldset.map(entry => computeContentHash(entry.store));
    for (const row of await this._rowsByHash(hashes, this.probeKeyId)) this.probeIds.add(row.id);
  }

  /**
   * 격리 스코프(agentId, workspace, 키)에서 content_hash가 맞는 살아 있는 파편.
   *
   * @param {string[]} hashes
   * @param {string|null} keyId
   * @returns {Promise<Array<{ id: string, content_hash: string }>>}
   */
  async _rowsByHash(hashes, keyId) {
    const params = [hashes, this.agentId, this.workspace];
    const keyClause = keyScopeNullable(params, "key_id", keyId);
    const { rows } = await queryWithAgentVector(this.agentId,
      `SELECT id, content_hash
         FROM ${SCHEMA}.fragments
        WHERE content_hash = ANY($1::text[])
          AND agent_id = $2
          AND workspace IS NOT DISTINCT FROM $3
          ${keyClause}
          AND valid_to IS NULL`,
      params
    );
    return rows;
  }

  /** 이미 적재된 격리 스코프에서 골드셋 저장문을 content_hash로 정확히 대응시킨다. */
  async resolveExisting(goldset) {
    const hashes = goldset.map(entry => computeContentHash(entry.store));
    const rows   = await this._rowsByHash(hashes, this.keyId);
    const byHash = new Map();
    for (const row of rows) {
      const list = byHash.get(row.content_hash) ?? [];
      list.push(row.id);
      byHash.set(row.content_hash, list);
    }
    const idMap = new Map();
    const invalid = [];
    goldset.forEach((entry, index) => {
      const matches = byHash.get(hashes[index]) ?? [];
      if (matches.length !== 1) invalid.push(`${entry.id}(${matches.length === 0 ? "누락" : `중복 ${matches.length}건`})`);
      else idMap.set(entry.id, matches[0]);
    });
    if (invalid.length > 0) {
      throw new Error(`--no-seed 평가 스코프를 골드셋과 정확히 매핑할 수 없다: ${invalid.slice(0, 20).join(", ")}`);
    }
    return idMap;
  }

  /**
   * 적재한 파편의 임베딩이 채워질 때까지 대기한다.
   * 비동기 워커에 의존하지 않고 직접 생성 루프를 돌린다.
   *
   * @param {string[]} fragmentIds
   * @param {{maxRounds?: number, batch?: number}} [opts]
   * @returns {Promise<{embedded: number, pending: number}>}
   */
  async ensureEmbeddings(fragmentIds, opts = {}) {
    const maxRounds = opts.maxRounds ?? 30;
    const batch     = opts.batch     ?? 50;
    const worker    = new EmbeddingWorker();

    for (let round = 0; round < maxRounds; round++) {
      const pending = await this._countMissingEmbeddings(fragmentIds);
      if (pending === 0) return { embedded: fragmentIds.length, pending: 0 };
      const processed = await worker.processOrphanFragments(batch);
      if (processed === 0) break;
    }

    const pending = await this._countMissingEmbeddings(fragmentIds);
    return { embedded: fragmentIds.length - pending, pending };
  }

  /**
   * 주어진 id 중 embedding이 비어 있는 건수를 센다.
   *
   * @param {string[]} fragmentIds
   * @returns {Promise<number>}
   */
  async _countMissingEmbeddings(fragmentIds) {
    if (fragmentIds.length === 0) return 0;
    const { rows } = await queryWithAgentVector(this.agentId,
      `SELECT COUNT(*)::int AS cnt
         FROM ${SCHEMA}.fragments
        WHERE id = ANY($1) AND embedding IS NULL`,
      [fragmentIds]
    );
    return rows[0]?.cnt ?? 0;
  }

  /**
   * 골드셋 질의를 실행하고 정답 파편의 순위를 기록한다.
   *
   * @param {Object[]}            goldset
   * @param {Map<string, string>} idMap
   * @returns {Promise<Array<{id: string, queryClass: string, rank: number|null, latencyMs: number, returned: number}>>}
   */
  async evaluate(goldset, idMap) {
    const rows = [];

    for (const entry of queryEntries(goldset)) {
      const expectedId = idMap.get(entry.id);
      if (!expectedId) continue;

      const startedAt = Date.now();
      let fragments   = [];

      try {
        const res = await this.manager.recall({
          text         : entry.query,
          agentId      : this.agentId,
          workspace    : this.workspace,
          tokenBudget  : this.tokenBudget,
          pageSize     : this.pageSize,
          includeLinks : this.includeLinks,
          excludeSeen  : false,
          ...(entry.time_range ? { timeRange: entry.time_range } : {}),
          ...this._keyScope(),
        });
        fragments = res?.fragments ?? [];
      } catch (err) {
        logWarn(`[RecallBenchmark] recall 실패 (${entry.id}): ${err.message}`);
      }

      const latencyMs = Date.now() - startedAt;
      const idx       = fragments.findIndex(f => f.id === expectedId);

      rows.push({
        id         : entry.id,
        queryClass : entry.query_class,
        query      : entry.query,
        rank       : idx >= 0 ? idx + 1 : null,
        latencyMs,
        returned   : fragments.length,
        ...(this.isolationProbe ? { isolationViolations: fragments.filter(f => this.probeIds.has(f.id)).length } : {}),
      });
    }

    return rows;
  }

  /**
   * 적재한 파편에 대해 합성 역질의를 생성한다.
   *
   * 워커의 주기 실행을 기다리지 않고 대상만 지정해 즉시 처리한다.
   * 계측에서 생성 여부를 통제 변수로 다루기 위한 경로다.
   *
   * @param {string[]} fragmentIds
   * @returns {Promise<{processed: number, generated: number}>}
   */
  async generateSynthetic(fragmentIds) {
    try {
      const { getSyntheticQueryWorker } = await import("../embedding/SyntheticQueryWorker.js");
      return await getSyntheticQueryWorker().generateForFragmentIds(fragmentIds);
    } catch (err) {
      logWarn(`[RecallBenchmark] 합성 역질의 생성 실패: ${err.message}`);
      return { processed: 0, generated: 0 };
    }
  }

  /**
   * 격리 키 스코프가 가리키는 api_keys 행이 없으면 만든다.
   *
   * 파편의 key_id는 api_keys(id)를 참조하므로, 키 행이 없는 새 DB에서는 적재가
   * 외래 키 제약으로 실패한다. 이 행은 inactive 상태이고 key_hash가 어떤 키의
   * 해시와도 같아질 수 없는 값이라 인증에 쓰이지 않는다. 같은 id나 이름의 행이
   * 이미 있으면 그대로 둔다.
   *
   * @returns {Promise<void>}
   */
  async ensureHarnessKey() {
    await this._ensureKey(this.keyId);
  }

  /**
   * 비활성 하네스 키 행을 만든다(이미 있으면 그대로).
   *
   * @param {string|null} keyId
   */
  async _ensureKey(keyId) {
    if (keyId == null) return;
    await queryWithAgentVector(this.agentId,
      `INSERT INTO ${SCHEMA}.api_keys (id, name, key_hash, key_prefix, status)
       VALUES ($1, $1, 'harness:' || $1, 'harness', 'inactive')
       ON CONFLICT DO NOTHING`,
      [keyId]
    );
  }

  /**
   * 격리 스코프의 파편을 전량 삭제한다.
   *
   * @returns {Promise<number>} 삭제 건수
   */
  async cleanup() {
    try {
      /** FragmentWriter.deleteByAgent는 rowCount(숫자)를 그대로 돌려준다. 같은 agentId로 도는 다른 키의 실행은 남긴다. */
      const res = await this.manager.deleteByAgent(this.agentId, { keyId: this.keyId ?? null, workspace: this.workspace });
      const probe = this.probeKeyId
        ? await this.manager.deleteByAgent(this.agentId, { keyId: this.probeKeyId, workspace: this.workspace })
        : 0;
      const count = (r) => (typeof r === "number" ? r : (r?.deleted ?? r?.count ?? 0));
      return count(res) + count(probe);
    } catch (err) {
      logWarn(`[RecallBenchmark] cleanup 실패: ${err.message}`);
      return 0;
    }
  }

  /**
   * 적재 직후의 비동기 후처리(형태소 등록, ProactiveRecall 링크 생성)가 끝나기를 기다린다.
   *
   * 이 대기를 생략하면 평가 시점마다 fragment_links의 상태가 달라지고, L2.5 그래프
   * 레이어가 회차마다 다른 이웃을 주입해 같은 코드에서도 순위가 흔들린다.
   *
   * 고정 시간 대기는 서버 부하에 따라 충분하지 않을 수 있으므로, 적재분에 걸린
   * 링크 수가 더 늘지 않을 때까지 관측한 뒤 진행한다.
   *
   * @param {string[]} fragmentIds
   * @param {{pollMs?: number, stableRounds?: number, maxWaitMs?: number}} [opts]
   * @returns {Promise<{links: number, waitedMs: number, stable: boolean}>}
   */
  async settle(fragmentIds = [], opts = {}) {
    const pollMs       = opts.pollMs       ?? 1000;
    const stableRounds = opts.stableRounds ?? 3;
    const maxWaitMs    = opts.maxWaitMs    ?? 30000;

    if (typeof this.manager.drainMorpheme === "function") {
      // iron-laws: ignore[IL-301] 형태소 대기열 비우기 실패 시 안정화 대기로 넘어간다
      await this.manager.drainMorpheme().catch(() => {});
    }

    if (fragmentIds.length === 0) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      return { links: 0, waitedMs: pollMs, stable: true };
    }

    const startedAt = Date.now();
    let   previous  = -1;
    let   stable    = 0;
    let   current   = 0;

    while (Date.now() - startedAt < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      current = await this._countLinks(fragmentIds);

      if (current === previous) {
        stable += 1;
        if (stable >= stableRounds) {
          return { links: current, waitedMs: Date.now() - startedAt, stable: true };
        }
      } else {
        stable = 0;
      }
      previous = current;
    }

    return { links: current, waitedMs: Date.now() - startedAt, stable: false };
  }

  /**
   * 적재분에 연결된 링크 수를 센다. 후처리 정착 판정 기준이다.
   *
   * @param {string[]} fragmentIds
   * @returns {Promise<number>}
   */
  async _countLinks(fragmentIds) {
    try {
      const { rows } = await queryWithAgentVector(this.agentId,
        `SELECT COUNT(*)::int AS cnt
           FROM ${SCHEMA}.fragment_links l
          WHERE (l.from_id = ANY($1) OR l.to_id = ANY($1)) AND ${activeLinkCondition("l")}`,
        [fragmentIds]
      );
      return rows[0]?.cnt ?? 0;
    // iron-laws: ignore[IL-301] 벤치 보조 지표라 조회 실패 시 0으로 표시한다
    } catch {
      return 0;
    }
  }

  /**
   * seed -> ensureEmbeddings -> settle -> evaluate(xN) -> cleanup 전체 실행.
   *
   * repeat를 2 이상으로 두면 같은 적재분에 대해 평가만 반복한다. 적재 편차를 배제한
   * 순수 검색 변동폭을 관측할 수 있다.
   *
   * @param {Object[]} goldset
   * @param {{seed?: boolean, cleanup?: boolean, repeat?: number, settle?: Object, synthetic?: boolean, onProgress?: Function}} [opts]
   * @returns {Promise<Object>} 지표 묶음 + 개별 행 + 회차별 요약
   */
  async run(goldset, opts = {}) {
    const doSeed    = opts.seed    !== false;
    const doCleanup = opts.cleanup !== false;
    const repeat    = Math.max(1, opts.repeat ?? 1);
    const notify    = typeof opts.onProgress === "function" ? opts.onProgress : () => {};

    let idMap      = new Map();
    let embedding  = { embedded: 0, pending: 0 };
    let settleInfo = { links: 0, waitedMs: 0, stable: true };
    let synthetic  = null;

    try {
      if (doSeed) {
        notify({ stage: "seed", total: goldset.length });
        idMap = await this.seed(goldset);

        notify({ stage: "embed", total: idMap.size });
        embedding = await this.ensureEmbeddings([...idMap.values()]);

        if (opts.synthetic) {
          notify({ stage: "synthetic", total: idMap.size });
          synthetic = await this.generateSynthetic([...idMap.values()]);
        }

        notify({ stage: "settle" });
        settleInfo = await this.settle([...idMap.values()], opts.settle);
      } else {
        notify({ stage: "resolve-existing", total: goldset.length });
        idMap = await this.resolveExisting(goldset);
        if (this.isolationProbe) await this._resolveIsolationProbe(goldset);
        const pending = await this._countMissingEmbeddings([...idMap.values()]);
        embedding = { embedded: idMap.size - pending, pending };
      }

      const runs = [];
      let   last = [];

      for (let i = 0; i < repeat; i++) {
        notify({ stage: "evaluate", total: idMap.size, round: i + 1, of: repeat });
        last = await this.evaluate(goldset, idMap);
        runs.push(summarize(last));
      }

      const metrics = runs.length === 1 ? runs[0] : medianMetrics(runs);
      const coreMetrics = [metrics.offline_recall_at_1, metrics.offline_recall_at_5, metrics.offline_recall_at_10, metrics.offline_mrr];
      const queryCount  = queryEntries(goldset).length;
      if (idMap.size !== goldset.length || last.length !== queryCount || coreMetrics.some(value => !Number.isFinite(value))) {
        throw new Error(`벤치마크 평가 불완전: expected=${goldset.length} queries=${queryCount} mapped=${idMap.size} evaluated=${last.length}`);
      }
      if (this.isolationProbe) {
        metrics.isolation = {
          probes    : this.probeIds.size,
          violations: last.reduce((n, r) => n + (r.isolationViolations ?? 0), 0)
        };
      }

      return {
        generated_at: new Date().toISOString(),
        goldset_size: goldset.length,
        seeded      : idMap.size,
        evaluated   : last.length,
        repeat,
        embedding,
        settle      : settleInfo,
        ...(synthetic ? { synthetic } : {}),
        metrics,
        runs        : runs.map(r => ({
          offline_recall_at_1 : r.offline_recall_at_1,
          offline_recall_at_5 : r.offline_recall_at_5,
          offline_recall_at_10: r.offline_recall_at_10,
          offline_mrr         : r.offline_mrr,
          misses              : r.misses,
          latency_p95         : r.latency_ms.p95,
        })),
        rows        : last,
      };
    } finally {
      if (doCleanup && doSeed) {
        notify({ stage: "cleanup" });
        await this.cleanup();
      }
    }
  }
}
