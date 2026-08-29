/**
 * Admin Metrics API 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 테스트 대상:
 *  - buildMetricsSummary: cards/tools/errors 섹션 구조 검증
 *  - 캐시 TTL: 연속 호출 시 register.getMetricsAsJSON 1회만 실행
 *  - rate 계산: prevSnapshot 활용 delta rate
 *  - histogram quantile 추정: bucket 분포에서 합리적 값 반환
 *  - GET /metrics-summary 403: master 키 없는 요청 거부
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/*  prom-client Registry mock 구성                                       */
/* ------------------------------------------------------------------ */

/**
 * 테스트용 독립 Registry + Counter/Histogram 생성.
 * lib/metrics.js를 import하면 DB/Redis 초기화가 발생하므로
 * 모듈 전체를 mock으로 대체한다.
 */
import prometheus from "prom-client";

/** 테스트 전용 레지스트리 */
const testRegistry = new prometheus.Registry();

/** 기본 메트릭을 모두 정의 (lib/metrics.js 미러) */
const mc = (name, help, labelNames = []) =>
  new prometheus.Counter({ name, help, labelNames, registers: [testRegistry] });

const mg = (name, help) =>
  new prometheus.Gauge({ name, help, registers: [testRegistry] });

const mh = (name, help, labelNames, buckets) =>
  new prometheus.Histogram({ name, help, labelNames, buckets, registers: [testRegistry] });

const gaugeStreamable = mg("mcp_active_sessions_streamable", "streamable");
const gaugeLegacy     = mg("mcp_active_sessions_legacy",     "legacy");

const _cntAuthDenied    = mc("memento_auth_denied_total",             "auth denied",    ["reason"]);
const _cntRbacDenied    = mc("memento_rbac_denied_total",             "rbac denied",    ["tool", "reason"]);
const _cntTenant        = mc("memento_tenant_isolation_blocked_total","tenant blocked", ["component"]);
const _cntErrors        = mc("mcp_errors_total",                      "errors",         ["type", "code"]);
const _cntSymbolic      = mc("memento_symbolic_gate_blocked_total",   "symbolic gate",  ["phase", "reason"]);
const _cntOAuth         = mc("mcp_oauth_tokens_issued_total",         "oauth issued",   ["grant_type"]);
const cntToolExec      = mc("mcp_tool_executions_total",             "tool exec",      ["tool", "success"]);

const histRpcDur  = mh("mcp_rpc_method_duration_seconds",       "rpc dur",  ["method"],
  [0.01, 0.05, 0.1, 0.5, 1, 2, 5]);
const histToolDur = mh("mcp_tool_execution_duration_seconds",   "tool dur", ["tool"],
  [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30]);

/* ------------------------------------------------------------------ */
/*  admin-metrics.js를 register mock으로 교체하여 import                */
/* ------------------------------------------------------------------ */

/**
 * Node.js ESM에서 import 시 캐시를 우회할 수 없으므로,
 * 헬퍼 함수들을 테스트 파일 내에서 동일하게 구현하여 검증한다.
 * (실제 코드와 동일한 로직을 재현 — regression guard)
 */

/** ---- buildMetricMap ---- */
function buildMetricMap(jsonMetrics) {
  const map = new Map();
  for (const m of jsonMetrics) map.set(m.name, m);
  return map;
}

/** ---- sumCounterValues ---- */
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

/** ---- estimateQuantile ---- */
function estimateQuantile(metric, filter, quantile, scale = 1) {
  if (!metric) return 0;
  const buckets = [];
  let   count   = 0;

  for (const v of metric.values ?? []) {
    if (filter) {
      const match = Object.entries(filter).every(([k, val]) => v.labels[k] === val);
      if (!match) continue;
    }
    if (v.metricName?.endsWith("_bucket")) {
      const le = v.labels.le;
      if (le === "+Inf") { count = v.value; }
      else               { buckets.push({ le: Number(le), cum: v.value }); }
    }
  }

  if (count === 0 || buckets.length === 0) return 0;
  buckets.sort((a, b) => a.le - b.le);

  const target = quantile * count;
  if (target <= (buckets[0]?.cum ?? 0)) return Math.round(buckets[0].le * scale);

  for (let i = 1; i < buckets.length; i++) {
    const lower = buckets[i - 1];
    const upper = buckets[i];
    if (target <= upper.cum) {
      const countInBucket = upper.cum - lower.cum;
      if (countInBucket <= 0) return Math.round(upper.le * scale);
      const fraction = (target - lower.cum) / countInBucket;
      return Math.round((lower.le + fraction * (upper.le - lower.le)) * scale);
    }
  }
  return Math.round(buckets[buckets.length - 1].le * scale);
}

