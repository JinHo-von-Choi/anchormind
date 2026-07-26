/**
 * batch_remember fragments 문자열 입력 진단 메시지 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-07-26
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BatchRememberProcessor } from "../../lib/memory/write/BatchRememberProcessor.js";

describe("BatchRememberProcessor 문자열 fragments 진단", () => {
  const proc = new BatchRememberProcessor({ store: null, index: null, factory: null });

  it("fragments가 JSON 문자열이면 문자열화 원인을 명시한 오류를 던진다", async () => {
    await assert.rejects(
      proc.process({ fragments: '[{"content":"x","type":"fact"}]' }),
      /JSON-encoded string/
    );
  });

  it("fragments 미지정은 기존 메시지를 유지한다", async () => {
    await assert.rejects(
      proc.process({}),
      /fragments array is required and must not be empty/
    );
  });

  it("빈 배열은 기존 메시지를 유지한다", async () => {
    await assert.rejects(
      proc.process({ fragments: [] }),
      /fragments array is required and must not be empty/
    );
  });
});
