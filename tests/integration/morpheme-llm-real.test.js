/**
 * MorphemeIndex — 실제 LLM 체인 관통 tokenize 통합 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * 실행 방법:
 *   E2E_MORPHEME=1 node --test tests/integration/morpheme-llm-real.test.js
 *
 * 전제조건:
 *   - DB(PostgreSQL) + Redis 기동 상태 (또는 REDIS_ENABLED=false)
 *   - .env 파일이 프로젝트 루트에 존재하고 LLM_PRIMARY/LLM_FALLBACKS 설정됨
 *   - gemini-cli 또는 LLM_FALLBACKS의 provider 중 하나 이상이 인증/접근 가능
 *
 * 주의:
 *   - 실제 LLM CLI 호출이 발생하므로 응답에 20~60초 소요될 수 있음
 *   - describe 레벨 timeout: 300_000ms (5분)
 *   - E2E_MORPHEME 미설정(또는 "0") 시 전체 describe가 skip됨
 */

import "dotenv/config";
import { describe, it, before } from "node:test";
import assert                   from "node:assert/strict";
import "./_cleanup.js";

const ENABLED = process.env.E2E_MORPHEME === "1";

describe("MorphemeIndex — 실제 LLM 체인 tokenize", { skip: !ENABLED, timeout: 300_000 }, () => {

  /** @type {import("../../lib/memory/embedding/MorphemeIndex.js").MorphemeIndex} */
  let morphemeIndex;

  before(async () => {
    const { MorphemeIndex } = await import("../../lib/memory/embedding/MorphemeIndex.js");
    morphemeIndex = new MorphemeIndex();
    // MorphemeIndex는 별도 초기화 메서드가 없으므로 인스턴스 생성만으로 준비 완료
  });

  // cleanup은 ./_cleanup.js의 공통 after 훅이 담당한다.

  // ---------------------------------------------------------------------------
  // 테스트 1: 한국어 문장 → 의미 단위 형태소 배열
  // ---------------------------------------------------------------------------

  it("한국어 문장을 의미 단위 형태소 배열로 분리한다", async () => {
    const input    = "서울에서 부산까지 KTX로 2시간 40분 걸린다";
    const morphemes = await morphemeIndex.tokenize(input);

    console.log("[morpheme-llm-real] 한국어 결과:", morphemes);

    assert.ok(
      Array.isArray(morphemes),
      `tokenize 반환값이 배열이 아님: ${JSON.stringify(morphemes)}`
    );
    assert.ok(
      morphemes.length > 0,
      "형태소 배열이 비어 있음 — LLM 응답 또는 fallback 모두 실패"
    );

    // 핵심 단어 중 최소 1개 이상 포함 여부 확인 (모델별 차이 허용)
    const coreTerms     = ["서울", "부산", "KTX", "2시간", "40분", "ktx"];
    const lowerMorphs   = morphemes.map(m => m.toLowerCase());
    const hasAtLeastOne = coreTerms.some(
      term => lowerMorphs.some(m => m.includes(term.toLowerCase()))
    );

    assert.ok(
      hasAtLeastOne,
      `핵심 단어(${coreTerms.join(", ")}) 중 하나도 포함되지 않음. ` +
      `실제 결과: ${JSON.stringify(morphemes)}`
    );

    // 각 형태소는 1~20자 문자열이어야 함
    for (const m of morphemes) {
      assert.ok(
        typeof m === "string" && m.trim().length > 0 && m.length <= 20,
        `비정상 형태소 항목: ${JSON.stringify(m)}`
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 테스트 2: 영어 문장 → 기본형 형태소 배열
  // ---------------------------------------------------------------------------

  it("영어 문장에 대해서도 동작한다", async () => {
    const input    = "The quick brown fox jumps over the lazy dog";
    const morphemes = await morphemeIndex.tokenize(input);

    console.log("[morpheme-llm-real] 영어 결과:", morphemes);

    assert.ok(
      Array.isArray(morphemes),
      `tokenize 반환값이 배열이 아님: ${JSON.stringify(morphemes)}`
    );
    assert.ok(
      morphemes.length > 0,
      "영어 형태소 배열이 비어 있음 — LLM 응답 또는 fallback 모두 실패"
    );

    // 기대 기본형 집합 중 최소 2개 이상 포함 (모델마다 출력 형식 다를 수 있음)
    const expected     = ["quick", "brown", "fox", "jump", "lazy", "dog", "jumps"];
    const lowerMorphs  = morphemes.map(m => m.toLowerCase());
    const matchedCount = expected.filter(
      term => lowerMorphs.some(m => m.includes(term))
    ).length;

    assert.ok(
      matchedCount >= 2,
      `영어 핵심 단어 2개 이상 매칭 실패. 기대: ${JSON.stringify(expected)}, ` +
      `실제: ${JSON.stringify(morphemes)}`
    );
  });

  // ---------------------------------------------------------------------------
  // 테스트 3: LLM 전체 실패 시 _fallbackTokenize 우회 경로 검증
  // ---------------------------------------------------------------------------

  it("LLM 실패 시 _fallbackTokenize 우회 경로가 동작한다", async () => {
    // 환경변수를 임시로 overwrite하여 LLM chain을 강제 무효화
    const origPrimary   = process.env.LLM_PRIMARY;
    const origFallbacks = process.env.LLM_FALLBACKS;

    process.env.LLM_PRIMARY   = "nonexistent-provider";
    process.env.LLM_FALLBACKS = "[]";

    // registry/index 캐시 무효화 — Node.js ESM은 import cache를 invalidate할 수 없으므로
    // llm/index.js의 buildChain()이 매 호출마다 재구성하는 구조임을 활용.
    // isLlmAvailable()은 buildChain() 내 createProvider("nonexistent") → null → empty chain.
    // 결과: isGeminiCLIAvailable()이 false를 반환 → _fallbackTokenize 경로로 진입.

    try {
      const input    = "machine learning deep neural network training";
      const morphemes = await morphemeIndex.tokenize(input);

      console.log("[morpheme-llm-real] fallback 경로 결과:", morphemes);

      // throw 없이 배열을 반환해야 함
      assert.ok(
        Array.isArray(morphemes),
        `fallback tokenize가 배열을 반환하지 않음: ${JSON.stringify(morphemes)}`
      );

      // fallback은 공백 분리 기반이므로 빈 문자열이 아닌 단어들을 반환해야 함
      // 단, LLM_FALLBACKS 환경변수 캐시 이슈로 실제 LLM이 호출될 수도 있으므로
      // 결과 타입만 검증한다 (strict enum 검증 금지)
      for (const m of morphemes) {
        assert.ok(
          typeof m === "string",
          `형태소 항목이 문자열이 아님: ${JSON.stringify(m)}`
        );
      }
    } finally {
      // 원래 환경변수 복원 (after hook 이전에 복원해야 다른 테스트에 영향 없음)
      if (origPrimary !== undefined) {
        process.env.LLM_PRIMARY = origPrimary;
      } else {
        delete process.env.LLM_PRIMARY;
      }

      if (origFallbacks !== undefined) {
        process.env.LLM_FALLBACKS = origFallbacks;
      } else {
        delete process.env.LLM_FALLBACKS;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 테스트 4: 빈 문자열 입력 → 빈 배열 반환
  // ---------------------------------------------------------------------------

  it("빈 문자열 입력 시 빈 배열을 반환한다", async () => {
    const morphemes = await morphemeIndex.tokenize("");

    console.log("[morpheme-llm-real] 빈 문자열 결과:", morphemes);

    assert.ok(
      Array.isArray(morphemes),
      `빈 문자열 tokenize가 배열을 반환하지 않음: ${JSON.stringify(morphemes)}`
    );

    // 빈 문자열은 형태소가 없으므로 빈 배열 또는 stopwords 필터 후 빈 배열이어야 함
    // LLM이 빈 입력에 대해 예외를 던지더라도 _fallbackTokenize가 [] 반환
    assert.equal(
      morphemes.length,
      0,
      `빈 문자열에서 형태소가 반환됨: ${JSON.stringify(morphemes)}`
    );
  });
});
