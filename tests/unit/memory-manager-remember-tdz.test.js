/**
 * R12 TDZ 회귀 가드 (2026-04-20).
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 배경:
 *   v2.9.0에서 MemoryManager.remember 본문의 atomic 분기
 *   (return this._rememberAtomic(fragment, …))가 const fragment = this.factory.create(…)
 *   선언보다 앞에 놓여, MEMENTO_REMEMBER_ATOMIC=true && keyId != null 경로에서
 *   ReferenceError: Cannot access 'fragment' before initialization 발생.
 *
 * 2026-04-20 핫픽스로 atomic 분기를 fragment 생성 뒤로 이동 + quotaChecker.check를
 * if (!(atomicRemember && keyId)) 가드로 감쌌다. 이 테스트는 동일 리팩터 실수가
 * 다시 유입되는 것을 원천 차단한다.
 *
 * 참조: docs/plans/2026-04-19-tech-debt-audit.md R12
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { MemoryRememberer } from "../../lib/memory/processors/MemoryRememberer.js";

/**
 * Phase 5-B 분해 이후 remember 본문은 `lib/memory/processors/MemoryRememberer.js`로
 * 이관됐다. MemoryManager.prototype.remember는 이제 얇은 위임이므로
 * TDZ 회귀 가드는 MemoryRememberer.prototype.remember를 대상으로 한다.
 */
describe("MemoryRememberer.remember — R12 TDZ regression guard", () => {
  const src = MemoryRememberer.prototype.remember.toString();

  it("declares const fragment (via _buildFragment) before referencing it in the atomic branch", () => {
    /** Phase 5-B 분해 후 fragment 생성은 _buildFragment()로 위임됐다.
     *  TDZ 위험은 _buildFragment 호출이 _rememberAtomic 호출보다 앞에 있으면 제거된다. */
    const fragDeclIdx = src.indexOf("const fragment = this._buildFragment(");
    const atomicIdx   = src.indexOf("this._rememberAtomic(fragment");

    assert.ok(fragDeclIdx > 0, "const fragment = this._buildFragment(...) must exist in remember()");
    assert.ok(atomicIdx   > 0, "_rememberAtomic(fragment, ...) call must exist in remember()");
    assert.ok(
      fragDeclIdx < atomicIdx,
      `fragment must be assigned before atomic branch (decl=${fragDeclIdx}, ref=${atomicIdx}) — R12 TDZ regression`
    );
  });

  it("gates quotaChecker.check with !(atomicRemember && keyId) to preserve pre-check skip intent", () => {
    assert.match(
      src,
      /if\s*\(\s*!\s*\(\s*atomicRemember\s*&&\s*keyId\s*\)\s*\)\s*\{\s*await\s+this\.quotaChecker\.check/,
      "quotaChecker.check must be gated by if (!(atomicRemember && keyId)) — atomic path re-verifies quota via FOR UPDATE"
    );
  });

  it("atomic branch still references fragment (sanity)", () => {
    assert.match(
      src,
      /if\s*\(\s*atomicRemember\s*&&\s*keyId\s*\)\s*\{\s*return\s+await\s+this\._rememberAtomic\(\s*fragment\s*,/,
      "atomic branch should return _rememberAtomic(fragment, …) — shape preserved"
    );
  });
});
