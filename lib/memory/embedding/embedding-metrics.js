/**
 * 임베딩 dead 목록 게이지
 *
 * 작성자: 최진호
 * 작성일: 2026-11-02
 *
 *   memento_embedding_dead_letters  재시도 한도를 넘긴 임베딩 작업 가운데 파편 임베딩이 아직 비어 있어 남아 있는 dead 항목 수.
 *                                   dead 목록 정리(EmbeddingWorker.reconcileDeadLetters) 직후에 센다.
 */

import promClient   from "prom-client";
import { register } from "../../metrics.js";

/** 정리 직후 남은 임베딩 dead 항목 수 */
export const embeddingDeadLetters = new promClient.Gauge({
  name     : "memento_embedding_dead_letters",
  help     : "임베딩 dead 목록 정리 직후 남은 항목 수(파편 임베딩이 아직 비어 있는 항목)",
  registers: [register]
});
