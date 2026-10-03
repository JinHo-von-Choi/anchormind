/**
 * 읽기 경로 workspace 허가 판정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * decideWorkspaceRead는 주체(master 여부), 키의 allowed_workspaces, 읽기 대상(effective workspace와 출처,
 * 전체 workspace 여부)으로 허가 여부와 사유를 정한다. isWorkspaceReadable은 같은 규칙을 파편 하나의
 * workspace에 적용한다. 허가 범위가 없으면(NULL) 제한이 없고, 범위가 있으면 범위 안 workspace와 전역(NULL)만
 * 읽는다. 조회 실패와 형식이 틀린 범위는 허가 밖이다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  decideWorkspaceRead,
  isWorkspaceReadable,
  WorkspaceReadDeniedError,
  ModePresetRejectedError,
  WORKSPACE_READ_REASONS,
  WORKSPACE_READ_TOOLS
} from "../../lib/memory/read/workspace-read-policy.js";

const explicit = (workspace) => ({ workspace, allWorkspaces: false, source: "explicit" });
const keyDefault = (workspace) => ({ workspace, allWorkspaces: false, source: "key_default" });
const globalOnly = { workspace: null, allWorkspaces: false, source: "none" };
const everything = { workspace: null, allWorkspaces: true, source: "explicit" };

describe("isWorkspaceReadable", () => {
  it("범위가 없으면 어떤 workspace도 읽는다", () => {
    for (const ws of [null, undefined, "ws-a", "ws-z"]) assert.equal(isWorkspaceReadable(null, ws), true);
    assert.equal(isWorkspaceReadable(undefined, "ws-a"), true);
  });

  it("범위가 있으면 범위 안 workspace와 전역 파편만 읽는다", () => {
    const range = ["ws-a", "ws-b"];
    assert.equal(isWorkspaceReadable(range, "ws-a"), true);
    assert.equal(isWorkspaceReadable(range, "ws-b"), true);
    assert.equal(isWorkspaceReadable(range, null), true);
    assert.equal(isWorkspaceReadable(range, undefined), true);
    assert.equal(isWorkspaceReadable(range, "ws-c"), false);
    assert.equal(isWorkspaceReadable(range, "WS-A"), false);
  });

  it("빈 범위는 전역 파편만 읽는다", () => {
    assert.equal(isWorkspaceReadable([], null), true);
    assert.equal(isWorkspaceReadable([], "ws-a"), false);
  });
});

describe("decideWorkspaceRead", () => {
  it("master는 범위와 대상에 관계없이 허가한다", () => {
    for (const target of [explicit("ws-z"), everything, globalOnly]) {
      const d = decideWorkspaceRead({ isMaster: true, allowedWorkspaces: ["ws-a"], lookupFailed: true, target });
      assert.deepEqual(d, { allowed: true, reason: "master" });
    }
  });

  it("allowed_workspaces가 없는 키는 모든 대상을 허가한다", () => {
    for (const target of [explicit("ws-z"), keyDefault("ws-y"), everything, globalOnly]) {
      const d = decideWorkspaceRead({ isMaster: false, allowedWorkspaces: null, target });
      assert.deepEqual(d, { allowed: true, reason: "unrestricted" });
    }
  });

  it("범위가 있는 키는 범위 안과 전역 대상을 허가한다", () => {
    const range = ["ws-a"];
    assert.deepEqual(decideWorkspaceRead({ allowedWorkspaces: range, target: explicit("ws-a") }),
      { allowed: true, reason: "in_range" });
    assert.deepEqual(decideWorkspaceRead({ allowedWorkspaces: range, target: keyDefault("ws-a") }),
      { allowed: true, reason: "in_range" });
    assert.deepEqual(decideWorkspaceRead({ allowedWorkspaces: range, target: globalOnly }),
      { allowed: true, reason: "global" });
    assert.deepEqual(decideWorkspaceRead({ allowedWorkspaces: [], target: globalOnly }),
      { allowed: true, reason: "global" });
  });

  it("범위 밖 대상은 명시 인자와 키 기본값을 구분한 사유로 거부한다", () => {
    assert.deepEqual(decideWorkspaceRead({ allowedWorkspaces: ["ws-a"], target: explicit("ws-b") }),
      { allowed: false, reason: "explicit_out_of_range" });
    assert.deepEqual(decideWorkspaceRead({ allowedWorkspaces: ["ws-a"], target: keyDefault("ws-b") }),
      { allowed: false, reason: "default_out_of_range" });
    assert.deepEqual(decideWorkspaceRead({ allowedWorkspaces: [], target: explicit("ws-a") }),
      { allowed: false, reason: "explicit_out_of_range" });
  });

  it("범위가 있는 키의 전체 workspace 대상은 거부한다", () => {
    assert.deepEqual(decideWorkspaceRead({ allowedWorkspaces: ["ws-a"], target: everything }),
      { allowed: false, reason: "all_workspaces" });
  });

  it("조회 실패와 형식이 틀린 범위는 거부한다", () => {
    assert.deepEqual(decideWorkspaceRead({ allowedWorkspaces: null, lookupFailed: true, target: globalOnly }),
      { allowed: false, reason: "lookup_failed" });
    for (const bad of ["ws-a", 3, {}, true]) {
      assert.deepEqual(decideWorkspaceRead({ allowedWorkspaces: bad, target: explicit("ws-a") }),
        { allowed: false, reason: "lookup_failed" }, JSON.stringify(bad));
    }
  });

  it("거부 사유는 닫힌 사유 집합 안에 있다", () => {
    const targets = [explicit("ws-b"), keyDefault("ws-b"), everything, globalOnly];
    const ranges  = [["ws-a"], [], "bad"];
    for (const target of targets) {
      for (const allowedWorkspaces of ranges) {
        const d = decideWorkspaceRead({ allowedWorkspaces, target });
        if (!d.allowed) assert.ok(WORKSPACE_READ_REASONS.includes(d.reason), d.reason);
      }
    }
  });
});

describe("판정 오류 형식", () => {
  it("workspace 읽기 거부는 권한 오류 코드와 사유를 싣는다", () => {
    for (const reason of WORKSPACE_READ_REASONS) {
      const err = new WorkspaceReadDeniedError("recall", reason);
      assert.ok(err instanceof Error);
      assert.equal(err.name, "WorkspaceReadDeniedError");
      assert.equal(err.code, -32001);
      assert.equal(err.surface, "recall");
      assert.equal(err.reason, reason);
      assert.match(err.message, /^Permission denied: /);
    }
  });

  it("master 전용 preset 거부는 권한 오류 코드와 preset 이름을 싣는다", () => {
    const err = new ModePresetRejectedError("audit", "header");
    assert.equal(err.name, "ModePresetRejectedError");
    assert.equal(err.code, -32001);
    assert.equal(err.preset, "audit");
    assert.equal(err.source, "header");
    assert.match(err.message, /'audit' requires master authentication/);
  });
});

describe("허가 대상 도구 표", () => {
  it("대상 종류는 요청 workspace 또는 전체 workspace다", () => {
    for (const [tool, kind] of Object.entries(WORKSPACE_READ_TOOLS)) {
      assert.ok(["request", "all_workspaces"].includes(kind), `${tool}: ${kind}`);
    }
  });
});
