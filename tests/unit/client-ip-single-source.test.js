import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 클라이언트 주소 판정의 단일 진입점 규칙.
 * X-Forwarded-For 를 직접 읽는 곳은 판정 함수(lib/http/helpers.js)와 로그 출력(lib/logger.js)뿐이다.
 */
const ROOT      = path.resolve(import.meta.dirname, "../..");
const ALLOWLIST   = new Set(["lib/http/helpers.js", "lib/logger.js"]);
const HEADER_READ = /headers\[\s*["']x-forwarded-for["']\s*\]/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".js")) out.push(full);
  }
  return out;
}

describe("X-Forwarded-For 직접 참조 경계", () => {
  it("허용 목록 밖의 소스는 헤더를 직접 읽지 않는다", () => {
    const files    = [path.join(ROOT, "server.js"), ...walk(path.join(ROOT, "lib"))];
    const offenders = files
      .map(f => path.relative(ROOT, f))
      .filter(rel => !ALLOWLIST.has(rel))
      .filter(rel => HEADER_READ.test(readFileSync(path.join(ROOT, rel), "utf8")));
    assert.deepEqual(offenders, []);
  });
});
