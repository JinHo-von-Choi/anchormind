/**
 * 리랭커 게이팅 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 인프로세스 리랭커는 명시 활성일 때만 동작해야 한다. 기본 모델이 영어 전용
 * 교차 인코더라 한국어 질의에서 상류 벡터 순위를 파괴하기 때문이다. 절제
 * 실험에서 이 리랭커를 끄면 격리 모드 Recall@5가 67%에서 85%로, 코퍼스 모드
 * Recall@1이 74%에서 85%로 올랐다.
 *
 * 외부 리랭커 서비스는 이 스위치와 무관하게 동작한다. 운영자가 주소를 지정한
 * 것 자체가 명시 의사이며, 그쪽은 모델 선택이 자유롭다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readFileSync }   from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

const HERE   = path.dirname(fileURLToPath(import.meta.url));
const ROOT   = path.resolve(HERE, "..", "..");
const CONFIG = readFileSync(path.join(ROOT, "lib", "config.js"), "utf8");
const SRC    = readFileSync(path.join(ROOT, "lib", "memory", "read", "Reranker.js"), "utf8");

describe("리랭커 게이팅", () => {
  test("인프로세스 활성 스위치가 존재한다", () => {
    assert.match(CONFIG, /RERANKER_ENABLED\s*=\s*process\.env\.MEMENTO_RERANKER_ENABLED === "true"/);
  });

  test("환경 변수를 지정하지 않으면 비활성이다", async () => {
    delete process.env.MEMENTO_RERANKER_ENABLED;
    const { RERANKER_ENABLED } = await import("../../lib/config.js?default-check");
    assert.equal(RERANKER_ENABLED, false);
  });

  test("명시 활성만 참으로 해석한다", async () => {
    for (const [value, expected] of [["true", true], ["false", false], ["1", false], ["yes", false]]) {
      process.env.MEMENTO_RERANKER_ENABLED = value;
      const mod = await import(`../../lib/config.js?v=${encodeURIComponent(value)}`);
      assert.equal(mod.RERANKER_ENABLED, expected, `MEMENTO_RERANKER_ENABLED=${value}`);
    }
    delete process.env.MEMENTO_RERANKER_ENABLED;
  });

  test("가용성 판정이 활성 스위치를 본다", () => {
    assert.match(SRC, /if \(!RERANKER_ENABLED\) return false;/);
  });

  test("외부 모드는 스위치보다 먼저 판정된다", () => {
    const fn = SRC.slice(SRC.indexOf("export function isRerankerAvailable"));
    const externalIdx = fn.indexOf('_mode === "external"');
    const switchIdx   = fn.indexOf("!RERANKER_ENABLED");
    assert.ok(externalIdx >= 0 && switchIdx >= 0, "두 판정이 모두 있어야 한다");
    assert.ok(externalIdx < switchIdx, "외부 리랭커가 스위치에 막히면 안 된다");
  });

  test("기본 모델이 영어 전용임을 설정이 밝힌다", () => {
    assert.match(CONFIG, /영어 (MS MARCO )?전용/);
  });
});
