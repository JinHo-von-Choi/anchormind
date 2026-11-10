/**
 * ActionBenchmark - 갱신된 사실로 도구 인자를 채우는 행동 기반 평가
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * 검색 점수가 높아도 에이전트가 기억한 값으로 행동을 제대로 하는지는 따로 재야 한다(MERIT 2609.05441,
 * Mem2ActBench). 이 평가는 도구 인자 하나(예: 배포 대상 호스트)가 여러 번 갱신된 뒤 recall의 1순위 파편으로
 * 인자를 채운다고 보고, 그 값이 최신 값인지 센다. 리더 모델을 쓰지 않아 결과가 결정적이고 비용이 들지 않는다.
 *
 *   항목  {id, arg, query, template, updates[], keywords?}
 *         template의 {v} 자리에 updates를 차례로 넣어 저장한다. 마지막 값이 정답이다
 *   방식  slot   remember에 slot(arg)을 주고 recall의 slot으로 찾는다(쓸 때 갱신)
 *         plain  slot 없이 저장하고 recall의 text(query)와 keywords로 찾는다(읽을 때 검색)
 *   판정  correct 1순위 본문에 최신 값이 있다. stale 1순위 본문에 이전 값만 있다. miss 그 밖
 *   비용  recall 한 번의 반환 토큰(totalTokens), 반환 파편 수, 지연(밀리초)
 *
 * 격리: 전용 agentId, workspace, 비활성 하네스 키로만 적재하고 방식마다 시작과 끝에 회수한다.
 */

import { RecallBenchmark } from "./RecallBenchmark.js";
import { percentile }      from "./RecallRankStats.js";

/** 평가 방식 */
export const ACTION_ARMS = Object.freeze(["slot", "plain"]);

/** 갱신 사이의 말한 시각 간격(분). 갱신 순서를 세계 시각으로도 남긴다. */
const UPDATE_SPACING_MINUTES = 5;

/**
 * 항목을 검사한다. 같은 항목 안에서 한 값이 다른 값의 일부이면 판정이 모호하므로 거부한다.
 *
 * @param {Object[]} goldset
 * @returns {string[]} 오류 목록
 */
export function validateActionGoldset(goldset) {
  const errors = [];
  const ids    = new Set();
  for (const [i, e] of (goldset ?? []).entries()) {
    const at = `#${i + 1}(${e?.id ?? "?"})`;
    if (ids.has(e?.id)) errors.push(`${at}: id가 중복된다`);
    ids.add(e?.id);
    errors.push(...entryProblems(e).map(p => `${at}: ${p}`));
  }
  return errors;
}

const nonEmpty = (v) => typeof v === "string" && v !== "";

/**
 * 항목 하나의 문제 목록.
 *
 * @param {Object} e
 * @returns {string[]}
 */
function entryProblems(e) {
  const problems = [];
  for (const field of ["id", "arg", "query"]) if (!nonEmpty(e?.[field])) problems.push(`${field}가 없다`);
  if (!nonEmpty(e?.template) || !e.template.includes("{v}")) problems.push("template에 {v}가 없다");
  if (!Array.isArray(e?.updates) || e.updates.length < 2) return [...problems, "updates는 값 2개 이상이다"];
  const values = e.updates.map(String);
  for (const a of values) {
    if (values.some(b => b !== a && b.includes(a))) problems.push(`값 ${a}가 다른 값의 일부라 판정이 모호하다`);
  }
  return problems;
}

/**
 * 1순위 본문을 판정한다.
 *
 * @param {string|null} content
 * @param {string[]} updates
 * @returns {"correct"|"stale"|"miss"}
 */
export function judgeTop(content, updates) {
  if (typeof content !== "string") return "miss";
  const latest = String(updates[updates.length - 1]);
  if (content.includes(latest)) return "correct";
  return updates.slice(0, -1).some(v => content.includes(String(v))) ? "stale" : "miss";
}

/**
 * 방식 하나의 집계.
 *
 * @param {Array<{verdict: string, tokens: number, count: number, latencyMs: number}>} rows
 * @returns {Object}
 */
