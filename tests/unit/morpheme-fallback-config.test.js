/**
 * Unit tests: morphemeIndex 설정이 형태소 보조 검색에 실제로 연결되는지 검증.
 *
 * minSimilarity / fallbackThreshold / fallbackLimit 세 키는 설정 파일과
 * validate-memory-config에는 존재하지만 검색 경로에서 소비되지 않고 있었다.
 * 형태소 평균 벡터는 문장 임베딩보다 코사인이 낮아 L3 임계값(0.4)에서 전량 탈락한다.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { MEMORY_CONFIG } = await import("../../config/memory.js");
const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");

const src = FragmentSearch.prototype._searchL3.toString();

describe("morphemeIndex 설정 연결", () => {
  it("형태소 전용 minSimilarity를 참조한다", () => {
    assert.ok(src.includes("morphCfg.minSimilarity"), "morphemeIndex.minSimilarity 미참조");
  });

  it("fallbackLimit을 참조한다", () => {
    assert.ok(src.includes("morphCfg.fallbackLimit"), "fallbackLimit 미참조");
  });

  it("fallbackThreshold를 참조한다", () => {
    assert.ok(src.includes("morphCfg.fallbackThreshold"), "fallbackThreshold 미참조");
  });

  it("형태소 프로브가 L3 임계값을 재사용하지 않는다", () => {
    /** 프로브 호출 블록에 minSimilarity: morphMinSim 형태가 있어야 한다 */
    assert.ok(src.includes("minSimilarity    : morphMinSim") || src.includes("minSimilarity: morphMinSim"),
      "형태소 프로브가 전용 임계값을 사용해야 한다");
  });

  it("설정 기본값이 L3보다 낮게 유지된다", () => {
    const l3    = MEMORY_CONFIG.semanticSearch.minSimilarity;
    const morph = MEMORY_CONFIG.morphemeIndex.minSimilarity;
    assert.ok(morph < l3, `형태소 임계값(${morph})은 L3(${l3})보다 낮아야 한다`);
  });

  it("기본 결과가 충분하면 보조 결과를 채택하지 않는 게이트가 있다", () => {
    assert.ok(src.includes("results.length <= morphThresh"), "fallbackThreshold 게이트 필요");
  });
});
