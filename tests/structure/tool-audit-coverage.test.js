/**
 * 쓰기 도구의 감사 이벤트 범위 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 도구 머리 표(lib/tools/tool-head.js)에서 readOnlyHint가 false인 도구는 모두 감사 범위 표
 * (lib/tools/memory-audit.js의 TOOL_AUDIT_COVERAGE)에 오른다. 항목은 둘 중 하나다.
 *   - actions: 처리기가 남기는 감사 행위 이름. 처리기 본문이 감사 기록 함수(toolAudit.* 또는 recordAudit)를 부르고,
 *     행위 이름 문자열이 처리기 파일이나 lib/tools/memory-audit.js에 있다.
 *   - exempt: 감사 이벤트를 남기지 않는 이유(한 문장 이상).
 * 새 쓰기 도구를 표에 올리지 않으면 실패한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";

import { TOOL_HEAD }           from "../../lib/tools/tool-head.js";
import { TOOL_AUDIT_COVERAGE } from "../../lib/tools/memory-audit.js";
import { isValidAuditAction }  from "../../lib/logging/audit-event.js";

const ROOT       = path.resolve(import.meta.dirname, "..", "..");
const AUDIT_SRC  = readFileSync(path.join(ROOT, "lib", "tools", "memory-audit.js"), "utf8");
const WRITE_TOOLS = Object.values(TOOL_HEAD).filter((t) => t.annotations.readOnlyHint === false).map((t) => t.name);

/**
 * 파일에서 export async function name( 부터 다음 최상위 export 직전까지의 본문을 자른다.
 *
 * @param {string} src
 * @param {string} name
 * @returns {string|null}
 */
function handlerBody(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  if (start < 0) return null;
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? src.length : next);
}

describe("쓰기 도구의 감사 범위", () => {
  it("쓰기 도구가 추출된다", () => {
    assert.ok(WRITE_TOOLS.length >= 8, WRITE_TOOLS.join(","));
  });

  it("모든 쓰기 도구가 범위 표에 있고 표에는 쓰기 도구만 있다", () => {
    assert.deepEqual(WRITE_TOOLS.filter((t) => !TOOL_AUDIT_COVERAGE[t]), []);
    assert.deepEqual(Object.keys(TOOL_AUDIT_COVERAGE).filter((t) => !WRITE_TOOLS.includes(t)), []);
  });

  for (const tool of WRITE_TOOLS) {
    it(`${tool}: 감사 행위를 남기거나 제외 이유가 있다`, () => {
      const entry = TOOL_AUDIT_COVERAGE[tool];
      if (!entry) return;
      if (entry.exempt !== undefined) {
        assert.equal(entry.actions, undefined);
        assert.ok(typeof entry.exempt === "string" && entry.exempt.length >= 20, `${tool} 제외 이유가 짧다`);
        return;
      }
      assert.ok(Array.isArray(entry.actions) && entry.actions.length > 0, tool);
      const src  = readFileSync(path.join(ROOT, entry.file), "utf8");
      const body = handlerBody(src, entry.handler);
      assert.ok(body, `${entry.file}에 ${entry.handler}가 없다`);
      assert.match(body, /toolAudit\.|recordAudit\(/, `${entry.handler}가 감사 기록 함수를 부르지 않는다`);
      for (const action of entry.actions) {
        assert.ok(isValidAuditAction(action), action);
        assert.ok(AUDIT_SRC.includes(`"${action}"`) || src.includes(`"${action}"`), `${action} 문자열이 없다`);
      }
    });
  }
});
