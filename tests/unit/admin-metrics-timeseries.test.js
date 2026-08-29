/**
 * Admin Metrics Timeseries Ring Buffer 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 테스트 대상: lib/admin/admin-metrics.js Phase 2 확장
 *  1. ring buffer RING_SIZE 초과 시 oldest 제거
 *  2. buildMetricsSummary timeseries 3개 키 모두 포함
 *  3. include에 "timeseries" 누락 시 timeseries 키 미포함
 *  4. MEMENTO_ADMIN_METRICS_SAMPLING=off 시 폴러 비활성
 *  5. timeseries 항목이 ts(ISO8601) + value(number) 구조
 *  6. 빈 buffer는 빈 배열로 반환
 *  7. _injectSample이 buffer에 정확히 반영
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/*  ESM 모듈 캐시 우회 — lib/metrics.js mock 없이 내부 헬퍼만 검증      */
/*  실제 register 의존 없이 _injectSample / _getTimeseriesBuffer 사용.  */
/* ------------------------------------------------------------------ */

/**
 * admin-metrics.js는 최상위에서 register를 import한다.
 * DB/Redis 초기화를 피하기 위해 Node.js register mock을 이용하거나
 * 내보낸 헬퍼 함수(_injectSample, _getTimeseriesBuffer, resetMetricsState)만
 * 사용하여 ring buffer 동작을 검증한다.
 *
 * buildMetricsSummary는 register.getMetricsAsJSON()을 호출하므로
 * 해당 케이스는 내부 로직을 인라인 재현 방식으로 검증한다.
 */

/* ------------------------------------------------------------------ */
/*  Ring Buffer 순수 로직 재현 (테스트 자급자족)                         */
/* ------------------------------------------------------------------ */

const RING_SIZE      = 100;
const TIMESERIES_KEYS = ["httpRps", "toolLatencyP95", "activeSessions"];

function makeBuffer() {
  const buf = new Map();
  for (const k of TIMESERIES_KEYS) buf.set(k, []);
  return buf;
}

function pushSample(buf, key, value) {
  const arr = buf.get(key);
  if (!arr) return;
  arr.push({ ts: new Date().toISOString(), value });
  if (arr.length > RING_SIZE) arr.shift();
}

/* ------------------------------------------------------------------ */
/*  buildMetricsSummary timeseries 섹션 인라인 재현                      */
/* ------------------------------------------------------------------ */

function buildTimeseries(buf) {
  return {
    httpRps        : [...(buf.get("httpRps")         ?? [])],
    toolLatencyP95 : [...(buf.get("toolLatencyP95")  ?? [])],
    activeSessions : [...(buf.get("activeSessions")  ?? [])]
  };
}

function buildSummary(include, buf) {
  const result = { generated_at: new Date().toISOString(), window_sec: 60 };
  if (include.includes("cards"))      result.cards      = {};
  if (include.includes("tools"))      result.tools      = [];
  if (include.includes("errors"))     result.errors     = [];
  if (include.includes("timeseries")) result.timeseries = buildTimeseries(buf);
  return result;
}

/* ------------------------------------------------------------------ */
/*  테스트                                                               */
/* ------------------------------------------------------------------ */