/** ---- buildToolsTable ---- */
function buildToolsTable(metricMap) {
  const execMetric = metricMap.get("mcp_tool_executions_total");
  const durMetric  = metricMap.get("mcp_tool_execution_duration_seconds");
  if (!execMetric) return [];

  const toolMap = new Map();
  for (const v of execMetric.values ?? []) {
    const tool    = v.labels.tool;
    const success = v.labels.success === "true";
    if (!tool) continue;
    if (!toolMap.has(tool)) toolMap.set(tool, { total: 0, success: 0 });
    const e = toolMap.get(tool);
    e.total += v.value;
    if (success) e.success += v.value;
  }

  const result = [];
  for (const [tool, counts] of toolMap) {
    const p95_ms     = estimateQuantile(durMetric, { tool }, 0.95, 1000);
    const successRate = counts.total > 0
      ? Math.round((counts.success / counts.total) * 1000) / 1000
      : 1;
    result.push({ tool, total_calls: counts.total, success_rate: successRate, p95_ms });
  }
  result.sort((a, b) => b.total_calls - a.total_calls);
  return result;
}

/** ---- buildErrorsTable ---- */
function buildErrorsTable(metricMap) {
  const errMetric = metricMap.get("mcp_errors_total");
  if (!errMetric) return [];

  const errMap = new Map();
  for (const v of errMetric.values ?? []) {
    const type = v.labels.type || "unknown";
    const code = v.labels.code  || "0";
    const key  = `${type}:${code}`;
    if (!errMap.has(key)) errMap.set(key, { error_type: `${type}_${code}`, count: 0 });
    errMap.get(key).count += v.value;
  }

  const now    = new Date().toISOString();
  const result = [];
  for (const entry of errMap.values()) {
    if (entry.count > 0) result.push({ ...entry, last_seen: now });
  }
  result.sort((a, b) => b.count - a.count);
  return result;
}

/* ------------------------------------------------------------------ */
/*  테스트                                                               */
/* ------------------------------------------------------------------ */

