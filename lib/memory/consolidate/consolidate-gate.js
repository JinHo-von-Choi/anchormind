/**
 * Consolidate safety gate (pure functions, no I/O).
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 시맨틱 중복 제거는 코사인 유사도만 보고 파편을 합친다. 그런데 위험한 손실은
 * "거의 같은 문장인데 수치나 식별자만 다른" 경우에 발생한다. 코사인은 이 차이를
 * 거의 반영하지 못하므로(max_connections 200과 500은 0.99 이상), 임계값을 아무리
 * 올려도 걸러지지 않는다.
 *
 * 이 게이트는 제거 대상이 보유한 변별 토큰(수치·식별자·경로·버전)이 승계자에
 * 존재하는지 확인하고, 하나라도 사라지면 병합을 차단한다. 삭제 이후의 사후 측정과
 * 달리 파괴 전에 판정하므로 복구가 필요 없다.
 */

/** 변별 토큰 추출 패턴. 의미가 값에 실려 있는 표기만 대상으로 한다. */
const TOKEN_PATTERNS = [
  /\d+(?:\.\d+)?(?:ms|s|m|h|d|kb|mb|gb|tb|%)?/gi,   // 수치와 단위
  /[A-Za-z_][A-Za-z0-9_]*(?:_[A-Za-z0-9_]+)+/g,     // snake_case 식별자
  /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)*\b/g,          // 대문자 상수·환경변수
  /\/[A-Za-z0-9._\-/]+/g,                           // 경로
];

/** 어느 문장에나 흔해 변별력이 없는 수치.
 *  2 이상은 재시도 횟수·복제본 수처럼 의미를 싣는 경우가 많아 제외하지 않는다.
 *  게이트는 놓치는 쪽보다 과하게 막는 쪽으로 기운다. */
const TRIVIAL_TOKENS = new Set(["0", "1", "1.0"]);

/**
 * 문장에서 변별 토큰 집합을 뽑는다.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractDistinctiveTokens(text) {
  const value  = String(text ?? "");
  const tokens = new Set();

  for (const pattern of TOKEN_PATTERNS) {
    const matches = value.match(new RegExp(pattern.source, pattern.flags)) || [];
    for (const raw of matches) {
      const token = raw.toLowerCase();
      if (token.length === 0) continue;
      if (TRIVIAL_TOKENS.has(token)) continue;
      tokens.add(token);
    }
  }
  return tokens;
}

/**
 * 제거 대상의 변별 토큰 중 승계자에 없는 것을 구한다.
 *
 * @param {string} keepContent 승계자 본문
 * @param {string} oldContent  제거 대상 본문
 * @returns {string[]}
 */
export function findLostTokens(keepContent, oldContent) {
  const keep = extractDistinctiveTokens(keepContent);
  const old  = extractDistinctiveTokens(oldContent);
  return [...old].filter(token => !keep.has(token));
}

/**
 * 병합 한 쌍의 허용 여부를 판정한다.
 *
 * @param {Object} input
 * @param {string} input.keepContent      승계자 본문
 * @param {string} input.oldContent       제거 대상 본문
 * @param {number} [input.cosine]         두 파편의 코사인 유사도
 * @param {Object} [opts]
 * @param {number} [opts.minCosine]       이 값 미만이면 병합하지 않는다
 * @param {number} [opts.maxLostTokens]   허용할 소실 토큰 수 (기본 0)
 * @returns {{allow: boolean, reason: string|null, lostTokens: string[]}}
 */
export function judgeMergePair({ keepContent, oldContent, cosine }, opts = {}) {
  const minCosine     = opts.minCosine     ?? 0.92;
  const maxLostTokens = opts.maxLostTokens ?? 0;

  if (Number.isFinite(cosine) && cosine < minCosine) {
    return { allow: false, reason: "cosine_below_floor", lostTokens: [] };
  }

  const lostTokens = findLostTokens(keepContent, oldContent);
  if (lostTokens.length > maxLostTokens) {
    return { allow: false, reason: "distinctive_token_loss", lostTokens };
  }

  /** 제거 대상이 승계자보다 현저히 길면 요약이 아니라 정보 삭제다. */
  const keepLen = String(keepContent ?? "").length;
  const oldLen  = String(oldContent ?? "").length;
  if (keepLen > 0 && oldLen > keepLen * 1.5) {
    return { allow: false, reason: "survivor_shorter", lostTokens: [] };
  }

  return { allow: true, reason: null, lostTokens: [] };
}

/**
 * 판정 결과 배열을 집계한다.
 *
 * @param {Array<{allow: boolean, reason: string|null}>} verdicts
 * @returns {{total: number, blocked: number, allowed: number, lossRate: number, byReason: Object}}
 */
export function summarizeGate(verdicts) {
  const total   = verdicts.length;
  const blocked = verdicts.filter(v => !v.allow).length;
  const byReason = {};

  for (const v of verdicts) {
    if (v.allow || !v.reason) continue;
    byReason[v.reason] = (byReason[v.reason] ?? 0) + 1;
  }

  return {
    total,
    blocked,
    allowed : total - blocked,
    lossRate: total > 0 ? blocked / total : 0,
    byReason,
  };
}

/**
 * 사이클 중단 여부를 판정한다.
 *
 * 단발 위반으로 중단하면 표본 잡음에 정리가 멈추고, 무제한 허용하면 손실이 누적된다.
 * 연속 위반 횟수를 상태로 들고 임계 초과가 연속으로 이어질 때만 중단한다.
 *
 * @param {number} lossRate
 * @param {{consecutive: number}} state  호출자가 보관하는 누적 상태
 * @param {{maxLossRate?: number, requiredConsecutive?: number, minSample?: number}} [opts]
 * @param {number} [sampleSize]
 * @returns {{abort: boolean, state: {consecutive: number}, reason: string|null}}
 */
export function shouldAbortCycle(lossRate, state = { consecutive: 0 }, opts = {}, sampleSize = Infinity) {
  const maxLossRate         = opts.maxLossRate         ?? 0.02;
  const requiredConsecutive = opts.requiredConsecutive ?? 2;
  const minSample           = opts.minSample           ?? 10;

  /** 표본이 적으면 한 건 차단만으로 비율이 튄다. 판정을 유보한다. */
  if (sampleSize < minSample) {
    return { abort: false, state: { consecutive: 0 }, reason: null };
  }

  if (lossRate <= maxLossRate) {
    return { abort: false, state: { consecutive: 0 }, reason: null };
  }

  const consecutive = (state?.consecutive ?? 0) + 1;
  if (consecutive < requiredConsecutive) {
    return { abort: false, state: { consecutive }, reason: null };
  }

  return {
    abort : true,
    state : { consecutive },
    reason: `loss rate ${(lossRate * 100).toFixed(1)}% > ${(maxLossRate * 100).toFixed(1)}% for ${consecutive} consecutive cycles`,
  };
}
