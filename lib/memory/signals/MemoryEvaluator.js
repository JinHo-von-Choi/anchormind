/**
 * MemoryEvaluator - 비동기 지식 품질 평가 및 Rationale 생성
 *
 * 작성자: 최진호
 * 작성일: 2026-02-27
 */

import { popFromQueue, getQueueLength } from "../../redis.js";
import { MemoryManager } from "../MemoryManager.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../../gemini.js";
import { logInfo, logWarn, logError, logDebug } from "../../logger.js";

const MAX_QUEUE_SIZE = parseInt(process.env.EVALUATOR_MAX_QUEUE || "100", 10);

export class MemoryEvaluator {
  constructor() {
    this.running      = false;
    this.interval     = 5000;
    this._backoff     = 1000;
    this._backoffMax  = 60000;
    this._drainResolve = null;
  }

  /**
   * 워커 시작
   */
  async start() {
    if (this.running) return;
    this.running = true;
    logInfo("[MemoryEvaluator] Worker started");
    this._loop();
  }

  /**
   * 워커 중지 — 현재 evaluate 완료까지 대기하는 Promise 반환
   *
   * @returns {Promise<void>} 루프가 종료되면 resolve
   */
  stop() {
    if (!this.running) return Promise.resolve();

    this.running = false;
    logInfo("[MemoryEvaluator] Worker stopping, waiting for current job to finish...");
    return new Promise(resolve => {
      this._drainResolve = resolve;
    });
  }

  /**
   * 메인 루프
   */
  async _loop() {
    while (this.running) {
      try {
        const queueLen = await getQueueLength("memory_evaluation");
        if (queueLen > MAX_QUEUE_SIZE) {
          const dropCount    = queueLen - MAX_QUEUE_SIZE;
          const droppedIds   = [];
          for (let i = 0; i < dropCount; i++) {
            const dropped = await popFromQueue("memory_evaluation");
            if (dropped?.fragmentId) droppedIds.push(dropped.fragmentId);
          }
          logWarn(`[MemoryEvaluator] Dropped ${dropCount} jobs (queue: ${queueLen} > ${MAX_QUEUE_SIZE}), fragmentIds: [${droppedIds.join(", ")}]`);

          /** 드롭된 파편을 quality_verified=false로 마킹하여 consolidate 사이클에서 재시도 가능하게 함 */
          if (droppedIds.length > 0) {
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
        }

        const job = await popFromQueue("memory_evaluation");
        if (job) {
          await this.evaluate(job);
          this._backoff = 1000;
        } else {
          await new Promise(resolve => setTimeout(resolve, this.interval));
        }
      } catch (err) {
        logError("[MemoryEvaluator] Error in loop:", err);
        await new Promise(resolve => setTimeout(resolve, this._backoff));
        this._backoff = Math.min(this._backoff * 2, this._backoffMax);
        logWarn(`[MemoryEvaluator] Backing off, next delay: ${this._backoff}ms`);
        continue;
      }
    }

    logInfo("[MemoryEvaluator] Worker stopped");
    if (this._drainResolve) {
      this._drainResolve();
      this._drainResolve = null;
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

      /**
       * Rationale은 keywords에 [Rationale] 접두사로 추가하여 보존.
       * 평가기는 내부 시스템 워커이므로 keyId=null(마스터 권한)으로 조회한다.
       */
      const existing = await mgr.store.getById(fragmentId, agentId, null, []);
      if (existing) {
        updates.keywords = [...(existing.keywords || []), `Rationale: ${result.rationale}`];
      }

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
