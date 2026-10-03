/**
 * 읽기 경로 workspace 허가 관문과 master 전용 preset 판정 시험(대역 사용)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * authorizeWorkspaceRead는 MEMENTO_WORKSPACE_READ_AUTHZ 방식(off, warn, enforce)에 따라 판정을 건너뛰거나,
 * 허가 밖 요청을 지표와 경고 로그로 남기고 통과시키거나, 권한 오류로 거부한다. allowed_workspaces 조회와
 * 방식 판독은 대역으로 바꾼다. off와 warn은 인자를 바꾸지 않고 던지지 않으며(기존 동작과 같음), master와
 * 범위가 없는 키는 모든 방식에서 통과한다. authorizeModePreset은 master가 아닌 세션의 master 전용 preset
 * 요청을 같은 방식으로 다룬다.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert                             from "node:assert/strict";

const warnLogs   = [];
const realLogger = await import("../../lib/logger.js");
mock.module("../../lib/logger.js", {
  namedExports : { ...realLogger, logWarn: (...a) => { warnLogs.push(a.join(" ")); } },
  defaultExport: realLogger.default
});

const { authorizeWorkspaceRead, authorizeModePreset } = await import("../../lib/memory/read/WorkspaceReadAuthz.js");
const { workspaceReadAuthzTotal }                     = await import("../../lib/memory/read/read-authz-metrics.js");
const { WorkspaceReadDeniedError, WORKSPACE_READ_TOOLS } = await import("../../lib/memory/read/workspace-read-policy.js");
const { WORKSPACE_LOOKUP_FAILED }                     = await import("../../lib/admin/ApiKeyStore.js");

/** 카운터의 라벨 조합 하나의 현재 값 */
async function count(surface, reason, outcome) {
  const { values } = await workspaceReadAuthzTotal.get();
  const hit = values.find(v => v.labels.surface === surface && v.labels.reason === reason && v.labels.outcome === outcome);
  return hit ? hit.value : 0;
}

function deps(mode, allowed, calls = []) {
  return {
    mode                : () => mode,
    getAllowedWorkspaces: async (keyId) => { calls.push(keyId); return allowed; }
  };
}

const keyArgs = (extra = {}) => ({ _keyId: "key-1", _isMaster: false, _defaultWorkspace: null, ...extra });

beforeEach(() => { warnLogs.length = 0; });

describe("authorizeWorkspaceRead: off", () => {
  it("조회하지 않고 인자를 바꾸지 않는다", async () => {
    const calls = [];
    const args  = keyArgs({ workspace: "ws-b" });
    const before = structuredClone(args);
    const d = await authorizeWorkspaceRead("recall", args, deps("off", ["ws-a"], calls));
    assert.equal(d, null);
    assert.deepEqual(calls, []);
    assert.deepEqual(args, before);
  });
});

describe("authorizeWorkspaceRead: warn", () => {
  it("범위 밖 명시 workspace는 would_deny 지표와 키 표본 로그를 남기고 통과한다", async () => {
    const base = await count("recall", "explicit_out_of_range", "would_deny");
    const args = keyArgs({ workspace: "ws-b" });
    const before = structuredClone(args);
    const d = await authorizeWorkspaceRead("recall", args, deps("warn", ["ws-a"]));
    assert.deepEqual(d, { allowed: false, reason: "explicit_out_of_range" });
    assert.deepEqual(args, before, "warn은 인자를 바꾸지 않는다");
    assert.equal(await count("recall", "explicit_out_of_range", "would_deny"), base + 1);
    assert.equal(warnLogs.length, 1);
    assert.match(warnLogs[0], /would_deny/);
    assert.match(warnLogs[0], /key-1/);
    assert.match(warnLogs[0], /recall/);
    assert.match(warnLogs[0], /ws-b/);
  });

  it("키 기본 workspace가 범위 밖이면 사유가 default_out_of_range다", async () => {
    const d = await authorizeWorkspaceRead("context", keyArgs({ _defaultWorkspace: "ws-d" }), deps("warn", ["ws-a"]));
    assert.equal(d.reason, "default_out_of_range");
  });

  it("범위 안과 전역 요청은 기록하지 않는다", async () => {
    await authorizeWorkspaceRead("recall", keyArgs({ workspace: "ws-a" }), deps("warn", ["ws-a"]));
    await authorizeWorkspaceRead("recall", keyArgs(), deps("warn", ["ws-a"]));
    assert.equal(warnLogs.length, 0);
  });

  it("조회 실패는 lookup_failed로 기록하고 통과한다", async () => {
    const d = await authorizeWorkspaceRead("graph_explore", keyArgs(), deps("warn", WORKSPACE_LOOKUP_FAILED));
    assert.deepEqual(d, { allowed: false, reason: "lookup_failed" });
  });

  it("memory_stats는 범위가 있는 키에게 전체 workspace 대상이다", async () => {
    const d = await authorizeWorkspaceRead("memory_stats", keyArgs(), deps("warn", ["ws-a"]));
    assert.deepEqual(d, { allowed: false, reason: "all_workspaces" });
  });
});

