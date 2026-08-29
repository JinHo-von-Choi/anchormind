/**
 * Admin Metrics Summary — Prometheus Registry 직접 접근
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 * 수정일: 2026-04-20 (Phase 2: timeseries ring buffer + 5s 폴러)
 *
 * prom-client Registry.getMetricsAsJSON()으로 메트릭을 읽어
 * Admin UI 카드/테이블용 요약 객체를 반환한다.
 * 외부 Prometheus 서버 의존 없음.
 */

import { register } from "../metrics.js";

/** 응답 캐시 — 10초 TTL */
let cachedSummary = null;   /* { ts: number, value: object } */
const CACHE_TTL_MS = 10_000;

/* ------------------------------------------------------------------ */
/*  Timeseries Ring Buffer (Phase 2)                                    */
/* ------------------------------------------------------------------ */

const TIMESERIES_KEYS      = ["httpRps", "toolLatencyP95", "activeSessions"];
const RING_SIZE            = 100;   /* 100 sample × 5s = 500s ≈ 8분 */
const SAMPLE_INTERVAL_MS   = 5_000;

/**
 * key → [{ts: ISO8601, value: number}, ...]
 * RING_SIZE 초과 시 oldest(index 0) 제거.
 */
const timeseriesBuffer = new Map();
for (const key of TIMESERIES_KEYS) {
  timeseriesBuffer.set(key, []);
}

/**
 * HTTP 요청 카운터 직전 스냅샷 — ring buffer 전용.
 * (prevSnapshot은 buildMetricsSummary rate와 독립적으로 관리)
 */
let _httpCounterPrev = null;   /* { ts: number, value: number } | null */

/** 샘플링 활성화 여부 — 테스트에서 환경변수 또는 함수 호출로 제어 */
let _samplingEnabled = process.env.MEMENTO_ADMIN_METRICS_SAMPLING !== "off";

/**
 * 테스트 격리용: 샘플링 폴러 활성화/비활성화.
 * @param {boolean} enabled
 */
export function _setSamplingEnabled(enabled) {
  _samplingEnabled = Boolean(enabled);
}

/**
 * ring buffer에 새 sample을 추가한다.
 * RING_SIZE 초과 시 가장 오래된 항목을 제거한다.
 * @param {string} key
 * @param {number} value
 */
function _pushSample(key, value) {
  const buf = timeseriesBuffer.get(key);
  if (!buf) return;
  buf.push({ ts: new Date().toISOString(), value });
  if (buf.length > RING_SIZE) {
    buf.shift();
  }
}

/**
 * 5초 주기 폴러 — 3개 지표를 수집하여 ring buffer에 적재한다.
 * register.getMetricsAsJSON() 실패 시 조용히 skip (서버 중단 방지).
 */
async function _collectSample() {
  if (!_samplingEnabled) return;

  let jsonMetrics;
  try {
    jsonMetrics = await register.getMetricsAsJSON();
  } catch {
    return;
  }

  const map = buildMetricMap(jsonMetrics);
  const nowMs = Date.now();

  /** httpRps: mcp_http_requests_total counter delta / 5s */
  const httpTotal = sumCounterValues(map.get("mcp_http_requests_total"));
  if (_httpCounterPrev !== null) {
    const elapsedSec = (nowMs - _httpCounterPrev.ts) / 1000;
    const delta      = Math.max(0, httpTotal - _httpCounterPrev.value);
    const rps        = elapsedSec > 0 ? Math.round((delta / elapsedSec) * 100) / 100 : 0;
    _pushSample("httpRps", rps);
  } else {
    _pushSample("httpRps", 0);
  }
  _httpCounterPrev = { ts: nowMs, value: httpTotal };

  /** toolLatencyP95: mcp_tool_execution_duration_seconds 전체 p95 (ms) */
  const durMetric    = map.get("mcp_tool_execution_duration_seconds");
  const latencyP95   = estimateQuantile(durMetric, null, 0.95, 1000);
  _pushSample("toolLatencyP95", latencyP95);

  /** activeSessions: streamable + legacy gauge 합 */
  const streamable     = sumGaugeValues(map.get("mcp_active_sessions_streamable"));
  const legacy         = sumGaugeValues(map.get("mcp_active_sessions_legacy"));
  _pushSample("activeSessions", streamable + legacy);
}

