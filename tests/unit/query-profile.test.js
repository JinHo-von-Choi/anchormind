/**
 * 질의 의도 분류와 검색 프로파일 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { classifyQueryIntent } from "../../lib/memory/signals/SearchEventRecorder.js";
import {
  resolveQueryProfile,
  applySimilarityDelta,
  applyProfileToConfig,
  resolveMorphemeThreshold,
  isProfileEnabled,
} from "../../lib/memory/read/QueryProfile.js";
import { MEMORY_CONFIG } from "../../config/memory.js";

describe("classifyQueryIntent", () => {
  test("코드 식별자·수치 중심 질의는 EXACT_SYMBOL", () => {
    assert.equal(classifyQueryIntent({ text: "max_connections 500" }), "EXACT_SYMBOL");
    assert.equal(classifyQueryIntent({ text: "listen 8443 ssl" }), "EXACT_SYMBOL");
    assert.equal(classifyQueryIntent({ text: "MEMENTO_RECALL_MIN_SIM_FLOOR" }), "EXACT_SYMBOL");
    assert.equal(classifyQueryIntent({ text: "lib/memory/read/FragmentSearch.js" }), "EXACT_SYMBOL");
  });

  test("원인·방법·의문형 질의는 CONCEPT_INTENT", () => {
    assert.equal(classifyQueryIntent({ text: "결제가 안 되던 이유가 뭐야" }), "CONCEPT_INTENT");
    assert.equal(classifyQueryIntent({ text: "장애 났을 때 어떤 순서로 대응하나" }), "CONCEPT_INTENT");
    assert.equal(classifyQueryIntent({ text: "왜 느려졌지" }), "CONCEPT_INTENT");
  });

  test("식별자와 의문형이 섞이면 HYBRID로 떨어질 수 있다", () => {
    const intent = classifyQueryIntent({ text: "nginx 502 반복되던 원인이 keepalive 관련이었나" });
    assert.ok(["HYBRID", "CONCEPT_INTENT", "EXACT_SYMBOL"].includes(intent));
  });

  test("keywords 배열도 분류 대상에 포함한다", () => {
    assert.equal(classifyQueryIntent({ keywords: ["max_connections", "postgres"] }), "EXACT_SYMBOL");
  });

  test("빈 질의와 비객체 입력은 HYBRID", () => {
    assert.equal(classifyQueryIntent({}), "HYBRID");
    assert.equal(classifyQueryIntent(null), "HYBRID");
    assert.equal(classifyQueryIntent({ text: "" }), "HYBRID");
  });
});

describe("resolveQueryProfile", () => {
  const original = process.env.MEMENTO_QUERY_PROFILE_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.MEMENTO_QUERY_PROFILE_ENABLED;
    else process.env.MEMENTO_QUERY_PROFILE_ENABLED = original;
  });

  test("환경변수로 끄면 항등 프로파일을 돌려준다", () => {
    process.env.MEMENTO_QUERY_PROFILE_ENABLED = "false";
    assert.equal(isProfileEnabled(), false);
    const p = resolveQueryProfile({ text: "왜 느려졌지" });
    assert.equal(p.applied, false);
    assert.equal(p.l2WeightFactor, 1.0);
    assert.equal(p.l3WeightFactor, 1.0);
    assert.equal(p.minSimilarityDelta, 0);
  });

  test("켜져 있으면 의도에 맞는 프로파일이 적용된다", () => {
    process.env.MEMENTO_QUERY_PROFILE_ENABLED = "true";
    const p = resolveQueryProfile({ text: "장애 대응 절차가 어떻게 되나" });
    assert.equal(p.applied, true);
    assert.equal(p.intent, "CONCEPT_INTENT");
    assert.ok(p.l3WeightFactor > p.l2WeightFactor, "개념 질의는 벡터 경로 가중이 더 커야 한다");
    assert.ok(p.minSimilarityDelta < 0, "개념 질의는 임계값을 낮춰야 한다");
  });

  test("코드 질의 프로파일은 키워드 경로 가중이 더 크다", () => {
    process.env.MEMENTO_QUERY_PROFILE_ENABLED = "true";
    const p = resolveQueryProfile({ text: "max_connections 500" });
    assert.equal(p.intent, "EXACT_SYMBOL");
    assert.ok(p.l2WeightFactor > p.l3WeightFactor);
  });
});

describe("applySimilarityDelta", () => {
  test("보정치를 더하고 허용 범위로 클램프한다", () => {
    assert.equal(applySimilarityDelta(0.40, { minSimilarityDelta: -0.20 }), 0.20);
    assert.equal(applySimilarityDelta(0.40, { minSimilarityDelta: 0 }), 0.40);
  });

  test("하한 0.10, 상한 0.60을 넘지 않는다", () => {
    assert.equal(applySimilarityDelta(0.15, { minSimilarityDelta: -0.50 }), 0.10);
    assert.equal(applySimilarityDelta(0.55, { minSimilarityDelta: 0.30 }), 0.60);
  });

  test("프로파일이 없으면 원본을 유지한다", () => {
    assert.equal(applySimilarityDelta(0.40, null), 0.40);
  });
});

describe("applyProfileToConfig", () => {
  test("미적용 프로파일은 원본 설정 객체를 그대로 돌려준다", () => {
    const cfg = applyProfileToConfig(MEMORY_CONFIG, { applied: false });
    assert.equal(cfg, MEMORY_CONFIG);
  });

  test("lexical 가중치만 덮어쓰고 원본은 변경하지 않는다", () => {
    const before = MEMORY_CONFIG.ranking.lexicalWeightFallback;
    const cfg = applyProfileToConfig(MEMORY_CONFIG, {
      applied: true,
      exactKeywordBoost: 0.45,
      lexicalWeightReranked: 0.18,
      lexicalWeightFallback: 0.26,
    });
    assert.equal(cfg.ranking.lexicalWeightFallback, 0.26);
    assert.equal(cfg.ranking.exactKeywordBoost, 0.45);
    assert.equal(MEMORY_CONFIG.ranking.lexicalWeightFallback, before, "원본 설정이 오염되면 안 된다");
  });

  test("합계 1.0 제약이 걸린 세 가중치는 건드리지 않는다", () => {
    const cfg = applyProfileToConfig(MEMORY_CONFIG, {
      applied: true,
      exactKeywordBoost: 0.45,
      lexicalWeightReranked: null,
      lexicalWeightFallback: null,
    });
    assert.equal(cfg.ranking.importanceWeight, MEMORY_CONFIG.ranking.importanceWeight);
    assert.equal(cfg.ranking.recencyWeight,    MEMORY_CONFIG.ranking.recencyWeight);
    assert.equal(cfg.ranking.semanticWeight,   MEMORY_CONFIG.ranking.semanticWeight);
  });
});

describe("resolveMorphemeThreshold", () => {
  test("프로파일 값이 있으면 그 값을 쓴다", () => {
    assert.equal(resolveMorphemeThreshold(5, { morphemeFallbackThreshold: 12 }), 12);
  });

  test("없으면 기준값을 유지한다", () => {
    assert.equal(resolveMorphemeThreshold(5, { morphemeFallbackThreshold: null }), 5);
    assert.equal(resolveMorphemeThreshold(5, null), 5);
  });
});

describe("queryProfiles 설정 정합성", () => {
  test("세 프로파일이 모두 선언되어 있다", () => {
    for (const key of ["EXACT_SYMBOL", "CONCEPT_INTENT", "HYBRID"]) {
      assert.ok(MEMORY_CONFIG.queryProfiles[key], `${key} 프로파일 누락`);
    }
  });

  test("임계값 보정치가 클램프 범위를 벗어나지 않는 크기다", () => {
    for (const key of ["EXACT_SYMBOL", "CONCEPT_INTENT", "HYBRID"]) {
      const delta = MEMORY_CONFIG.queryProfiles[key].minSimilarityDelta ?? 0;
      assert.ok(Math.abs(delta) <= 0.5, `${key} minSimilarityDelta 과대: ${delta}`);
    }
  });
});
