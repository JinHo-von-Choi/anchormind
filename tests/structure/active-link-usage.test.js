/**
 * fragment_links를 읽는 SQL의 활성 링크 조건 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 * lib 아래에서 fragment_links를 FROM이나 JOIN으로 읽는 SQL 문자열은 지운 링크(deleted_at이 있는 행)를 빼야 한다.
 * 문자열 원문에 `deleted_at IS NULL`, activeLinkCondition(...) 호출, OPEN_CONFLICT_WHERE 중 하나가 있어야 한다.
 * INSERT, UPDATE, DELETE 문과, 지운 링크까지 일부러 세는 존재 확인(EXEMPT)은 뺀다.
 * 마지막 묶음은 조건을 지운 변형에서 위반이 잡히는지 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";
import { Linter }       from "eslint";

import { ROOT, listSourceFiles } from "./_source-scan.js";

/**
 * 지운 링크도 세야 하는 존재 확인과 사유.
 * FragmentGC.js: 링크에 걸린 파편을 지우지 않는 보호 조건이다. 지운 링크도 보호 근거로 남겨 보수적으로 둔다.
 * ContradictionDetector.js: 이미 판정한 쌍을 다시 판정하지 않는 조건이다. 지운 모순 링크도 판정 기록이다.
 * GraphLinker.js: 링크에 한 번도 참여하지 않은 고아 파편을 고르는 조건이다.
 * scheduler.js: 최근 6시간에 만든 related 링크 수로 통합 실행을 정한다. 생성 건수라 지운 행도 센다.
 */
const EXEMPT = new Set([
  "lib/memory/consolidate/FragmentGC.js",
  "lib/memory/link/ContradictionDetector.js",
  "lib/memory/link/GraphLinker.js",
  "lib/scheduler.js"
]);

const READS_LINKS = /\b(FROM|JOIN)\s+\S*fragment_links\b/i;
const WRITE_STMT  = /^\s*`?\s*(INSERT|UPDATE|DELETE)\b/i;
const GUARDED     = /deleted_at IS NULL|activeLinkCondition\(|OPEN_CONFLICT_WHERE/;

/**
 * 소스 안의 문자열·템플릿 원문(보간 식 포함)을 줄 번호와 함께 모은다.
 *
 * @param {string} source
 * @returns {{text: string, line: number}[]}
 */
function sqlTexts(source) {
  const found = [];
  const collect = {
    create(context) {
      return {
        TemplateLiteral(node) { found.push({ text: context.sourceCode.getText(node), line: node.loc.start.line }); },
        Literal(node) { if (typeof node.value === "string") found.push({ text: node.raw, line: node.loc.start.line }); }
      };
    }
  };
  const messages = new Linter().verify(source, [{
    plugins        : { scan: { rules: { collect } } },
    rules          : { "scan/collect": "error" },
    languageOptions: { ecmaVersion: "latest", sourceType: "module" }
  }]);
  const fatal = messages.find(m => m.fatal);
  if (fatal) throw new Error(`parse failed: ${fatal.message}`);
  return found;
}

/**
 * 활성 조건 없이 링크를 읽는 SQL의 줄 목록.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function activeLinkViolations(source) {
  return sqlTexts(source)
    .filter(({ text }) => READS_LINKS.test(text) && !WRITE_STMT.test(text) && !GUARDED.test(text))
    .map(({ text, line }) => `line ${line}: ${text.replace(/\s+/g, " ").slice(0, 80)}`);
}

const files = listSourceFiles("lib").filter(f => !EXEMPT.has(f));

describe("링크를 읽는 SQL은 활성 링크만 본다", () => {
  for (const file of files) {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    if (!source.includes("fragment_links")) continue;
    it(`${file}: 위반이 없다`, () => {
      assert.deepEqual(activeLinkViolations(source), []);
    });
  }
});

describe("검사기 자체", () => {
  it("조건을 지운 변형을 잡는다", () => {
    const source = readFileSync(path.join(ROOT, "lib/memory/read/LinkedFragmentLoader.js"), "utf8");
    const mutated = source.replace(/AND \$\{activeLinkCondition\("fl"\)\}\n/, "");
    assert.notEqual(mutated, source);
    assert.equal(activeLinkViolations(mutated).length, 1);
  });

  it("쓰기 문은 대상이 아니다", () => {
    assert.deepEqual(activeLinkViolations("const q = `DELETE FROM agent_memory.fragment_links WHERE from_id = $1`;"), []);
    assert.deepEqual(activeLinkViolations("const q = `UPDATE agent_memory.fragment_links l SET weight = 1 FROM agent_memory.fragment_links e`;"), []);
  });
});