/** 폴러 핸들 — event loop 비차단을 위해 .unref() */
let _pollerHandle = null;

function _startPoller() {
  if (_pollerHandle !== null) return;
  _pollerHandle = setInterval(() => {
    _collectSample().catch(() => {});
  }, SAMPLE_INTERVAL_MS);
  _pollerHandle.unref();
}

/** 환경변수 가드: off이면 폴러 시작하지 않음 */
if (_samplingEnabled) {
  _startPoller();
}

/**
 * 직전 호출 시점의 카운터 스냅샷.
 * rate 계산에 사용.
 * Map<metric_name, { ts: number, value: number }>
 */
const prevSnapshot = new Map();

/* ------------------------------------------------------------------ */
/*  내부 헬퍼                                                            */
/* ------------------------------------------------------------------ */

/**
 * getMetricsAsJSON 결과를 name → metric 맵으로 변환.
 * @param {object[]} jsonMetrics
 * @returns {Map<string, object>}
 */
function buildMetricMap(jsonMetrics) {
  const map = new Map();
  for (const m of jsonMetrics) {
    map.set(m.name, m);
  }
  return map;
}

/**
 * Counter 값을 label 조건으로 필터링해 합산한다.
 * @param {object}   metric     - getMetricsAsJSON의 단일 메트릭 항목
 * @param {object}   [labels]   - 필터링할 label key/value. undefined 이면 전체 합산.
 * @returns {number}
 */
function sumCounterValues(metric, labels) {
  if (!metric) return 0;
  let total = 0;
  for (const v of metric.values ?? []) {
    if (labels) {
      const match = Object.entries(labels).every(([k, val]) => v.labels[k] === val);
      if (!match) continue;
    }
    total += v.value ?? 0;
  }
  return total;
}

/**
 * Gauge 값을 label 조건으로 필터링해 합산한다.
 * @param {object}  metric
 * @param {object}  [labels]
 * @returns {number}
 */
function sumGaugeValues(metric, labels) {
  return sumCounterValues(metric, labels);
}

/**
 * per-windowSec rate 계산 (카운터 delta / window).
 * prevSnapshot 갱신도 여기서 수행한다.
 * @param {string} key         - 스냅샷 식별 키
 * @param {number} current     - 현재 누적값
 * @param {number} windowSec   - 창 크기 (초)
 * @param {number} nowMs       - 현재 타임스탬프 (ms)
 * @returns {number}           - 단위: count / windowSec
 */
function calcRate(key, current, windowSec, nowMs) {
  const prev = prevSnapshot.get(key);
  prevSnapshot.set(key, { ts: nowMs, value: current });

  if (!prev) return 0;

  const elapsedSec = (nowMs - prev.ts) / 1000;
  if (elapsedSec <= 0) return 0;

  const delta   = Math.max(0, current - prev.value);
  const perSec  = delta / elapsedSec;
  return Math.round(perSec * windowSec * 100) / 100;
}

/**
 * Histogram 데이터에서 특정 분위수를 선형 보간으로 추정한다.
 *
 * 알고리즘:
 * 1. _bucket 항목을 (le, cumCount) 배열로 수집.
 * 2. +Inf 버킷의 cumCount가 total count.
 * 3. target = quantile * total 에 해당하는 버킷 구간을 찾아
 *    하한 bucket 상단에서 선형 보간.
 *
 * @param {object}  metric    - histogram 메트릭 항목
 * @param {object}  [filter]  - label 필터 (e.g. { tool: "remember" })
 * @param {number}  quantile  - 0~1 (e.g. 0.95)
 * @param {number}  scale     - 결과 단위 변환 배수 (초→ms 이면 1000)
 * @returns {number}          - 추정값 (소수점 없는 ms 정수)
 */
