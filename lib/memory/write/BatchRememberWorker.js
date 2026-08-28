/**
 * BatchRememberWorker -- batch_remember 비동기 큐 처리 워커
 *
 * 작성자: 최진호
 * 작성일: 2026-06-15
 * 수정일: 2026-06-19
 *
 * Redis 큐(memento:batch_remember_queue)를 폴링하여 적재된 job을
 * BatchRememberProcessor.process()에 위임한다. INSERT 본처리는 기존
 * 동기 경로를 그대로 재사용하며, 워커는 큐 소비와 위임만 담당한다.
 *
 * 신뢰성 처리:
 * - popFromQueueReliable: RPOPLPUSH로 tail→processing 원자 이동(ack 전까지 보존)
 * - 성공 시 ackQueueItem으로 processing 에서 제거
 * - 실패 시 retryLimit 이내 재적재, 초과 시 dead-letter 큐로 이동
 * - 기동 시 requeueProcessing으로 이전 크래시 in-flight 항목 복구(at-least-once)
 */

import { popFromQueueReliable, ackQueueItem, requeueProcessing, pushToQueue, pushToQueueDead, setBatchJobStatus } from "../../redis.js";
import { MEMORY_CONFIG }  from "../../../config/memory.js";
import { logInfo, logWarn, logError } from "../../logger.js";
import { PollingWorker } from "../workers/PollingWorker.js";

export class BatchRememberWorker extends PollingWorker {
  /**
   * @param {import("./BatchRememberProcessor.js").BatchRememberProcessor} processor
   */
  constructor(processor) {
    super({
      name         : "BatchRememberWorker",
      intervalMs   : MEMORY_CONFIG.batchRememberWorker.intervalMs,
      idleOnlyDelay: true
    });
    this.processor = processor;
  }

  /** 큐 이름은 설정 키에서 접두사를 뗀 값이다. */
  get _queueName() {
    return MEMORY_CONFIG.batchRememberWorker.queueKey.replace(/^memento:/, "");
  }

  /**
   * 기동 시 이전 실행이 남긴 in-flight 항목을 회수한다.
   *
   * @returns {Promise<void>}
   */
  async _onStart() {
    const recovered = await requeueProcessing(this._queueName);
    if (recovered > 0) logInfo(`[BatchRememberWorker] Recovered ${recovered} in-flight job(s)`);
  }

  /**
   * 한 회차: 큐에서 job 하나를 꺼내 처리한다.
   *
   * @returns {Promise<number>} 처리한 건수
   */
  async _processBatch() {
    const envelope = await popFromQueueReliable(this._queueName);
    if (!envelope) return 0;
    await this._processJobEnvelope(envelope);
    return 1;
  }

  /**
   * 신뢰성 처리: 성공 시 ack, 실패 시 재시도 한도 내 재적재 / 초과 시 dead-letter.
   * disposition(재적재 또는 dead-letter)이 성공으로 확정됐을 때에만 ack(LREM)한다.
   * disposition 자체가 실패하면 ack를 보류하여 항목을 processing 에 남기고,
   * 다음 기동의 requeueProcessing 이 복구하도록 위임한다(무손실).
   * @param {{ raw: string, data: { jobId: string, params: object, retryCount: number } }} envelope
   */
  async _processJobEnvelope(envelope) {
    const { raw, data } = envelope;
    const { jobId, params, retryCount = 0 } = data;
    const queueName = MEMORY_CONFIG.batchRememberWorker.queueKey.replace(/^memento:/, "");
    const limit     = MEMORY_CONFIG.batchRememberWorker.retryLimit ?? 3;
    let safeToAck = true;
    await setBatchJobStatus(jobId, { state: "processing" });
    try {
      const result = await this.processor.process(params);
      logInfo(`[BatchRememberWorker] Job ${jobId} done: inserted=${result.inserted}, skipped=${result.skipped}`);
      await setBatchJobStatus(jobId, { state: "completed", inserted: result.inserted, skipped: result.skipped });
    } catch (err) {
      let disposed;
      if (retryCount < limit) {
        logWarn(`[BatchRememberWorker] Job ${jobId} failed (retry ${retryCount + 1}/${limit}): ${err.message}`);
        disposed = await pushToQueue(queueName, { jobId, params, retryCount: retryCount + 1 });
        await setBatchJobStatus(jobId, { state: "queued", error: err.message });
      } else {
        logError(`[BatchRememberWorker] Job ${jobId} exhausted retries, dead-lettering: ${err.message}`);
        disposed = await pushToQueueDead(queueName, { jobId, params, retryCount, lastError: err.message });
        await setBatchJobStatus(jobId, { state: "dead", error: err.message });
      }
      if (!disposed) {
        safeToAck = false;
        logError(`[BatchRememberWorker] Job ${jobId} disposition failed; leaving in processing for next-boot recovery`);
      }
    }
    if (safeToAck) await ackQueueItem(queueName, raw);
  }
}

/** 싱글톤 */
let workerInstance = null;

/**
 * BatchRememberWorker 싱글톤을 반환한다.
 * 최초 호출 시 processor가 필요하며, 이후 호출은 기존 인스턴스를 반환한다.
 *
 * @param {import("./BatchRememberProcessor.js").BatchRememberProcessor|null} [processor]
 * @returns {BatchRememberWorker}
 */
export function getBatchRememberWorker(processor = null) {
  if (!workerInstance) {
    workerInstance = new BatchRememberWorker(processor);
  }
  return workerInstance;
}