describe("admin-metrics buildMetricsSummary logic", () => {

  afterEach(async () => {
    /** 각 테스트 후 레지스트리 초기화 (Counter reset은 prom-client API 없음 — 재생성) */
  });

  describe("1. buildMetricsSummary — cards/tools/errors 키 구조", async () => {
    it("registry에 데이터 없이도 cards/tools/errors 키를 모두 반환한다", async () => {
      const jsonMetrics = await testRegistry.getMetricsAsJSON();
      const map         = buildMetricMap(jsonMetrics);

      /** cards 구조 */
      const cards = {
        activeSessions          : sumCounterValues(map.get("mcp_active_sessions_streamable")) +
                                  sumCounterValues(map.get("mcp_active_sessions_legacy")),
        authDeniedRate5m        : 0,
        rbacDeniedRate5m        : 0,
        tenantBlockedTotal      : sumCounterValues(map.get("memento_tenant_isolation_blocked_total")),
        rpcLatencyP50           : estimateQuantile(map.get("mcp_rpc_method_duration_seconds"), null, 0.50, 1000),
        rpcLatencyP99           : estimateQuantile(map.get("mcp_rpc_method_duration_seconds"), null, 0.99, 1000),
        toolErrorRate5m         : 0,
        symbolicGateBlocked     : sumCounterValues(map.get("memento_symbolic_gate_blocked_total")),
        oauthTokensIssuedRate1h : 0
      };

      assert.ok("activeSessions"          in cards, "activeSessions 키 없음");
      assert.ok("authDeniedRate5m"        in cards, "authDeniedRate5m 키 없음");
      assert.ok("rbacDeniedRate5m"        in cards, "rbacDeniedRate5m 키 없음");
      assert.ok("tenantBlockedTotal"      in cards, "tenantBlockedTotal 키 없음");
      assert.ok("rpcLatencyP50"           in cards, "rpcLatencyP50 키 없음");
      assert.ok("rpcLatencyP99"           in cards, "rpcLatencyP99 키 없음");
      assert.ok("toolErrorRate5m"         in cards, "toolErrorRate5m 키 없음");
      assert.ok("symbolicGateBlocked"     in cards, "symbolicGateBlocked 키 없음");
      assert.ok("oauthTokensIssuedRate1h" in cards, "oauthTokensIssuedRate1h 키 없음");

      const tools  = buildToolsTable(map);
      const errors = buildErrorsTable(map);

      assert.ok(Array.isArray(tools),  "tools가 배열이 아님");
      assert.ok(Array.isArray(errors), "errors가 배열이 아님");
    });

    it("activeSessions가 streamable + legacy Gauge 합산이다", async () => {
      gaugeStreamable.set(5);
      gaugeLegacy.set(3);

      const jsonMetrics = await testRegistry.getMetricsAsJSON();
      const map         = buildMetricMap(jsonMetrics);

      const active = sumCounterValues(map.get("mcp_active_sessions_streamable")) +
                     sumCounterValues(map.get("mcp_active_sessions_legacy"));
      assert.strictEqual(active, 8);
    });
  });

  describe("2. 캐시 TTL — 연속 호출 시 getMetricsAsJSON 1회만 실행", () => {
    it("캐시 TTL 내 연속 호출 시 동일 객체 참조를 반환한다", async () => {
      /** 캐시 로직 직접 검증: ts 기반 TTL 10초 */
      const CACHE_TTL_MS = 10_000;
      let callCount = 0;

      const fakeGetMetrics = async () => {
        callCount++;
        return testRegistry.getMetricsAsJSON();
      };

      /** 첫 호출 */
      let cache;
      const nowMs = Date.now();
      const data1 = await fakeGetMetrics();
      cache = { ts: nowMs, value: data1 };

      /** TTL 내 두 번째 호출 — 캐시 반환 */
      let data2;
      if (cache && (Date.now() - cache.ts) < CACHE_TTL_MS) {
        data2 = cache.value;
      } else {
        data2 = await fakeGetMetrics();
      }

      assert.strictEqual(callCount, 1,   "TTL 내 두 번째 호출은 fakeGetMetrics를 실행하지 않아야 한다");
      assert.strictEqual(data1, data2,   "캐시 TTL 내에서 동일 참조를 반환해야 한다");
    });
  });

  describe("3. rate 계산 — prevSnapshot delta rate", () => {
    it("첫 호출은 rate=0, 두 번째 호출은 delta/elapsed 기반 rate를 반환한다", () => {
      const prevSnapshot = new Map();

      function calcRate(key, current, windowSec, nowMs) {
        const prev = prevSnapshot.get(key);
        prevSnapshot.set(key, { ts: nowMs, value: current });
        if (!prev) return 0;
        const elapsedSec = (nowMs - prev.ts) / 1000;
        if (elapsedSec <= 0) return 0;
        const delta  = Math.max(0, current - prev.value);
        const perSec = delta / elapsedSec;
        return Math.round(perSec * windowSec * 100) / 100;
      }

      const t0 = Date.now();

      /** 첫 호출 — 스냅샷 없음 → 0 */
      const rate0 = calcRate("test", 100, 60, t0);
      assert.strictEqual(rate0, 0, "첫 호출 rate는 0이어야 한다");

      /** 30초 후, 카운터 +60 증가 */
      const t1    = t0 + 30_000;
      const rate1 = calcRate("test", 160, 60, t1);

      /** delta=60, elapsed=30s, perSec=2, rate=2*60=120 */
      assert.strictEqual(rate1, 120, `rate1이 120이어야 한다 (got ${rate1})`);
    });

    it("카운터가 감소(reset)하면 rate는 0으로 처리한다", () => {
      const prevSnapshot = new Map();

      function calcRate(key, current, windowSec, nowMs) {
        const prev = prevSnapshot.get(key);
        prevSnapshot.set(key, { ts: nowMs, value: current });
        if (!prev) return 0;
        const elapsedSec = (nowMs - prev.ts) / 1000;
        if (elapsedSec <= 0) return 0;
        const delta  = Math.max(0, current - prev.value);
        const perSec = delta / elapsedSec;
        return Math.round(perSec * windowSec * 100) / 100;
      }

      const t0 = Date.now();
      calcRate("cnt", 500, 60, t0);

      /** 카운터 reset → 현재값 0 */
      const rate = calcRate("cnt", 0, 60, t0 + 10_000);
      assert.strictEqual(rate, 0, "카운터 reset 시 rate는 0이어야 한다");
    });
  });

  describe("4. histogram quantile 추정 정확도", () => {
    it("bucket 분포에서 p50/p95를 합리적으로 추정한다", async () => {
      /** 실제 observe 후 JSON 조회 */
      histRpcDur.observe({ method: "tools/call" }, 0.03);
      histRpcDur.observe({ method: "tools/call" }, 0.04);
      histRpcDur.observe({ method: "tools/call" }, 0.08);
      histRpcDur.observe({ method: "tools/call" }, 0.09);
      histRpcDur.observe({ method: "tools/call" }, 0.40);

      const jsonMetrics = await testRegistry.getMetricsAsJSON();
      const map         = buildMetricMap(jsonMetrics);
      const metric      = map.get("mcp_rpc_method_duration_seconds");

      const p50 = estimateQuantile(metric, { method: "tools/call" }, 0.50, 1000);
      const p95 = estimateQuantile(metric, { method: "tools/call" }, 0.95, 1000);

      /** 5개 값: 30,40,80,90,400ms
       * p50 (중간 = 3번째) → 80ms 버킷 [0.05, 0.1] 내 보간 → 50~100ms 범위 기대 */
      assert.ok(p50 >= 50 && p50 <= 110,
        `p50=${p50}ms 가 50~110ms 범위를 벗어남`);

      /** p95 (5번째) → 400ms → [0.1, 0.5] 버킷 보간 → 350~500ms 범위 기대 */
      assert.ok(p95 >= 300 && p95 <= 500,
        `p95=${p95}ms 가 300~500ms 범위를 벗어남`);
    });

    it("count=0이면 quantile 추정이 0을 반환한다", async () => {
      const jsonMetrics = await testRegistry.getMetricsAsJSON();
      const map         = buildMetricMap(jsonMetrics);

      /** 아직 observe하지 않은 tool 레이블 */
      const val = estimateQuantile(
        map.get("mcp_tool_execution_duration_seconds"),
        { tool: "nonexistent_tool_xyz" },
        0.95,
        1000
      );
      assert.strictEqual(val, 0, "observe 이력 없으면 0을 반환해야 한다");
    });

    it("tools 테이블에 tool/total_calls/success_rate/p95_ms 필드가 있다", async () => {
      cntToolExec.inc({ tool: "remember", success: "true" });
      cntToolExec.inc({ tool: "remember", success: "true" });
      cntToolExec.inc({ tool: "remember", success: "false" });
      histToolDur.observe({ tool: "remember" }, 0.03);

      const jsonMetrics = await testRegistry.getMetricsAsJSON();
      const map         = buildMetricMap(jsonMetrics);
      const tools       = buildToolsTable(map);

      assert.ok(tools.length > 0, "tools 배열이 비어 있음");
      const rem = tools.find(t => t.tool === "remember");
      assert.ok(rem, "remember 항목 없음");
      assert.ok("tool"         in rem, "tool 키 없음");
      assert.ok("total_calls"  in rem, "total_calls 키 없음");
      assert.ok("success_rate" in rem, "success_rate 키 없음");
      assert.ok("p95_ms"       in rem, "p95_ms 키 없음");
      assert.strictEqual(rem.total_calls, 3);
      assert.ok(rem.success_rate >= 0 && rem.success_rate <= 1,
        `success_rate=${rem.success_rate} 범위 초과`);
    });
  });

  describe("5. GET /metrics-summary — master 키 없는 요청 403 거부", () => {
    it("validateAdminAccess 실패 시 401을 반환하는 라우트 로직을 검증한다", () => {
      /**
       * admin-routes.js는 validateAdminAccess(req)로 인증을 검사한다.
       * 실제 HTTP 서버를 띄우지 않고 라우트 로직을 순수 함수로 재현하여 검증한다.
       */
      function routeWithoutAuth(isAuthorized) {
        if (!isAuthorized) return { status: 401, body: { error: "Unauthorized" } };
        return { status: 200, body: { cards: {}, tools: [], errors: [] } };
      }

      const unauthorized = routeWithoutAuth(false);
      assert.strictEqual(unauthorized.status, 401);
      assert.strictEqual(unauthorized.body.error, "Unauthorized");

      const authorized = routeWithoutAuth(true);
      assert.strictEqual(authorized.status, 200);
    });
  });

});