function estimateQuantile(metric, filter, quantile, scale = 1) {
  if (!metric) return 0;

  /** 필터와 일치하는 bucket 항목만 수집 */
  const buckets = [];
  let   count   = 0;

  for (const v of metric.values ?? []) {
    if (filter) {
      const match = Object.entries(filter).every(([k, val]) => v.labels[k] === val);
      if (!match) continue;
    }

    if (v.metricName?.endsWith("_bucket")) {
      const le = v.labels.le;
      if (le === "+Inf") {
        count = v.value;
      } else {
        buckets.push({ le: Number(le), cum: v.value });
      }
    }
  }

  if (count === 0 || buckets.length === 0) return 0;

  buckets.sort((a, b) => a.le - b.le);

  const target = quantile * count;

  /** 첫 번째 버킷이 이미 target 을 초과하면 하한을 0으로 보간 */
  if (target <= (buckets[0]?.cum ?? 0)) {
    const upperLe = buckets[0].le;
    return Math.round(upperLe * scale);
  }

  for (let i = 1; i < buckets.length; i++) {
    const lower = buckets[i - 1];
    const upper = buckets[i];

    if (target <= upper.cum) {
      /** 구간 내 비례 보간 */
      const countInBucket = upper.cum - lower.cum;
      if (countInBucket <= 0) {
        return Math.round(upper.le * scale);
      }
      const fraction = (target - lower.cum) / countInBucket;
      const estimate  = lower.le + fraction * (upper.le - lower.le);
      return Math.round(estimate * scale);
    }
  }

  /** target 이 모든 버킷을 초과하면 마지막 finite le 반환 */
  return Math.round((buckets[buckets.length - 1].le) * scale);
}

/**
 * tool 집계 — mcp_tool_executions_total + mcp_tool_execution_duration_seconds 결합.
 * @param {Map}    metricMap
 * @param {number} nowMs
 * @param {number} windowSec
 * @returns {{ tool: string, total_calls: number, success_rate: number, p95_ms: number }[]}
 */
function buildToolsTable(metricMap, _nowMs, _windowSec) {
  const execMetric = metricMap.get("mcp_tool_executions_total");
  const durMetric  = metricMap.get("mcp_tool_execution_duration_seconds");

  if (!execMetric) return [];

  /** 도구별 (total, success) 집계 */
  const toolMap = new Map();

  for (const v of execMetric.values ?? []) {
    const tool    = v.labels.tool;
    const success = v.labels.success === "true";
    if (!tool) continue;

    if (!toolMap.has(tool)) {
      toolMap.set(tool, { total: 0, success: 0 });
    }
    const entry = toolMap.get(tool);
    entry.total += v.value;
    if (success) entry.success += v.value;
  }

  const result = [];
  for (const [tool, counts] of toolMap) {
    const p95_ms     = estimateQuantile(durMetric, { tool }, 0.95, 1000);
    const successRate = counts.total > 0
      ? Math.round((counts.success / counts.total) * 1000) / 1000
      : 1;

    result.push({
      tool,
      total_calls  : counts.total,
      success_rate : successRate,
      p95_ms
    });
  }

  result.sort((a, b) => b.total_calls - a.total_calls);
  return result;
}

/**
 * error 집계 — mcp_errors_total label aggregation (type/code별).
 * @param {Map} metricMap
 * @returns {{ error_type: string, count: number, last_seen: string }[]}
 */
function buildErrorsTable(metricMap) {
  const errMetric = metricMap.get("mcp_errors_total");
  if (!errMetric) return [];

  const errMap = new Map();

  for (const v of errMetric.values ?? []) {
    const type = v.labels.type || "unknown";
    const code = v.labels.code  || "0";
    const key  = `${type}:${code}`;

    if (!errMap.has(key)) {
      errMap.set(key, { error_type: `${type}_${code}`, count: 0 });
    }
    errMap.get(key).count += v.value;
  }

  const now      = new Date().toISOString();
  const result   = [];
  for (const entry of errMap.values()) {
    if (entry.count > 0) {
      result.push({ ...entry, last_seen: now });
    }
  }

  result.sort((a, b) => b.count - a.count);
  return result;
}

/* ------------------------------------------------------------------ */
/*  공개 API                                                             */
/* ------------------------------------------------------------------ */

/**
 * Admin 메트릭 요약 생성.
 *
 * @param {object}   [opts]
 * @param {number}   [opts.windowSec=60]         - rate 계산 창 크기 (초)
 * @param {string[]} [opts.include]               - 포함할 섹션 목록
 *                                                  ("cards","tools","errors","timeseries")
 * @returns {Promise<object>}
 */
