/**
 * MEMORY_CONFIG 런타임 검증
 * 서버 시작 시 1회 호출. 실패 시 Error throw로 프로세스 시작 중단.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 */

/**
 * MEMORY_CONFIG 전체 구조를 검증한다.
 * 유효하지 않은 설정이 하나라도 있으면 에러를 throw한다.
 *
 * @param {object} cfg - MEMORY_CONFIG 객체
 * @throws {Error} 검증 실패 시
 */
export function validateMemoryConfig(cfg) {
  const errors = [];

  // ranking weights 합계 = 1.0
  const rankSum = cfg.ranking.importanceWeight + cfg.ranking.recencyWeight + cfg.ranking.semanticWeight;
  if (Math.abs(rankSum - 1.0) > 0.001) {
    errors.push(`ranking weights must sum to 1.0 (got ${rankSum})`);
  }

  // contextInjection.rankWeights 합계 = 1.0
  const rw    = cfg.contextInjection.rankWeights;
  const rwSum = Object.values(rw).reduce((a, b) => a + b, 0);
  if (Math.abs(rwSum - 1.0) > 0.001) {
    errors.push(`rankWeights must sum to 1.0 (got ${rwSum})`);
  }

  // 0~1 범위 검증
  const zeroOneFields = [
    ["semanticSearch.minSimilarity", cfg.semanticSearch.minSimilarity],
    ["morphemeIndex.minSimilarity",  cfg.morphemeIndex.minSimilarity],
    ["gc.utilityThreshold",          cfg.gc.utilityThreshold],
  ];
  for (const [name, val] of zeroOneFields) {
    if (typeof val !== "number" || val < 0 || val > 1) {
      errors.push(`${name} must be between 0 and 1 (got ${val})`);
    }
  }

  // RRF 가중치 검증: 음수/NaN은 레이어 순위를 왜곡한다.
  const rrf = cfg.rrfSearch || {};
  const rrfWeightFields = [
    ["rrfSearch.l1WeightFactor", rrf.l1WeightFactor],
    ["rrfSearch.l2WeightFactor", rrf.l2WeightFactor],
    ["rrfSearch.l3WeightFactor", rrf.l3WeightFactor],
    ["rrfSearch.graphWeightFactor", rrf.graphWeightFactor],
    ["rrfSearch.mixed.l1WeightFactor", rrf.mixed?.l1WeightFactor],
    ["rrfSearch.mixed.l2WeightFactor", rrf.mixed?.l2WeightFactor],
    ["rrfSearch.mixed.l3WeightFactor", rrf.mixed?.l3WeightFactor],
    ["rrfSearch.mixed.graphWeightFactor", rrf.mixed?.graphWeightFactor],
  ];
  for (const [name, val] of rrfWeightFields) {
    if (val !== undefined && (typeof val !== "number" || val < 0 || !Number.isFinite(val))) {
      errors.push(`${name} must be a non-negative finite number (got ${val})`);
    }
  }

  // halfLifeDays 양수 검증
  for (const [key, val] of Object.entries(cfg.halfLifeDays)) {
    if (typeof val !== "number" || val <= 0) {
      errors.push(`halfLifeDays.${key} must be positive (got ${val})`);
    }
  }

  // GC 정합성: gracePeriodDays < inactiveDays
  if (cfg.gc.gracePeriodDays >= cfg.gc.inactiveDays) {
    errors.push(`gc.gracePeriodDays (${cfg.gc.gracePeriodDays}) must be < gc.inactiveDays (${cfg.gc.inactiveDays})`);
  }

  // 양수 정수 검증
  const positiveIntFields = [
    ["embeddingWorker.batchSize",    cfg.embeddingWorker.batchSize],
    ["embeddingWorker.intervalMs",   cfg.embeddingWorker.intervalMs],
    ["pagination.defaultPageSize",   cfg.pagination.defaultPageSize],
    ["pagination.maxPageSize",       cfg.pagination.maxPageSize],
    ["gc.maxDeletePerCycle",         cfg.gc.maxDeletePerCycle],
    ["semanticSearch.limit",         cfg.semanticSearch.limit],
    ["semanticSearch.timeoutMs",     cfg.semanticSearch.timeoutMs],
    ["semanticSearch.hnswEfSearch",  cfg.semanticSearch.hnswEfSearch],
  ];
  for (const [name, val] of positiveIntFields) {
    if (typeof val !== "number" || val <= 0 || !Number.isInteger(val)) {
      errors.push(`${name} must be a positive integer (got ${val})`);
    }
  }

  if (typeof cfg.semanticSearch.statementTimeoutMs !== "number" ||
      cfg.semanticSearch.statementTimeoutMs < 0 ||
      !Number.isInteger(cfg.semanticSearch.statementTimeoutMs)) {
    errors.push(`semanticSearch.statementTimeoutMs must be a non-negative integer (got ${cfg.semanticSearch.statementTimeoutMs})`);
  }
  if (Number.isInteger(cfg.semanticSearch.statementTimeoutMs) &&
      cfg.semanticSearch.statementTimeoutMs > 0 &&
      Number.isInteger(cfg.semanticSearch.timeoutMs) &&
      cfg.semanticSearch.statementTimeoutMs >= cfg.semanticSearch.timeoutMs) {
    errors.push(`semanticSearch.statementTimeoutMs (${cfg.semanticSearch.statementTimeoutMs}) must be lower than semanticSearch.timeoutMs (${cfg.semanticSearch.timeoutMs})`);
  }

  if (errors.length > 0) {
    throw new Error(`MEMORY_CONFIG validation failed:\n  - ${errors.join("\n  - ")}`);
  }
}
