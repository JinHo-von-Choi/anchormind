/**
 * 교차 출처 응답 헤더 결정 위치 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT  = path.resolve(import.meta.dirname, "../..");
const FILES = [
  "server.js",
  ...readdirSync(path.join(ROOT, "lib"), { recursive: true })
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join("lib", f))
];

describe("교차 출처 응답 헤더 결정 위치", () => {
  it("요청 Origin을 응답 헤더로 쓰는 파일은 _common.js와 admin-routes.js뿐이다", () => {
    const pattern   = /getAllowedOrigin\(|"Access-Control-Allow-Origin",\s*(?:req\.headers\.origin|origin)\b/;
    const offenders = FILES.filter((rel) => pattern.test(readFileSync(path.join(ROOT, rel), "utf8")));
    assert.deepEqual(offenders.sort(), ["lib/admin/admin-routes.js", "lib/handlers/_common.js"]);
  });
});
