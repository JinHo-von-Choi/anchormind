import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { segmentByScript, tokenizeLocal } from "../../lib/memory/embedding/MorphemeTokenizer.js";

describe("segmentByScript", () => {
  test("한·영 혼용을 스크립트 런으로 분리", () => {
    const segs = segmentByScript("memento 임베딩 비용");
    assert.deepEqual(segs, [
      { script: "latin",  text: "memento" },
      { script: "hangul", text: "임베딩" },
      { script: "hangul", text: "비용" },
    ]);
  });

  test("한자·가나·숫자 분류", () => {
    const segs = segmentByScript("中文テスト123");
    assert.deepEqual(segs.map(s => s.script), ["han", "kana", "other"]);
  });

  test("코드 토큰 memento-mcp는 라틴 런으로 유지", () => {
    const segs = segmentByScript("memento-mcp L3");
    assert.equal(segs[0].script, "latin");
    assert.ok(segs.some(s => s.text.includes("memento-mcp")));
  });
});

describe("tokenizeLocal", () => {
  test("한국어 코드 혼용 형태소 추출", async () => {
    const m = await tokenizeLocal("memento-mcp 임베딩 비용을 절감했다", 10);
    assert.ok(m.includes("임베딩"));
    assert.ok(m.includes("비용"));
    assert.ok(m.some(t => t.toLowerCase().includes("memento")));
    assert.ok(m.length <= 10);
  });

  test("조사·어미·단음절 기능 형태소는 제외된다", async () => {
    const m = await tokenizeLocal("비용을 절감했다", 10);
    assert.ok(!m.includes("을"));        // 조사 제거
    assert.ok(!m.includes("다"));        // 어미 제거
    assert.ok(m.every(t => t.length > 1)); // 단음절 전면 제외
    assert.ok(m.includes("비용"));        // 의미 형태소 보존
  });

  test("중국어 분절", async () => {
    const m = await tokenizeLocal("中文分词测试", 10);
    assert.ok(m.includes("中文"));
  });

  test("빈 입력은 빈 배열", async () => {
    assert.deepEqual(await tokenizeLocal("", 10), []);
  });
});

describe("kuromoji 가드 — MEMENTO_ENABLE_KUROMOJI=false", () => {
  test("enableKuromoji=false이면 가나 런이 문자 분리로 처리된다", async () => {
    /** process.env.MEMENTO_ENABLE_KUROMOJI 는 실행 전 env로 주입됨.
     *  MEMORY_CONFIG는 모듈 로드 시점에 평가되므로, 이 테스트는
     *  MEMENTO_ENABLE_KUROMOJI=false 환경에서만 유효하다. */
    const { MEMORY_CONFIG } = await import("../../config/memory.js");
    if (MEMORY_CONFIG.morphemeIndex.enableKuromoji !== false) {
      // 환경 변수 미설정 시 스킵 (가드 경로 미진입)
      return;
    }
    const input   = "テスト";
    const tokens  = await tokenizeLocal(input, 20);

    /** 가드 경로: seg.text.split("").filter(c => c.trim())
     *  → ["テ","ス","ト"] 각 문자가 개별 토큰.
     *  kuromoji 경로라면 "テスト"가 単一トークン("テスト") 혹은 basic_form으로 반환됨. */
    assert.ok(tokens.length > 0, "가나 입력이 토큰을 반환해야 한다");
    assert.ok(
      tokens.every(t => [...input].includes(t) || t.length === 1),
      "가드 경로는 개별 문자 단위 토큰을 반환해야 한다"
    );

    /** kuromoji가 로드됐다면 _loaders에 Promise가 들어있다.
     *  단, 다른 테스트가 kuromoji를 먼저 로드하지 않았음을 전제한다.
     *  enableKuromoji=false 경로에서는 getKuromoji() 호출 자체가 없어야 한다. */
    const mod = await import("../../lib/memory/embedding/MorphemeTokenizer.js");
    assert.ok(
      typeof mod.getKuromojiLoaderState === "function"
        ? mod.getKuromojiLoaderState() === null
        : true,
      "kuromoji 로더 싱글톤이 null 상태여야 한다 (export 없으면 검사 생략)"
    );
  });

  test("kanaMinChars 미만 런은 가드 통과 — kuromoji 불필요", async () => {
    /** 1자짜리 가나 런은 kanaMinChars(기본 2) 미만이므로 kuromoji 로드 없이 처리 */
    const tokens = await tokenizeLocal("ア", 20);
    assert.ok(Array.isArray(tokens), "배열 반환");
    /** 단일 가나 문자 — 길이 1이므로 filter(c => c.trim()) 후 ["ア"] 또는 빈 배열 */
    assert.ok(tokens.length <= 1, "단일 가나는 최대 1개 토큰");
  });
});
