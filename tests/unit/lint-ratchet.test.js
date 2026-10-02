/**
 * lint-ratchet 비교 로직 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import path             from "node:path";
import {
  RATCHET_RULES,
  messageWeight,
  countByRule,
  compareCounts,
  serializeBaseline
} from "../../scripts/lint-ratchet.js";

describe("messageWeight", () => {
  it("복잡도, 함수 줄 수, 파일 줄 수, 깊이는 메시지의 실측값을 쓴다", () => {
    assert.equal(messageWeight({ ruleId: "complexity",             message: "Function 'recall' has a complexity of 63. Maximum allowed is 20." }), 63);
    assert.equal(messageWeight({ ruleId: "max-lines-per-function", message: "Function 'f' has too many lines (150). Maximum allowed is 120." }), 150);
    assert.equal(messageWeight({ ruleId: "max-lines",              message: "File has too many lines (900). Maximum allowed is 800." }), 900);
    assert.equal(messageWeight({ ruleId: "max-depth",              message: "Blocks are nested too deeply (6). Maximum allowed is 5." }), 6);
  });

  it("크기가 없는 규칙은 1을 쓴다", () => {
    assert.equal(messageWeight({ ruleId: "local/no-silent-catch",      message: "catch 절이 오류를 기록하지도 전파하지도 않는다." }), 1);
    assert.equal(messageWeight({ ruleId: "no-restricted-properties",   message: "'process.env' is restricted from being used (3)." }), 1);
  });
});

describe("countByRule", () => {
  it("파일별로 값을 합산하고 대상 밖 규칙은 세지 않는다", () => {
    const root    = path.resolve("/repo");
    const results = [{
      filePath: path.join(root, "lib", "a.js"),
      messages: [
        { ruleId: "complexity",            message: "Function 'x' has a complexity of 21. Maximum allowed is 20." },
        { ruleId: "complexity",            message: "Function 'y' has a complexity of 30. Maximum allowed is 20." },
        { ruleId: "local/no-silent-catch", message: "m" },
        { ruleId: "no-unused-vars",        message: "m" }
      ]
    }];
    const counts = countByRule(results, root);
    assert.deepEqual(counts["complexity"],            { "lib/a.js": 51 });
    assert.deepEqual(counts["local/no-silent-catch"], { "lib/a.js": 1 });
    assert.deepEqual(Object.keys(counts), RATCHET_RULES);
  });
});

describe("compareCounts", () => {
  const baseline = { "complexity": { "lib/a.js": 50, "lib/b.js": 20 } };

  it("같은 값은 통과한다", () => {
    const { increased, decreased } = compareCounts({ "complexity": { "lib/a.js": 50, "lib/b.js": 20 } }, baseline);
    assert.deepEqual(increased, []);
    assert.deepEqual(decreased, []);
  });

  it("기존 파일의 값이 늘면 증가로 센다", () => {
    const { increased } = compareCounts({ "complexity": { "lib/a.js": 51, "lib/b.js": 20 } }, baseline);
    assert.deepEqual(increased, ["complexity lib/a.js: 50 -> 51"]);
  });

  it("기준선에 없던 파일의 값은 0에서의 증가로 센다", () => {
    const { increased } = compareCounts({ "complexity": { "lib/a.js": 50, "lib/b.js": 20, "lib/c.js": 1 } }, baseline);
    assert.deepEqual(increased, ["complexity lib/c.js: 0 -> 1"]);
  });

  it("값이 줄면 감소로만 센다", () => {
    const { increased, decreased } = compareCounts({ "complexity": { "lib/a.js": 40 } }, baseline);
    assert.deepEqual(increased, []);
    assert.deepEqual(decreased, ["complexity lib/a.js: 50 -> 40", "complexity lib/b.js: 20 -> 0"]);
  });
});

describe("serializeBaseline", () => {
  it("입력 순서와 무관하게 같은 문자열을 만든다", () => {
    const a = serializeBaseline({ "complexity": { "lib/b.js": 2, "lib/a.js": 1 } });
    const b = serializeBaseline({ "complexity": { "lib/a.js": 1, "lib/b.js": 2 } });
    assert.equal(a, b);
    assert.ok(a.endsWith("\n"));
  });

  it("0인 항목은 쓰지 않고 모든 규칙 키를 둔다", () => {
    const parsed = JSON.parse(serializeBaseline({ "complexity": { "lib/a.js": 0, "lib/b.js": 3 } }));
    assert.deepEqual(parsed["complexity"], { "lib/b.js": 3 });
    assert.deepEqual(Object.keys(parsed), RATCHET_RULES);
  });
});
