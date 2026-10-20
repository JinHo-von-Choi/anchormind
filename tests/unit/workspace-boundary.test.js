/**
 * 다른 작업 공간에서 확인된 사실 표시 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { workspaceBoundaryWarning } from "../../lib/memory/read/WorkspaceBoundary.js";

describe("workspaceBoundaryWarning", () => {
  const fact = (workspace) => ({ type: "fact", workspace });

  it("allWorkspaces 조회에서 적용 대상과 다른 작업 공간의 fact만 표시한다", () => {
    const params = { allWorkspaces: true, workspace: "alpha" };
    assert.match(workspaceBoundaryWarning(fact("beta"), params), /'beta'에서 확인된 값입니다. 'alpha'에 적용하기 전에/);
    assert.equal(workspaceBoundaryWarning(fact("alpha"), params), null);
    assert.equal(workspaceBoundaryWarning(fact(null), params), null, "전역 fact는 표시하지 않는다");
    assert.equal(workspaceBoundaryWarning({ type: "procedure", workspace: "beta" }, params), null, "절차는 옮겨 쓸 수 있다");
  });

  it("적용 대상이 없으면 키 기본 작업 공간을 쓰고, 그것도 없으면 판정하지 않는다", () => {
    assert.ok(workspaceBoundaryWarning(fact("beta"), { allWorkspaces: true, _defaultWorkspace: "alpha" }));
    assert.equal(workspaceBoundaryWarning(fact("beta"), { allWorkspaces: true }), null);
  });

  it("일반 조회는 다른 작업 공간 파편이 섞이지 않으므로 표시하지 않는다", () => {
    assert.equal(workspaceBoundaryWarning(fact("beta"), { workspace: "alpha" }), null);
  });
});