export function summarizeArm(rows) {
  const n     = rows.length;
  const count = (v) => rows.filter(r => r.verdict === v).length;
  const lat   = rows.map(r => r.latencyMs).sort((a, b) => a - b);
  const mean  = (xs) => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
  return {
    n,
    correct     : count("correct"),
    stale       : count("stale"),
    miss        : count("miss"),
    accuracy    : n === 0 ? null : count("correct") / n,
    staleRate   : n === 0 ? null : count("stale") / n,
    tokensMean  : mean(rows.map(r => r.tokens)),
    fragmentsMean: mean(rows.map(r => r.count)),
    latencyP50Ms: n === 0 ? null : percentile(lat, 50),
    latencyP95Ms: n === 0 ? null : percentile(lat, 95)
  };
}

export class ActionBenchmark {
  /**
   * @param {Object} manager - MemoryManager
   * @param {{agentId?: string, workspace?: string, keyId?: string, pageSize?: number, tokenBudget?: number}} [opts]
   */
  constructor(manager, opts = {}) {
    this.manager     = manager;
    this.agentId     = opts.agentId     ?? "action-benchmark";
    this.workspace   = opts.workspace   ?? "__action_benchmark__";
    this.keyId       = opts.keyId       ?? "action-benchmark-key";
    this.pageSize    = opts.pageSize    ?? 5;
    this.tokenBudget = opts.tokenBudget ?? 2000;
    this.harness     = new RecallBenchmark(manager, { agentId: this.agentId, workspace: this.workspace, keyId: this.keyId });
  }

  /** @returns {Object} 하네스 키 범위 인자 */
  _scope() {
    return { agentId: this.agentId, workspace: this.workspace, _keyId: this.keyId, _groupKeyIds: [this.keyId] };
  }

  /**
   * 항목의 갱신을 차례로 저장한다.
   *
   * @param {Object} entry
   * @param {"slot"|"plain"} arm
   * @param {number} now
   */
  async _store(entry, arm, now) {
    const n = entry.updates.length;
    for (const [i, value] of entry.updates.entries()) {
      await this.manager.remember({
        content    : entry.template.replaceAll("{v}", String(value)),
        topic      : "action-benchmark",
        type       : "fact",
        importance : 0.6,
        source     : "action-benchmark",
        mentionTime: new Date(now - (n - i) * UPDATE_SPACING_MINUTES * 60_000).toISOString(),
        ...(Array.isArray(entry.keywords) ? { keywords: entry.keywords } : {}),
        ...(arm === "slot" ? { slot: entry.arg } : {}),
        ...this._scope()
      });
    }
  }

  /**
   * 인자를 채울 기억을 찾고 1순위를 판정한다.
   *
   * @param {Object} entry
   * @param {"slot"|"plain"} arm
   * @returns {Promise<{id: string, verdict: string, tokens: number, count: number, latencyMs: number, top: string|null}>}
   */
  async _act(entry, arm) {
    const query = arm === "slot"
      ? { slot: entry.arg }
      : { text: entry.query, ...(Array.isArray(entry.keywords) ? { keywords: entry.keywords } : {}) };
    const start  = performance.now();
    const result = await this.manager.recall({ ...query, pageSize: this.pageSize, tokenBudget: this.tokenBudget, includeLinks: false, ...this._scope() });
    const latencyMs = performance.now() - start;
    const top    = result?.fragments?.[0]?.content ?? null;
    return {
      id     : entry.id,
      verdict: judgeTop(top, entry.updates),
      tokens : result?.totalTokens ?? 0,
      count  : result?.fragments?.length ?? 0,
      latencyMs,
      top
    };
  }

  /**
   * 방식마다 적재, 판정, 회수를 한다.
   *
   * @param {Object[]} goldset
   * @param {{arms?: string[]}} [options]
   * @returns {Promise<{arms: Object, cases: Object}>}
   */
  async run(goldset, { arms = ACTION_ARMS } = {}) {
    await this.harness.ensureHarnessKey();
    const report = { arms: {}, cases: {} };
    for (const arm of arms) {
      await this.harness.cleanup();
      try {
        const now = Date.now();
        for (const entry of goldset) await this._store(entry, arm, now);
        await this.harness.settle();
        const rows = [];
        for (const entry of goldset) rows.push(await this._act(entry, arm));
        report.arms[arm]  = summarizeArm(rows);
        report.cases[arm] = rows.map(({ id, verdict, tokens, count }) => ({ id, verdict, tokens, count }));
      } finally {
        await this.harness.cleanup();
      }
    }
    return report;
  }
}
