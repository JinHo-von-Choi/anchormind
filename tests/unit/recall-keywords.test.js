/**
 * recall includeKeywords 옵션 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 *
 * includeKeywords=true 시 파편 응답에 keywords 배열 포함 여부 검증.
 * tool_recall 내부 매핑 로직을 직접 재현하여 DB 의존성 없이 테스트.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import { computeConfidence } from "../../lib/memory/consolidate/UtilityBaseline.js";

/**
 * tool_recall의 fragment 매핑 로직을 재현.
 * memory.js 94~107행의 매핑과 동일한 변환을 수행한다.
 */
function mapFragment(f, args, linkedMap = new Map()) {
  return {
    id          : f.id,
    content     : f.content,
    topic       : f.topic,
    type        : f.type,
    importance  : f.importance,
    created_at  : f.created_at,
    age_days    : Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86400000),
    access_count: f.access_count || 0,
    confidence  : computeConfidence(f.utility_score),
    linked      : linkedMap.get(f.id) || [],
    ...(f.similarity !== undefined ? { similarity: f.similarity }       : {}),
    ...(f.metadata?.stale         ? { stale_warning: f.metadata.warning } : {}),
    ...(args.includeKeywords      ? { keywords: f.keywords ?? [] }       : {})
  };
}

const MOCK_FRAGMENTS = [
  {
    id           : "frag-001",
    content      : "PostgreSQL 포트는 35432",
    topic        : "database",
    keywords     : ["postgresql", "port", "35432"],
    type         : "fact",
    importance   : 0.7,
    utility_score: 1.0,
    created_at   : new Date().toISOString(),
    access_count : 3,
    metadata     : {}
  },
  {
    id           : "frag-002",
    content      : "Redis 캐시 TTL 600초",
    topic        : "cache",
    keywords     : ["redis", "ttl", "cache"],
    type         : "decision",
    importance   : 0.8,
    utility_score: 1.2,
    created_at   : new Date(Date.now() - 2 * 86400000).toISOString(),
    access_count : 5,
    metadata     : {}
  },
  {
    id           : "frag-003",
    content      : "keywords가 null인 파편",
    topic        : "test",
    keywords     : null,
    type         : "fact",
    importance   : 0.5,
    utility_score: 0.8,
    created_at   : new Date().toISOString(),
    access_count : 0,
    metadata     : {}
  }
];

describe("recall includeKeywords 옵션", () => {

  test("includeKeywords=true: 응답 파편에 keywords 배열이 포함된다", () => {
    const args     = { includeKeywords: true };
    const mapped   = MOCK_FRAGMENTS.map(f => mapFragment(f, args));

    for (const frag of mapped) {
      assert.ok("keywords" in frag, `파편 ${frag.id}에 keywords 필드가 있어야 한다`);
      assert.ok(Array.isArray(frag.keywords), `파편 ${frag.id}의 keywords는 배열이어야 한다`);
    }
  });

  test("includeKeywords=false: 응답 파편에 keywords가 포함되지 않는다", () => {
    const args   = { includeKeywords: false };
    const mapped = MOCK_FRAGMENTS.map(f => mapFragment(f, args));

    for (const frag of mapped) {
      assert.ok(!("keywords" in frag), `파편 ${frag.id}에 keywords 필드가 없어야 한다`);
    }
  });

  test("includeKeywords 미지정: 응답 파편에 keywords가 포함되지 않는다", () => {
    const args   = {};
    const mapped = MOCK_FRAGMENTS.map(f => mapFragment(f, args));

    for (const frag of mapped) {
      assert.ok(!("keywords" in frag), `파편 ${frag.id}에 keywords 필드가 없어야 한다`);
    }
  });

  test("includeKeywords=true: keywords 배열이 올바른 값을 포함한다", () => {
    const args   = { includeKeywords: true };
    const mapped = MOCK_FRAGMENTS.map(f => mapFragment(f, args));

    const frag001 = mapped.find(f => f.id === "frag-001");
    assert.ok(frag001);
    assert.deepStrictEqual(frag001.keywords, ["postgresql", "port", "35432"]);

    const frag002 = mapped.find(f => f.id === "frag-002");
    assert.ok(frag002);
    assert.deepStrictEqual(frag002.keywords, ["redis", "ttl", "cache"]);
  });

  test("includeKeywords=true: keywords가 null인 파편은 빈 배열로 반환된다", () => {
    const args   = { includeKeywords: true };
    const mapped = MOCK_FRAGMENTS.map(f => mapFragment(f, args));

    const frag003 = mapped.find(f => f.id === "frag-003");
    assert.ok(frag003, "frag-003이 결과에 존재해야 한다");
    assert.deepStrictEqual(frag003.keywords, []);
  });
});