export async function buildMetricsSummary({
  windowSec = 60,
  include   = ["cards", "tools", "errors", "timeseries"]
} = {}) {
  const nowMs = Date.now();

  /** 10초 TTL 캐시 */
  if (cachedSummary && (nowMs - cachedSummary.ts) < CACHE_TTL_MS) {
    return cachedSummary.value;
  }

  const jsonMetrics = await register.getMetricsAsJSON();
  const map         = buildMetricMap(jsonMetrics);

  const result = {
    generated_at : new Date(nowMs).toISOString(),
    window_sec   : windowSec
  };

  if (include.includes("cards")) {
    /** Gauge: activeSessions */
    const streamable = sumGaugeValues(map.get("mcp_active_sessions_streamable"));
    const legacy     = sumGaugeValues(map.get("mcp_active_sessions_legacy"));
    const activeSessions = streamable + legacy;

    /** Counter rates */
    const authDenied      = sumCounterValues(map.get("memento_auth_denied_total"));
    const rbacDenied      = sumCounterValues(map.get("memento_rbac_denied_total"));
    const tenantBlocked   = sumCounterValues(map.get("memento_tenant_isolation_blocked_total"));
    const toolErrors      = sumCounterValues(map.get("mcp_errors_total"), { type: "tool" });
    const symbolicBlocked = sumCounterValues(map.get("memento_symbolic_gate_blocked_total"));
    const oauthIssued     = sumCounterValues(map.get("mcp_oauth_tokens_issued_total"));

    const authDeniedRate5m    = calcRate("authDenied",    authDenied,    windowSec, nowMs);
    const rbacDeniedRate5m    = calcRate("rbacDenied",    rbacDenied,    windowSec, nowMs);
    const toolErrorRate5m     = calcRate("toolErrors",    toolErrors,    windowSec, nowMs);
    const oauthTokensRate1h   = calcRate("oauthIssued",   oauthIssued,   3600,      nowMs);

    /** Histogram quantile — rpc latency */
    const rpcDurMetric = map.get("mcp_rpc_method_duration_seconds");
    const rpcLatencyP50  = estimateQuantile(rpcDurMetric, null, 0.50, 1000);
    const rpcLatencyP99  = estimateQuantile(rpcDurMetric, null, 0.99, 1000);

    result.cards = {
      activeSessions,
      authDeniedRate5m,
      rbacDeniedRate5m,
      tenantBlockedTotal   : tenantBlocked,
      rpcLatencyP50,
      rpcLatencyP99,
      toolErrorRate5m,
      symbolicGateBlocked  : symbolicBlocked,
      oauthTokensIssuedRate1h : oauthTokensRate1h
    };
  }

  if (include.includes("tools")) {
    result.tools = buildToolsTable(map, nowMs, windowSec);
  }

  if (include.includes("errors")) {
    result.errors = buildErrorsTable(map);
  }

  if (include.includes("timeseries")) {
    result.timeseries = {
      httpRps        : [...(timeseriesBuffer.get("httpRps")         ?? [])],
      toolLatencyP95 : [...(timeseriesBuffer.get("toolLatencyP95")  ?? [])],
      activeSessions : [...(timeseriesBuffer.get("activeSessions")  ?? [])]
    };
  }

  cachedSummary = { ts: nowMs, value: result };
  return result;
}

/**
 * 캐시와 스냅샷을 초기화한다 (테스트 격리용).
 * timeseries buffer와 httpCounter 스냅샷도 함께 초기화한다.
 */
export function resetMetricsState() {
  cachedSummary = null;
  prevSnapshot.clear();
  for (const key of TIMESERIES_KEYS) {
    timeseriesBuffer.set(key, []);
  }
  _httpCounterPrev = null;
}

/**
 * timeseries buffer의 현재 상태를 반환한다 (테스트용).
 * @returns {Map<string, {ts: string, value: number}[]>}
 */
export function _getTimeseriesBuffer() {
  return timeseriesBuffer;
}

/**
 * 테스트에서 직접 sample을 주입하기 위한 내부 함수 노출.
 * @param {string} key
 * @param {number} value
 */
export function _injectSample(key, value) {
  _pushSample(key, value);
}
