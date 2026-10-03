/**
 * 플러그인 스킬 핵심본 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * integrations/claude-code/skills/anchormind/SKILL.md는 300줄 이하의 핵심본이고, 상세 내용은 저장소 루트
 * SKILL.md를 정본으로 get_skill_guide(section)로 참조한다. 핵심본의 도구 목록이 루트 SKILL.md 도구 레퍼런스,
 * 도구 메타 표와 같은 집합인지, 참조하는 섹션이 루트 SKILL.md에서 실제로 잘리는지 본다.
 */

import { describe, it }  from "node:test";
import assert            from "node:assert/strict";
import { readFileSync }  from "node:fs";
import path              from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_SECTIONS } from "../../lib/tools/skill-sections.js";
import { TOOL_HEAD }      from "../../lib/tools/tool-head.js";

const ROOT      = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_DIR = path.join(ROOT, "integrations", "claude-code", "skills", "anchormind");
const CORE      = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
const ROOT_DOC  = readFileSync(path.join(ROOT, "SKILL.md"), "utf8");

/** 프런트매터 키와 값 */
function frontmatter(text) {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(block, "프런트매터가 없다");
  return Object.fromEntries(block[1].split("\n").map((line) => {
    const at = line.indexOf(":");
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
}

/** 루트 SKILL.md 도구 레퍼런스 섹션의 ### 도구 이름 */
function rootToolNames() {
  const section = ROOT_DOC.match(SKILL_SECTIONS.tools);
  assert.ok(section, "루트 SKILL.md에서 도구 레퍼런스 섹션을 찾지 못했다");
  return [...section[0].matchAll(/^### ([a-z_]+)\s*$/gm)].map(m => m[1]);
}

/** 핵심본 도구 목록 표의 첫 열 도구 이름 */
function coreToolNames() {
  const section = /^## 도구 목록[\s\S]*?(?=^## )/m.exec(CORE);
  assert.ok(section, "핵심본에 '## 도구 목록' 섹션이 없다");
  return [...section[0].matchAll(/^\| `([a-z_]+)` \|/gm)].map(m => m[1]);
}

describe("플러그인 스킬 핵심본", () => {
  it("300줄 이하다", () => {
    const lines = CORE.split("\n").length;
    assert.ok(lines <= 300, `${lines}줄`);
  });

  it("Agent Skills 프런트매터(name, description)를 가진다", () => {
    const fm = frontmatter(CORE);
    assert.equal(fm.name, path.basename(SKILL_DIR));
    assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fm.description && fm.description.length <= 1024, "description은 1~1024자");
  });

  it("도구 목록이 루트 SKILL.md 도구 레퍼런스와 같은 집합이다", () => {
    const core = coreToolNames();
    assert.equal(new Set(core).size, core.length, "핵심본 도구 목록에 중복이 있다");
    assert.deepEqual([...core].sort(), [...rootToolNames()].sort());
  });

  it("도구 목록이 서버 도구 메타 표와 같은 집합이다", () => {
    assert.deepEqual([...coreToolNames()].sort(), Object.keys(TOOL_HEAD).sort());
  });

  it("참조하는 get_skill_guide 섹션은 루트 SKILL.md에서 잘린다", () => {
    const refs = [...CORE.matchAll(/get_skill_guide\(section="([a-z]+)"\)/g)].map(m => m[1]);
    assert.ok(new Set(refs).size >= 5, "상세 참조가 너무 적다");
    for (const ref of new Set(refs)) {
      assert.ok(ref in SKILL_SECTIONS, `${ref}는 get_skill_guide 섹션이 아니다`);
      assert.ok(SKILL_SECTIONS[ref].test(ROOT_DOC), `${ref} 섹션이 루트 SKILL.md에 없다`);
    }
  });

  it("도구 처리기는 섹션 표를 잎 모듈에서 가져온다", () => {
    const src = readFileSync(path.join(ROOT, "lib", "tools", "memory.js"), "utf8");
    assert.match(src, /import \{ SKILL_SECTIONS \}\s+from "\.\/skill-sections\.js";/);
    assert.doesNotMatch(src, /const SKILL_SECTIONS\s*=/);
  });
});
