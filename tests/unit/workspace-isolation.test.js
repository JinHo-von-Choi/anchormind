// tests/unit/workspace-isolation.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendWorkspaceCondition,
  assertAllWorkspacesAuthorized,
  resolveWorkspaceScope
} from "../../lib/memory/read/WorkspaceScope.js";

describe("workspace 우선순위 해석", () => {
  it("params.workspace가 _defaultWorkspace보다 우선", () => {
    const result = resolveWorkspaceScope({ workspace: "ws-a", _defaultWorkspace: "ws-b" });
    assert.equal(result.workspace, "ws-a");
    assert.equal(result.mode, "workspace");
  });

  it("params.workspace 미지정 시 _defaultWorkspace 사용", () => {
    const result = resolveWorkspaceScope({ _defaultWorkspace: "ws-default" });
    assert.equal(result.workspace, "ws-default");
  });

  it("둘 다 없으면 null", () => {
    const result = resolveWorkspaceScope({});
    assert.equal(result.workspace, null);
    assert.equal(result.mode, "global_only");
  });

  it("params.workspace가 null이면 _defaultWorkspace로 폴백 (null은 미지정으로 취급)", () => {
    const result = resolveWorkspaceScope({ workspace: null, _defaultWorkspace: "ws-default" });
    assert.equal(result.workspace, "ws-default");
  });

  it("allWorkspaces=true는 명시 전체 조회 모드", () => {
    const result = resolveWorkspaceScope({ allWorkspaces: true });
    assert.equal(result.allWorkspaces, true);
    assert.equal(result.mode, "all_workspaces");
  });
});

describe("workspace 검색 필터 조건 생성", () => {
  it("workspace 지정 시 OR IS NULL 조건 생성", () => {
    const conditions = [];
    const params = ["a", "b"];
    appendWorkspaceCondition(conditions, params, { workspace: "ws-a" });
    assert.equal(conditions[0], "(workspace = $3 OR workspace IS NULL)");
    assert.equal(params[2], "ws-a");
  });

  it("workspace null 시 global-only 조건", () => {
    const conditions = [];
    appendWorkspaceCondition(conditions, [], {});
    assert.deepEqual(conditions, ["workspace IS NULL"]);
  });

  it("allWorkspaces=true 시 필터 없음", () => {
    const conditions = [];
    appendWorkspaceCondition(conditions, [], { allWorkspaces: true });
    assert.deepEqual(conditions, []);
  });
});

describe("allWorkspaces 권한", () => {
  it("서버가 주입한 master만 허용", () => {
    assert.doesNotThrow(() => assertAllWorkspacesAuthorized({
      allWorkspaces: true, _isMaster: true
    }));
  });

  it("일반 API key 요청은 명시적 권한 오류", () => {
    assert.throws(
      () => assertAllWorkspacesAuthorized({ allWorkspaces: true, _isMaster: false }),
      err => err.code === "WORKSPACE_SCOPE_FORBIDDEN"
    );
  });
});
