/**
 * import 순환 래칫
 *
 * 정적 순환은 없어야 하고, 동적 import를 포함한 순환은 아래 허용 목록의 항목만 존재할 수 있다.
 * 허용 목록의 항목은 순환이 사라지면 목록에서 지워야 한다.
 * 해석되지 않는 상대 경로 import 도 실패로 본다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";
import fs                      from "node:fs";
import os                      from "node:os";
import path                    from "node:path";

import { buildImportGraph, findCycles } from "../../scripts/import-cycles.js";

const ALLOWED_DYNAMIC_CYCLES = [];

const ALLOWED_KEYS = ALLOWED_DYNAMIC_CYCLES.map(c => c.files.join(" | "));

describe("import 순환", () => {
  const { edges, nonLiteral, unresolved } = buildImportGraph();
  const dynamicCycles                     = findCycles(edges, { includeDynamic: true }).map(c => c.join(" | "));
  const tmpRoots                          = [];

  after(() => {
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("허용 목록의 모든 항목에 사유가 있다", () => {
    for (const { reason, files } of ALLOWED_DYNAMIC_CYCLES) {
      assert.ok(typeof reason === "string" && reason.trim().length > 0, `사유 없음: ${files[0]}`);
    }
  });

  it("리터럴이 아닌 동적 import가 없다", () => {
    assert.deepEqual(nonLiteral, []);
  });

  it("해석되지 않는 상대 경로 import가 없다", () => {
    assert.deepEqual(unresolved, []);
  });

  it("정적 순환이 없다", () => {
    assert.deepEqual(findCycles(edges, { includeDynamic: false }).map(c => c.join(" | ")), []);
  });

  it("동적 포함 순환은 허용 목록 안에 있다", () => {
    assert.deepEqual(dynamicCycles.filter(c => !ALLOWED_KEYS.includes(c)), []);
  });

  it("허용 목록의 모든 항목이 실제 순환이다(사라진 순환은 목록에서 지운다)", () => {
    const stale = ALLOWED_KEYS.filter(key => !dynamicCycles.includes(key));
    assert.deepEqual(stale, [], `더 이상 순환이 아니다. ALLOWED_DYNAMIC_CYCLES 에서 지운다: ${stale.join(" ; ")}`);
  });

  it("확장자가 없거나 없는 파일을 가리키는 상대 경로 지정자를 모은다", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-cycles-test-"));
    tmpRoots.push(root);
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "lib", "b.js"), "export const b = 1;\n");
    fs.writeFileSync(path.join(root, "lib", "a.js"), [
      "import { b } from './b.js';",
      "import { missing } from './missing.js';",
      "export const lazy = () => import('./b');",
      "export default b + missing;",
      ""
    ].join("\n"));

    const graph = buildImportGraph(root);

    assert.deepEqual(graph.unresolved, ["lib/a.js -> ./missing.js", "lib/a.js -> ./b"]);
    assert.deepEqual(graph.edges.get("lib/a.js"), [{ to: "lib/b.js", kind: "static" }]);
  });

  it("scripts 와 bin 아래 파일도 그래프에 포함한다", () => {
    assert.ok(edges.has("scripts/import-cycles.js"));
    assert.ok(edges.has("bin/memento.js"));
  });
});
