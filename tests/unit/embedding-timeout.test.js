/**
 * 임베딩 타임아웃 + 세마포어 정적/동작 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../../lib/tools/embedding.js", import.meta.url)),
  "utf8"
);

describe("embedding client hardening", () => {
  it("OpenAI 클라이언트에 maxRetries를 주입한다(클라이언트 timeout 옵션은 두지 않는다)", () => {
    assert.match(SRC, /maxRetries:\s*EMBEDDING_MAX_RETRIES/);
    /** 타임아웃 중첩 방지: 클라이언트 옵션에 timeout: EMBEDDING_TIMEOUT_MS를 넣지 않는다 */
    assert.doesNotMatch(SRC, /timeout:\s*EMBEDDING_TIMEOUT_MS/);
  });

  it("호출부에서 per-call AbortSignal.timeout(단일 데드라인)을 전달한다", () => {
    assert.match(SRC, /signal:\s*AbortSignal\.timeout\(EMBEDDING_TIMEOUT_MS\)/);
  });

  it("프로세스 전역 임베딩 세마포어를 acquire/release 한다", () => {
    assert.match(SRC, /getSemaphore\(\s*["'`]embedding["'`]/);
    assert.match(SRC, /\.acquire\(/);
    assert.match(SRC, /\.release\(\)/);
  });

  it("config가 안전한 기본값을 노출한다", async () => {
    const cfg = await import("../../lib/config.js");
    assert.equal(typeof cfg.EMBEDDING_TIMEOUT_MS, "number");
    assert.ok(cfg.EMBEDDING_TIMEOUT_MS > 0 && cfg.EMBEDDING_TIMEOUT_MS <= 30000);
    /** 공개 기본값: 타임아웃 중첩 무력화 방지를 위해 재시도 0 */
    assert.equal(cfg.EMBEDDING_MAX_RETRIES, 0);
    assert.ok(cfg.EMBEDDING_CONCURRENCY >= 4 && cfg.EMBEDDING_CONCURRENCY <= 8);
  });
});
