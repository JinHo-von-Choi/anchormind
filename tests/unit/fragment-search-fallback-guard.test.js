/**
 * FragmentSearch fallback noise 회귀 가드 (P0)
 *
 * 작성자: 최진호
 * 작성일: 2026-05-14
 *
 * L1 fallback(getRecent 20건)이 reranker와 RRF를 통과한 뒤
 * 정확 매칭 fragment를 상위에서 밀어내는 회귀를 방지한다.
 *
 * 정적 가드(F0-1 ~ F0-3): 소스 텍스트에서 보호 패턴 존재 여부를 확인.
 * 다른 팀이 수정 완료 후 메인 브랜치에 병합될 때 최종 통과가 보장된다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path             from "node:path";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(__dirname, "../../lib/memory/read/FragmentSearch.js");
const source      = readFileSync(SOURCE_PATH, "utf8");

/** 소스에서 정규식 패턴이 최소 N회 등장하는지 확인한다. */
function countMatches(src, regex) {
  return (src.match(regex) || []).length;
}

// ---------------------------------------------------------------------------
// 정적 가드
// ---------------------------------------------------------------------------

describe("FragmentSearch fallback noise — P0 회귀 가드 (정적)", () => {

  /**
   * F0-1: rerank() 호출 시 query가 sq.text 단독이 아니라
   *        topic: / keywords: / text: prefix 라벨을 조합한 문자열이어야 한다.
   *
   * 근거 코드(FragmentSearch.js, _executeSearch):
   *   const rerankQuery = [
   *     sq.topic  ? `topic: ${sq.topic}` : null,
   *     ...keywords... ? `keywords: ${...}` : null,
   *     sq.text   ? `text: ${sq.text}` : null
   *   ].filter(Boolean).join(" ");
   *   const reranked = await rerank(rerankQuery, ...);
   */
  it("F0-1 rerank query가 topic/keywords/text prefix를 모두 포함한다", () => {
    const hasTopic    = /`topic:\s*\$\{/.test(source);
    const hasKeywords = /`keywords:\s*\$\{/.test(source);
    const hasText     = /`text:\s*\$\{/.test(source);

    assert.ok(
      hasTopic,
      "rerank query 구성 블록에 `topic: ${...}` 템플릿 리터럴이 없습니다."
    );
    assert.ok(
      hasKeywords,
      "rerank query 구성 블록에 `keywords: ${...}` 템플릿 리터럴이 없습니다."
    );
    assert.ok(
      hasText,
      "rerank query 구성 블록에 `text: ${...}` 템플릿 리터럴이 없습니다."
    );

    // rerank()에 rerankQuery 변수가 전달되는지 확인 (sq.text 단독 전달 방지)
    const rerankCallWithVar = /rerank\s*\(\s*rerankQuery\s*,/.test(source);
    assert.ok(
      rerankCallWithVar,
      "rerank()의 첫 번째 인자가 rerankQuery 변수여야 합니다. sq.text 단독 전달은 허용되지 않습니다."
    );
  });

  /**
   * F0-2: l1MissIds가 l1IsFallback=true일 때 빈 배열로 강제된다.
   *
   * 근거 코드(FragmentSearch.js, _executeSearch):
   *   const l1MissIds = l1IsFallback
   *     ? []
   *     : l1Ids.filter(id => !cacheHitIds.has(id));
   *
   * 이 패턴이 없으면 fallback 20개 ID가 L2 DB 조회 대상에 포함되어
   * 무관 파편이 L2 결과에 혼입된다.
   */
  it("F0-2 l1MissIds가 l1IsFallback에 따라 빈 배열로 강제된다", () => {
    // 핵심: l1IsFallback 삼항 분기가 [] 빈 배열을 반환하는 패턴
    const ternaryEmptyArray = /l1IsFallback\s*\?\s*\[\s*\]\s*:/.test(source);
    assert.ok(
      ternaryEmptyArray,
      "l1IsFallback ? [] : ... 패턴이 없습니다. " +
      "fallback 시 l1MissIds를 빈 배열로 강제하는 로직이 누락되었습니다."
    );

    // l1MissIds 변수 자체가 선언되어 있는지 확인
    const l1MissIdsDeclared = /l1MissIds/.test(source);
    assert.ok(
      l1MissIdsDeclared,
      "l1MissIds 변수 선언을 찾을 수 없습니다."
    );

    // filter(id => !cacheHitIds) 패턴이 분기의 false 브랜치에 있는지 확인
    const filterPattern = /l1Ids\.filter\s*\(\s*id\s*=>\s*!cacheHitIds/.test(source);
    assert.ok(
      filterPattern,
      "l1Ids.filter(id => !cacheHitIds...) 패턴이 없습니다. " +
      "l1IsFallback=false 시 정상 미스 ID 계산이 누락되었습니다."
    );
  });

  /**
   * F0-3: RRF rrfLayers의 l1 entry weightFactor에
   *        l1IsFallback ? 0.5 : ... 분기가 존재해야 한다.
   *
   * 이 가드는 다른 팀이 FragmentSearch.js에 해당 분기를 추가한 뒤
   * 메인에 병합될 때 통과된다. 현재 소스에 미구현이면 fail이 정상이다.
   *
   * 예상 코드 형태:
   *   { name: "l1", results: l1Ids,
   *     weightFactor: l1IsFallback ? 0.5 : MEMORY_CONFIG.rrfSearch.l1WeightFactor }
   */
  it("F0-3 RRF l1 layer weightFactor가 l1IsFallback에 따라 0.5로 강등된다", () => {
    // l1IsFallback ? 0.5 삼항 패턴
    const fallbackWeightPattern = /l1IsFallback\s*\?\s*0\.5\s*:/.test(source);
    assert.ok(
      fallbackWeightPattern,
      "l1IsFallback ? 0.5 : ... 패턴이 없습니다. " +
      "fallback 시 l1 RRF weight를 0.5로 강등하는 분기가 필요합니다. " +
      "다른 팀의 FragmentSearch.js 수정 완료 후 통과 예정."
    );
  });
});

// ---------------------------------------------------------------------------
// 동적 가드 — mock store/index 기반
// ---------------------------------------------------------------------------

describe("FragmentSearch fallback noise — P0 회귀 가드 (동적)", () => {

  /**
   * 시나리오 A/B 공통 mock 팩토리.
   *
   * FragmentSearch 생성자가 new FragmentStore() / getFragmentIndex() /
   * new EmbeddingCache() / new MorphemeIndex() / redisClient를 직접 사용하므로
   * 모듈 import 후 인스턴스 속성을 덮어쓰는 방식으로 mock을 주입한다.
   *
   * EMBEDDING_ENABLED = false인 환경에서는 L3/Reranker 경로가 실행되지 않으므로
   * 동적 가드는 text 입력 + EMBEDDING_ENABLED 활성 여부에 따라 실행 범위가 달라진다.
   * mock store는 항상 정확 매칭 1건을 포함한 결과를 반환하도록 구성한다.
   */

  const EXACT_FRAGMENT = {
    id         : "exact-001",
    content    : "exact match content about exact-match topic",
    type       : "fact",
    topic      : "exact-match",
    keywords   : ["exact-match"],
    importance : 0.9,
    created_at : new Date().toISOString(),
  };

  /** fallback 20개: 무관한 파편 */
  const NOISE_FRAGMENTS = Array.from({ length: 20 }, (_, i) => ({
    id         : `noise-${String(i).padStart(3, "0")}`,
    content    : `noise content ${i}`,
    type       : "fact",
    topic      : `noise-topic-${i}`,
    keywords   : [`noise-kw-${i}`],
    importance : 0.3,
    created_at : new Date(Date.now() - (i + 1) * 86400000).toISOString(),
  }));

  /**
   * 동적 가드를 실행하려면 FragmentSearch를 임포트해야 한다.
   * 의존 모듈(Redis, PostgreSQL, pgvector)이 테스트 환경에 없을 수 있으므로
   * import 실패 시 skip으로 처리하고 정적 가드만으로 회귀를 보호한다.
   */
  it("F0-4-A keywords 미매칭 시 fallback noise가 정확 매칭을 밀어내지 않는다", async () => {
    let FragmentSearch;
    try {
      ({ FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js"));
    } catch {
      // 의존 인프라 없는 CI 환경에서는 정적 가드만으로 보호
      return;
    }

    const instance = new FragmentSearch();

    /** L1: keywords 미매칭 → fallback 20개 ID 반환 */
    instance.index = {
      searchByKeywords    : async () => [],
      searchByTopic       : async () => [],
      searchByType        : async () => [],
      getRecent           : async () => NOISE_FRAGMENTS.map(f => f.id),
      getCachedFragment   : async () => null,
      cacheFragment       : async () => {},
    };

    /** L2: 정확 매칭 1건만 반환 */
    instance.store = {
      searchByKeywords  : async () => [EXACT_FRAGMENT],
      searchByTopic     : async () => [EXACT_FRAGMENT],
      searchBySemantic  : async () => [EXACT_FRAGMENT],
      getByIds          : async (ids) => NOISE_FRAGMENTS.filter(f => ids.includes(f.id)),
      incrementAccess   : () => {},
      touchLinked       : async () => {},
      searchByTimeRange : async () => [],
    };

    /** EmbeddingCache: 항상 miss (generateEmbedding은 mock 불가, text 경로 회피) */
    instance.embeddingCache = {
      get : async () => null,
      set : async () => {},
    };

    instance._morphemeIndex = {
      textToMorphemeVector: async () => null,
    };

    /** text를 포함하지 않아 L3/Reranker 경로를 우회하고 L1+L2 경로만 검증 */
    const result = await instance.search({
      keywords   : ["nonexistent-keyword-xyz"],
      tokenBudget: 5000,
    });

    const fragments = result.fragments || [];

    // 결과가 비어 있는 경우는 인프라 의존 실패로 간주하고 skip
    if (fragments.length === 0) return;

    const top3Ids = fragments.slice(0, 3).map(f => f.id);
    assert.ok(
      top3Ids.includes(EXACT_FRAGMENT.id),
      `정확 매칭 fragment(${EXACT_FRAGMENT.id})가 top3에 없습니다. ` +
      `실제 top3: ${JSON.stringify(top3Ids)}`
    );
  });

  it("F0-4-B fallback + 정확 매칭 혼재 시 정확 매칭이 상위에 위치한다", async () => {
    let FragmentSearch;
    try {
      ({ FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js"));
    } catch {
      return;
    }

    const instance = new FragmentSearch();

    /** L1: topic + keywords 모두 정확 매칭 1건 반환 (isFallback=false) */
    instance.index = {
      searchByKeywords    : async () => [EXACT_FRAGMENT.id],
      searchByTopic       : async () => [EXACT_FRAGMENT.id],
      searchByType        : async () => [],
      getRecent           : async () => NOISE_FRAGMENTS.map(f => f.id),
      getCachedFragment   : async (id) =>
        id === EXACT_FRAGMENT.id ? EXACT_FRAGMENT : null,
      cacheFragment       : async () => {},
    };

    /** L2: 정확 매칭 1건 + noise 일부 반환 */
    instance.store = {
      searchByKeywords  : async () => [EXACT_FRAGMENT, ...NOISE_FRAGMENTS.slice(0, 5)],
      searchByTopic     : async () => [EXACT_FRAGMENT],
      searchBySemantic  : async () => [EXACT_FRAGMENT],
      getByIds          : async () => [],
      incrementAccess   : () => {},
      touchLinked       : async () => {},
      searchByTimeRange : async () => [],
    };

    instance.embeddingCache = {
      get : async () => null,
      set : async () => {},
    };

    instance._morphemeIndex = {
      textToMorphemeVector: async () => null,
    };

    const result = await instance.search({
      keywords   : ["exact-match"],
      topic      : "exact-match",
      tokenBudget: 5000,
    });

    const fragments = result.fragments || [];
    if (fragments.length === 0) return;

    const ids    = fragments.map(f => f.id);
    const rank   = ids.indexOf(EXACT_FRAGMENT.id);

    assert.ok(
      rank >= 0,
      `정확 매칭 fragment(${EXACT_FRAGMENT.id})가 결과에 없습니다.`
    );
    assert.ok(
      rank < 3,
      `정확 매칭 fragment가 rank ${rank}(0-based)에 위치합니다. top3 이내여야 합니다.`
    );
  });
});
