/**
 * 합성 역질의 생성·검증·검색 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import {
  extractAnchorTokens,
  validateQuery,
  filterQueries,
  isEligible,
  generateQueries,
} from "../../lib/memory/embedding/SyntheticQueryGenerator.js";
import {
  aggregateHits,
  selectNewCandidates,
  normalizeKeyList,
  isSyntheticSearchEnabled,
} from "../../lib/memory/read/SyntheticQuerySearch.js";
import { RateLimiter } from "../../lib/memory/embedding/SyntheticQueryWorker.js";
import { MEMORY_CONFIG } from "../../config/memory.js";

const SOURCE = "Prometheus scrape_interval 기본값을 15초로 통일했다.";

describe("extractAnchorTokens", () => {
  test("영문 식별자와 수치를 뽑는다", () => {
    const t = extractAnchorTokens(SOURCE);
    assert.ok(t.has("prometheus"));
    assert.ok(t.has("scrape_interval"));
    assert.ok(t.has("15"));
  });

  test("경로를 뽑는다", () => {
    const t = extractAnchorTokens("설정은 /etc/nginx/nginx.conf에 있다");
    assert.ok([...t].some(x => x.startsWith("/etc/nginx")));
  });

  test("빈 입력은 빈 집합", () => {
    assert.equal(extractAnchorTokens("").size, 0);
    assert.equal(extractAnchorTokens(null).size, 0);
  });
});

describe("validateQuery", () => {
  test("고유명사를 보존한 질의는 채택한다", () => {
    const v = validateQuery("프로메테우스 scrape_interval 몇 초로 맞췄지", SOURCE);
    assert.equal(v.accept, true);
  });

  test("고유명사를 전부 잃은 질의는 거부한다", () => {
    const v = validateQuery("그거 몇 초로 했더라", SOURCE);
    assert.equal(v.accept, false);
    assert.equal(v.reason, "anchor_lost");
  });

  test("원문을 그대로 베낀 질의는 거부한다", () => {
    const v = validateQuery(SOURCE, SOURCE);
    assert.equal(v.accept, false);
    assert.equal(v.reason, "verbatim_copy");
  });

  test("빈 질의와 과도하게 긴 질의는 거부한다", () => {
    assert.equal(validateQuery("", SOURCE).reason, "empty");
    assert.equal(validateQuery("가".repeat(500) + " 15", SOURCE).reason, "too_long");
  });

  test("원문에 없던 한자나 가나가 섞이면 거부한다", () => {
    const v = validateQuery("prometheus 수집 주기 有哪些", SOURCE);
    assert.equal(v.accept, false);
    assert.equal(v.reason, "language_drift");
  });

  test("원문에 한자가 있으면 질의의 한자를 허용한다", () => {
    const v = validateQuery("開天錄 gcr 문파 설정 뭐였지", "開天錄 문파 설정을 정리했다 gcr");
    assert.equal(v.accept, true);
  });

  test("원문에 고유명사가 없으면 보존 검사를 적용하지 않는다", () => {
    const v = validateQuery("어떻게 처리했지", "적당히 처리했다");
    assert.equal(v.accept, true);
  });
});

describe("filterQueries", () => {
  test("중복 질의는 하나만 남긴다", () => {
    const { accepted } = filterQueries(
      ["Prometheus 수집 주기 15초?", "prometheus 수집 주기 15초?", "scrape_interval 15 설정 이유"],
      SOURCE
    );
    assert.equal(accepted.length, 2);
  });

  test("최대 개수를 넘지 않는다", () => {
    const many = Array.from({ length: 10 }, (_, i) => `scrape_interval 15 관련 질문 ${i}`);
    const { accepted } = filterQueries(many, SOURCE, { maxQueries: 3 });
    assert.equal(accepted.length, 3);
  });

  test("거부 사유를 함께 돌려준다", () => {
    const { accepted, rejected } = filterQueries(["그거 뭐였지", "prometheus 15초 설정"], SOURCE);
    assert.equal(accepted.length, 1);
    assert.ok(rejected.some(r => r.reason === "anchor_lost"));
  });

  test("배열이 아니면 빈 결과", () => {
    assert.deepEqual(filterQueries(null, SOURCE).accepted, []);
  });
});

describe("isEligible", () => {
  const cfg = { enabled: true, minImportance: 0.8, types: ["error", "procedure", "decision"] };

  test("중요도와 유형을 모두 만족해야 대상이다", () => {
    assert.equal(isEligible({ type: "error", importance: 0.9 }, cfg), true);
    assert.equal(isEligible({ type: "error", importance: 0.7 }, cfg), false);
    assert.equal(isEligible({ type: "fact",  importance: 0.9 }, cfg), false);
  });

  test("설정이 꺼져 있으면 항상 대상이 아니다", () => {
    assert.equal(isEligible({ type: "error", importance: 1.0 }, { ...cfg, enabled: false }), false);
  });

  test("파편이 없으면 대상이 아니다", () => {
    assert.equal(isEligible(null, cfg), false);
  });
});

describe("generateQueries", () => {
  test("LLM 응답에서 채택 가능한 질의만 남긴다", async () => {
    const fakeLlm = async () => ({ queries: ["prometheus 수집 주기 15초 맞나", "그거 뭐였지"] });
    const { queries, rejected } = await generateQueries(SOURCE, { llm: fakeLlm });
    assert.equal(queries.length, 1);
    assert.ok(rejected.some(r => r.reason === "anchor_lost"));
  });

  test("LLM 실패는 예외 없이 빈 결과로 돌려준다", async () => {
    const failing = async () => { throw new Error("provider down"); };
    const { queries } = await generateQueries(SOURCE, { llm: failing });
    assert.deepEqual(queries, []);
  });

  test("빈 본문은 LLM을 호출하지 않는다", async () => {
    let called = false;
    const spy = async () => { called = true; return { queries: [] }; };
    const { queries } = await generateQueries("   ", { llm: spy });
    assert.equal(called, false);
    assert.deepEqual(queries, []);
  });

  test("배열만 돌려주는 응답도 받아들인다", async () => {
    const arrayLlm = async () => ["scrape_interval 15초 설정 근거"];
    const { queries } = await generateQueries(SOURCE, { llm: arrayLlm });
    assert.equal(queries.length, 1);
  });
});

describe("aggregateHits", () => {
  test("파편별 최고 유사도에 감쇠를 적용한다", () => {
    const m = aggregateHits([
      { fragment_id: "a", similarity: 0.5 },
      { fragment_id: "a", similarity: 0.7 },
      { fragment_id: "b", similarity: 0.4 },
    ], 0.5);
    assert.equal(m.get("a"), 0.35);
    assert.equal(m.get("b"), 0.2);
  });

  test("유효하지 않은 항목은 건너뛴다", () => {
    const m = aggregateHits([{ fragment_id: null, similarity: 1 }, { fragment_id: "a", similarity: "x" }]);
    assert.equal(m.size, 0);
  });
});

describe("selectNewCandidates", () => {
  test("이미 찾은 파편은 제외하고 상위만 남긴다", () => {
    const agg = new Map([["a", 0.9], ["b", 0.8], ["c", 0.7]]);
    const out = selectNewCandidates(agg, new Set(["a"]), 1);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "b");
  });

  test("전부 중복이면 빈 배열", () => {
    const agg = new Map([["a", 0.9]]);
    assert.deepEqual(selectNewCandidates(agg, new Set(["a"]), 5), []);
  });
});

describe("normalizeKeyList", () => {
  test("그룹 키가 있으면 그것을 쓴다", () => {
    assert.deepEqual(normalizeKeyList("k1", ["k1", "k2"]), ["k1", "k2"]);
  });

  test("스칼라 키는 배열로 감싼다", () => {
    assert.deepEqual(normalizeKeyList("k1", undefined), ["k1"]);
  });

  test("마스터 스코프는 null", () => {
    assert.equal(normalizeKeyList(null, undefined), null);
    assert.equal(normalizeKeyList([], undefined), null);
  });
});

describe("RateLimiter", () => {
  test("분당 상한까지만 허용한다", () => {
    const rl = new RateLimiter(2);
    const now = 1_000_000;
    assert.equal(rl.tryAcquire(now), true);
    assert.equal(rl.tryAcquire(now), true);
    assert.equal(rl.tryAcquire(now), false);
  });

  test("1분이 지나면 다시 허용한다", () => {
    const rl = new RateLimiter(1);
    const now = 1_000_000;
    assert.equal(rl.tryAcquire(now), true);
    assert.equal(rl.tryAcquire(now + 61_000), true);
  });

  test("0 이하는 제한 없음으로 취급한다", () => {
    const rl = new RateLimiter(0);
    for (let i = 0; i < 50; i++) assert.equal(rl.tryAcquire(1_000_000), true);
  });
});

describe("syntheticQuery 설정", () => {
  test("생성과 검색 스위치가 각각 존재한다", () => {
    assert.equal(typeof MEMORY_CONFIG.syntheticQuery.enabled, "boolean");
    assert.equal(typeof MEMORY_CONFIG.syntheticQuery.searchEnabled, "boolean");
    assert.equal(typeof isSyntheticSearchEnabled(), "boolean");
  });

  test("대상 제한이 기본으로 좁게 잡혀 있다", () => {
    assert.ok(MEMORY_CONFIG.syntheticQuery.minImportance >= 0.7);
    assert.ok(Array.isArray(MEMORY_CONFIG.syntheticQuery.types));
    assert.ok(MEMORY_CONFIG.syntheticQuery.types.length <= 4);
  });

  test("보조 히트 감쇠가 1 미만이다", () => {
    assert.ok(MEMORY_CONFIG.syntheticQuery.similarityDecay < 1);
  });

  test("전용 큐가 임베딩 큐와 분리되어 있다", () => {
    assert.notEqual(MEMORY_CONFIG.syntheticQuery.queueKey, MEMORY_CONFIG.embeddingWorker.queueKey);
  });
});
