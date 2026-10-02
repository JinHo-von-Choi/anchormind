/**
 * lint-ratchet 비교 로직 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import fs               from "node:fs";
import os               from "node:os";
import path             from "node:path";
import {
  RATCHET_RULES,
  messageWeight,
  countByRule,
  compareCounts,
  serializeBaseline,
  parseArgs,
  updateBaseline
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

describe("parseArgs", () => {
  it("인자가 없으면 검사 모드다", () => {
    assert.deepEqual(parseArgs([]), { mode: "--check", allowIncrease: false, unknown: [] });
  });

  it("옵션은 순서와 무관하게 해석된다", () => {
    assert.deepEqual(parseArgs(["--update", "--allow-increase"]), { mode: "--update", allowIncrease: true, unknown: [] });
    assert.deepEqual(parseArgs(["--allow-increase", "--update"]), { mode: "--update", allowIncrease: true, unknown: [] });
    assert.deepEqual(parseArgs(["--init"]),                       { mode: "--init",   allowIncrease: false, unknown: [] });
  });

  it("모르는 옵션과 중복 모드는 unknown으로 모은다", () => {
    assert.deepEqual(parseArgs(["--bogus"]).unknown, ["--bogus"]);
    assert.deepEqual(parseArgs(["--init", "--update"]).unknown, ["--init", "--update"]);
  });
});

describe("updateBaseline", () => {
  const withBaseline = (baseline, fn) => {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "lint-ratchet-"));
    const file = path.join(dir, "baseline.json");
    fs.writeFileSync(file, serializeBaseline(baseline));
    try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const base = { "complexity": { "lib/a.js": 50, "lib/b.js": 20 } };

  it("값이 늘었으면 종료 코드 1을 돌려주고 파일을 건드리지 않는다", () => {
    withBaseline(base, (file) => {
      const before = fs.readFileSync(file, "utf8");
      const res    = updateBaseline({ current: { "complexity": { "lib/a.js": 51, "lib/b.js": 20 } }, baselinePath: file, allowIncrease: false });
      assert.equal(res.code, 1);
      assert.deepEqual(res.out, []);
      assert.ok(res.err.some(line => line.includes("complexity lib/a.js: 50 -> 51")));
      assert.ok(res.err.some(line => line.includes("--allow-increase")));
      assert.equal(fs.readFileSync(file, "utf8"), before);
    });
  });

  it("기준선에 없던 항목이 생겨도 거부한다", () => {
    withBaseline(base, (file) => {
      const before = fs.readFileSync(file, "utf8");
      const res    = updateBaseline({ current: { "local/no-silent-catch": { "lib/c.js": 1 }, "complexity": base.complexity }, baselinePath: file, allowIncrease: false });
      assert.equal(res.code, 1);
      assert.equal(fs.readFileSync(file, "utf8"), before);
    });
  });

  it("--allow-increase가 있으면 더 큰 기준선을 쓴다", () => {
    withBaseline(base, (file) => {
      const current = { "complexity": { "lib/a.js": 80, "lib/b.js": 20 } };
      const res     = updateBaseline({ current, baselinePath: file, allowIncrease: true });
      assert.equal(res.code, 0);
      assert.equal(fs.readFileSync(file, "utf8"), serializeBaseline(current));
    });
  });

  it("값이 줄기만 했으면 옵션 없이 낮춘 기준선을 기록한다", () => {
    withBaseline(base, (file) => {
      const current = { "complexity": { "lib/a.js": 40 } };
      const res     = updateBaseline({ current, baselinePath: file, allowIncrease: false });
      assert.equal(res.code, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8"))["complexity"], { "lib/a.js": 40 });
    });
  });

  it("두 번째 갱신은 같은 파일을 만든다", () => {
    withBaseline(base, (file) => {
      const current = { "complexity": { "lib/a.js": 40, "lib/b.js": 20 } };
      updateBaseline({ current, baselinePath: file, allowIncrease: false });
      const first = fs.readFileSync(file, "utf8");
      const res   = updateBaseline({ current, baselinePath: file, allowIncrease: false });
      assert.equal(res.code, 0);
      assert.equal(fs.readFileSync(file, "utf8"), first);
    });
  });
});
