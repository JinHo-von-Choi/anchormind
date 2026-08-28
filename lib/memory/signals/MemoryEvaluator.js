/**
 * MemoryEvaluator - 비동기 지식 품질 평가 및 Rationale 생성
 *
 * 작성자: 최진호
 * 작성일: 2026-02-27
 */

import { popFromQueue, getQueueLength } from "../../redis.js";
import { MemoryManager } from "../MemoryManager.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../../gemini.js";
import { logInfo, logWarn, logDebug } from "../../logger.js";
import { PollingWorker } from "../workers/PollingWorker.js";

const MAX_QUEUE_SIZE = parseInt(process.env.EVALUATOR_MAX_QUEUE || "100", 10);

export class MemoryEvaluator extends PollingWorker {
  constructor() {
    super({ name: "MemoryEvaluator", intervalMs: 5000, idleOnlyDelay: true });
  }

  /**
   * 한 회차: 큐 상한을 넘긴 항목을 버리고 한 건을 평가한다.
   *
   * 버린 항목은 quality_verified=false로 표시해 consolidate 주기가 다시 집어가게 한다.
   *
   * @returns {Promise<number>} 평가한 건수
   */
  async _processBatch() {
    await this._dropOverflow();

    const job = await popFromQueue("memory_evaluation");
    if (!job) return 0;
    await this.evaluate(job);
    return 1;
  }

  /**
   * 큐가 상한을 넘으면 초과분을 버린다.
   *
   * @returns {Promise<void>}
   */
  async _dropOverflow() {
    const queueLen = await getQueueLength("memory_evaluation");
    if (queueLen <= MAX_QUEUE_SIZE) return;

    const dropCount  = queueLen - MAX_QUEUE_SIZE;
    const droppedIds = [];
    for (let i = 0; i < dropCount; i++) {
      const dropped = await popFromQueue("memory_evaluation");
      if (dropped?.fragmentId) droppedIds.push(dropped.fragmentId);
    }
    logWarn(`[MemoryEvaluator] Dropped ${dropCount} jobs (queue: ${queueLen} > ${MAX_QUEUE_SIZE}), fragmentIds: [${droppedIds.join(", ")}]`);

    if (droppedIds.length === 0) return;
    try {
      const mgr = MemoryManager.getInstance();
      for (const fid of droppedIds) {
        await mgr.store.update(fid, { quality_verified: false }, "system");
      }
      logInfo(`[MemoryEvaluator] Marked ${droppedIds.length} dropped fragments as quality_verified=false`);
    } catch (markErr) {
      logWarn(`[MemoryEvaluator] Failed to mark dropped fragments: ${markErr.message}`);
    }
  }

  /**
   * 파편 품질 평가 및 Rationale 생성
   *
   * @param {Object} job - { fragmentId, agentId, type, content }
   */
  async evaluate(job) {
    const { fragmentId, agentId, type, content } = job;
    const mgr = MemoryManager.getInstance();

    /** System prompt — 외부 LLM이 JSON 객체만 출력 + 정확한 스키마 명시 */
    const systemPrompt =
      "You are a JSON object generator for knowledge fragment quality evaluation. " +
      "Your ONLY output MUST be a valid JSON object matching this exact schema: " +
      "{\"score\": <float 0-1>, \"rationale\": <single Korean sentence>, \"action\": \"keep\"|\"downgrade\"|\"discard\"}. " +
      "Do NOT include markdown fences, explanations, reasoning outside the rationale field, preambles, or ANY other text. " +
      "Output must be directly parseable by JSON.parse().";

    /** User prompt — 한국어 평가 기준 + few-shot 예시 2개 */
    const userPrompt = `다음 지식 파편의 미래 활용 가치를 평가하라.
유형: ${type}
내용: "${content}"

평가 기준:
1. score: 0~1 사이. 미래에 에이전트가 이 정보를 얼마나 필요로 할지
2. rationale: 왜 이 정보를 저장해야 하는지 1문장 이유
3. action:
   - "keep": 가치 있음, 그대로 유지 (score >= 0.6)
   - "downgrade": 가치 낮음, importance 하향 (0.3 <= score < 0.6)
   - "discard": 불필요, 거의 삭제 (score < 0.3)

예시:
유형: decision
내용: "v2.8.0부터 LLM fallback chain은 LLM_FALLBACKS JSON 배열로 설정한다"
응답: {"score": 0.85, "rationale": "향후 LLM 관련 작업 시 설정 규칙 참조가 필요함", "action": "keep"}

유형: fact
내용: "테스트"
응답: {"score": 0.1, "rationale": "맥락 없는 단발 문자열로 재활용 가치 없음", "action": "discard"}

응답:`;

    try {
      if (!(await isGeminiCLIAvailable())) {
        logDebug(`[MemoryEvaluator] Gemini CLI unavailable, skipping evaluation for ${fragmentId}`);
        return;
      }

      const result = await geminiCLIJson(userPrompt, {
        timeoutMs   : 40_000,
        systemPrompt
      });

      const updates = {
        importance: result.score
      };

      if (result.action === "keep") {
        updates.quality_verified = true;
      } else if (result.action === "downgrade") {
        updates.importance      = Math.min(result.score, 0.3);
        updates.quality_verified = false;
      } else if (result.action === "discard") {
        updates.importance      = 0.1;
        updates.quality_verified = false;
      }

      /** Rationale은 keywords 오염을 피하기 위해 전용 컬럼(quality_rationale)에 저장한다. */
      updates.quality_rationale = result.rationale;

      await mgr.store.update(fragmentId, updates, agentId);
      logInfo(`[MemoryEvaluator] Evaluated ${fragmentId}: score=${result.score}, action=${result.action}`);

    } catch (err) {
      logWarn(`[MemoryEvaluator] Failed to evaluate ${fragmentId}: ${err.message}`);
    }
  }
}

/** 싱글톤 */
let evaluatorInstance = null;

export function getMemoryEvaluator() {
  if (!evaluatorInstance) {
    evaluatorInstance = new MemoryEvaluator();
  }
  return evaluatorInstance;
}