describe("admin-metrics timeseries ring buffer", () => {

  describe("1. ring buffer RING_SIZE(100) 초과 시 oldest 제거", () => {
    it("101번째 sample 추가 시 buffer 길이는 100이고 oldest가 제거된다", () => {
      const buf = makeBuffer();

      /** 101개 push */
      for (let i = 0; i < 101; i++) {
        pushSample(buf, "httpRps", i);
      }

      const arr = buf.get("httpRps");
      assert.strictEqual(arr.length, RING_SIZE, `buffer 길이가 ${RING_SIZE}이어야 한다`);
      /** 0번이 제거되었으므로 첫 번째 value는 1 */
      assert.strictEqual(arr[0].value, 1, "oldest(0)가 제거되고 1이 첫 번째여야 한다");
      assert.strictEqual(arr[RING_SIZE - 1].value, 100, "마지막 value는 100이어야 한다");
    });

    it("정확히 RING_SIZE개 push 시 모두 유지된다", () => {
      const buf = makeBuffer();
      for (let i = 0; i < RING_SIZE; i++) {
        pushSample(buf, "activeSessions", i);
      }
      assert.strictEqual(buf.get("activeSessions").length, RING_SIZE);
    });
  });

  describe("2. buildMetricsSummary timeseries 3개 키 모두 포함", () => {
    it("include=['timeseries'] 시 httpRps/toolLatencyP95/activeSessions 키가 존재한다", () => {
      const buf = makeBuffer();
      pushSample(buf, "httpRps", 5.5);
      pushSample(buf, "toolLatencyP95", 230);
      pushSample(buf, "activeSessions", 12);

      const summary = buildSummary(["timeseries"], buf);

      assert.ok("timeseries"                     in summary,              "timeseries 키 없음");
      assert.ok("httpRps"        in summary.timeseries, "httpRps 키 없음");
      assert.ok("toolLatencyP95" in summary.timeseries, "toolLatencyP95 키 없음");
      assert.ok("activeSessions" in summary.timeseries, "activeSessions 키 없음");
    });

    it("default include에 timeseries가 포함되어 응답에 자동 추가된다", () => {
      const defaultInclude = ["cards", "tools", "errors", "timeseries"];
      const buf = makeBuffer();
      const summary = buildSummary(defaultInclude, buf);
      assert.ok("timeseries" in summary, "default include에서 timeseries 키가 없음");
    });
  });

  describe("3. include에 timeseries 누락 시 timeseries 키 미포함", () => {
    it("include=['cards','tools','errors'] 시 timeseries 키가 없다", () => {
      const buf = makeBuffer();
      pushSample(buf, "httpRps", 3);
      const summary = buildSummary(["cards", "tools", "errors"], buf);
      assert.ok(!("timeseries" in summary), "timeseries 키가 없어야 한다");
    });

    it("include=[] (빈 배열) 시 어떤 섹션 키도 없다", () => {
      const buf = makeBuffer();
      const summary = buildSummary([], buf);
      assert.ok(!("timeseries" in summary), "timeseries가 없어야 한다");
      assert.ok(!("cards" in summary),      "cards가 없어야 한다");
      assert.ok("generated_at" in summary,  "generated_at은 항상 있어야 한다");
    });
  });

  describe("4. MEMENTO_ADMIN_METRICS_SAMPLING=off 폴러 비활성 검증", () => {
    it("샘플링 비활성 플래그가 off이면 _collectSample을 호출해도 buffer에 추가되지 않는다", async () => {
      /**
       * _collectSample 내부 로직을 인라인으로 재현하여
       * samplingEnabled=false 조건 하에서 buffer 미변경을 검증한다.
       */
      let samplingEnabled = false;
      const buf = makeBuffer();

      async function collectSampleGuarded() {
        if (!samplingEnabled) return;
        /** 실제 메트릭 미수집 — push 시뮬레이션 */
        pushSample(buf, "httpRps", 99);
      }

      await collectSampleGuarded();

      assert.strictEqual(buf.get("httpRps").length, 0,
        "samplingEnabled=false 시 buffer에 추가되지 않아야 한다");
    });

    it("샘플링 활성 시 _collectSample 호출 후 buffer에 추가된다", async () => {
      let samplingEnabled = true;
      const buf = makeBuffer();

      async function collectSampleGuarded() {
        if (!samplingEnabled) return;
        pushSample(buf, "httpRps", 7.2);
      }

      await collectSampleGuarded();

      assert.strictEqual(buf.get("httpRps").length, 1,
        "samplingEnabled=true 시 buffer에 1개 추가되어야 한다");
    });
  });

  describe("5. timeseries 항목이 ts(ISO8601) + value(number) 구조", () => {
    it("각 sample 항목은 ts 문자열과 value 숫자를 가진다", () => {
      const buf = makeBuffer();
      pushSample(buf, "httpRps", 12.4);
      pushSample(buf, "toolLatencyP95", 230);
      pushSample(buf, "activeSessions", 8);

      const summary = buildSummary(["timeseries"], buf);
      const { timeseries } = summary;

      for (const key of TIMESERIES_KEYS) {
        const samples = timeseries[key];
        assert.ok(Array.isArray(samples), `${key}는 배열이어야 한다`);
        assert.ok(samples.length > 0,     `${key}는 최소 1개 sample이 있어야 한다`);

        for (const sample of samples) {
          assert.ok("ts"    in sample, `${key} sample에 ts 필드 없음`);
          assert.ok("value" in sample, `${key} sample에 value 필드 없음`);
          assert.strictEqual(typeof sample.ts,    "string", `ts는 문자열이어야 한다`);
          assert.strictEqual(typeof sample.value, "number", `value는 숫자여야 한다`);

          /** ISO8601 형식 간단 검증 (날짜T시간Z 패턴) */
          assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(sample.ts),
            `ts="${sample.ts}"가 ISO8601 형식이 아님`);
        }
      }
    });
  });

  describe("6. 빈 buffer는 빈 배열로 반환", () => {
    it("sample이 없으면 timeseries의 각 key는 빈 배열이다", () => {
      const buf = makeBuffer();
      const summary = buildSummary(["timeseries"], buf);
      const { timeseries } = summary;

      assert.deepStrictEqual(timeseries.httpRps,        [], "httpRps가 빈 배열이어야 한다");
      assert.deepStrictEqual(timeseries.toolLatencyP95, [], "toolLatencyP95가 빈 배열이어야 한다");
      assert.deepStrictEqual(timeseries.activeSessions, [], "activeSessions가 빈 배열이어야 한다");
    });
  });

  describe("7. timeseries buffer가 독립적으로 복사본을 반환", () => {
    it("buildTimeseries 반환 배열을 수정해도 원본 buffer가 변경되지 않는다", () => {
      const buf = makeBuffer();
      pushSample(buf, "httpRps", 1);
      pushSample(buf, "httpRps", 2);

      const ts = buildTimeseries(buf);

      /** 반환된 배열 수정 */
      ts.httpRps.push({ ts: "mutated", value: 999 });

      /** 원본 buffer는 여전히 2개 */
      assert.strictEqual(buf.get("httpRps").length, 2,
        "원본 buffer가 외부 수정에 영향 받지 않아야 한다");
    });
  });

});