describe("authorizeWorkspaceRead: enforce", () => {
  it("범위 밖 요청은 권한 오류로 거부하고 denied를 센다", async () => {
    const base = await count("search_traces", "explicit_out_of_range", "denied");
    await assert.rejects(
      authorizeWorkspaceRead("search_traces", keyArgs({ workspace: "ws-b" }), deps("enforce", ["ws-a"])),
      (err) => err instanceof WorkspaceReadDeniedError && err.code === -32001 && err.reason === "explicit_out_of_range"
    );
    assert.equal(await count("search_traces", "explicit_out_of_range", "denied"), base + 1);
  });

  it("허가된 요청에는 파편 단위 판정에 쓸 허가 범위를 붙인다", async () => {
    const args = keyArgs({ workspace: "ws-a" });
    const d = await authorizeWorkspaceRead("recall", args, deps("enforce", ["ws-a"]));
    assert.equal(d.allowed, true);
    assert.deepEqual(args._workspaceReadRange, ["ws-a"]);
  });

  it("범위가 없는 키는 범위를 붙이지 않고 통과한다", async () => {
    const args = keyArgs({ workspace: "ws-z" });
    const d = await authorizeWorkspaceRead("recall", args, deps("enforce", null));
    assert.deepEqual(d, { allowed: true, reason: "unrestricted" });
    assert.equal(args._workspaceReadRange, undefined);
  });
});

describe("authorizeWorkspaceRead: 공통", () => {
  it("master는 조회하지 않고 모든 방식에서 통과한다", async () => {
    for (const mode of ["warn", "enforce"]) {
      const calls = [];
      const args  = { _keyId: null, _isMaster: true, workspace: "ws-z", allWorkspaces: true };
      const d = await authorizeWorkspaceRead("recall", args, deps(mode, ["ws-a"], calls));
      assert.deepEqual(d, { allowed: true, reason: "master" });
      assert.deepEqual(calls, []);
      assert.equal(args._workspaceReadRange, undefined);
    }
  });

  it("허가 대상이 아닌 표면은 판정하지 않는다", async () => {
    for (const surface of ["remember", "batch_status", "get_skill_guide", "unknown"]) {
      const calls = [];
      const d = await authorizeWorkspaceRead(surface, keyArgs({ workspace: "ws-b" }), deps("enforce", ["ws-a"], calls));
      assert.equal(d, null, surface);
      assert.deepEqual(calls, []);
    }
  });

  it("resources/read와 모든 허가 도구가 판정 대상이다", async () => {
    for (const surface of [...Object.keys(WORKSPACE_READ_TOOLS), "resources/read"]) {
      const d = await authorizeWorkspaceRead(surface, keyArgs({ workspace: "ws-b" }), deps("warn", ["ws-a"]));
      assert.equal(d.allowed, false, surface);
    }
  });

  it("범위가 없는 키는 off, warn, enforce 모두에서 인자를 바꾸지 않고 던지지 않는다", async () => {
    for (const mode of ["off", "warn", "enforce"]) {
      for (const surface of [...Object.keys(WORKSPACE_READ_TOOLS), "resources/read"]) {
        const args   = keyArgs({ workspace: "ws-q", _defaultWorkspace: "ws-r" });
        const before = structuredClone(args);
        await authorizeWorkspaceRead(surface, args, deps(mode, null));
        assert.deepEqual(args, before, `${mode} ${surface}`);
      }
    }
    assert.equal(warnLogs.length, 0);
  });
});

describe("authorizeModePreset", () => {
  const registry = {
    getPreset: (name) => ({ audit: { requiresMaster: true }, "recall-only": { requiresMaster: false } })[name] ?? null
  };
  const presetDeps = (mode) => ({ mode: () => mode, getPreset: registry.getPreset });

  it("warn은 would_deny를 기록하고 preset을 그대로 둔다(무시 동작 유지)", async () => {
    const base = await count("mode_preset", "preset_requires_master", "would_deny");
    const v = authorizeModePreset({ preset: "audit", source: "header", isMaster: false, keyId: "key-1" }, presetDeps("warn"));
    assert.deepEqual(v, { rejected: false, error: null });
    assert.equal(await count("mode_preset", "preset_requires_master", "would_deny"), base + 1);
    assert.equal(warnLogs.length, 1);
    assert.match(warnLogs[0], /audit/);
    assert.match(warnLogs[0], /header/);
    assert.match(warnLogs[0], /key-1/);
  });

  it("enforce는 권한 오류로 거부한다", async () => {
    const base = await count("mode_preset", "preset_requires_master", "denied");
    const v = authorizeModePreset({ preset: "audit", source: "key_default", isMaster: false, keyId: "key-1" }, presetDeps("enforce"));
    assert.equal(v.rejected, true);
    assert.equal(v.error.code, -32001);
    assert.equal(v.error.preset, "audit");
    assert.equal(v.error.source, "key_default");
    assert.equal(await count("mode_preset", "preset_requires_master", "denied"), base + 1);
  });

  it("off, master, 일반 preset, preset 없음은 판정하지 않는다", async () => {
    const cases = [
      [{ preset: "audit", source: "header", isMaster: false }, "off"],
      [{ preset: "audit", source: "header", isMaster: true }, "enforce"],
      [{ preset: "recall-only", source: "header", isMaster: false }, "enforce"],
      [{ preset: null, source: "none", isMaster: false }, "enforce"]
    ];
    for (const [input, mode] of cases) {
      assert.deepEqual(authorizeModePreset(input, presetDeps(mode)), { rejected: false, error: null });
    }
    assert.equal(warnLogs.length, 0);
  });
});
