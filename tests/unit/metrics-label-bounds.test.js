import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 메트릭 라벨 값의 상한 규칙.
 * 요청이 정하는 문자열(경로, 헤더 값)은 라벨로 쓰지 않고 고정 값 집합만 쓴다.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

describe("메트릭 라벨 값의 상한", () => {
  it("404 요청 지표에 요청 경로를 그대로 쓰지 않는다", () => {
    assert.doesNotMatch(read("server.js"), /recordHttpRequest\(req\.method,\s*url\.pathname,\s*404/);
  });

  it("거부된 프로토콜 버전과 Origin 지표에 헤더 값을 그대로 쓰지 않는다", () => {
    const src = read("lib/handlers/mcp-handler.js");
    assert.doesNotMatch(src, /recordProtocolVersionRejected\(protoHeader\s*\|\|/);
    assert.doesNotMatch(src, /recordOriginRejected\(originVal\)/);
  });
});
