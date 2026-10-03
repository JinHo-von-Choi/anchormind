/**
 * 관리 판정 결정 표 순수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * Core 프리셋 6종과 대표 능력의 교차표를 decide()로 계산해 프리셋 표와 맞는지, 능력 표의 규칙
 * (owner 전용 능력, owner와 admin 한정 능력, 읽기 역할의 쓰기 능력 부재, auditor 메타 마스킹)이
 * 지켜지는지 본다. 이어 결정 표의 단계(주체, 능력, 명시 거부, workspace 범위, 키 allowed_workspaces,
 * 범위 행)를 하나씩 본다. 기대 교차표 PLAN_TABLE은 능력 표(Core 프리셋 열)를 그대로 옮긴 독립 리터럴이며,
 * decide()로 계산한 칸과 양방향(허용 칸은 같은 방식으로 허용, "-" 칸은 거부)으로 대조한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  CAPABILITIES, REPRESENTATIVE_CAPABILITIES, ROLE_PRESETS, CORE_PRESETS, OWNER_ONLY_CAPABILITIES,
  CAP_AUTHENTICATED, capabilitiesFromPermissions, isCapability
} from "../../lib/admin/capabilities.js";
import { decide, masterPrincipal, apiKeyPrincipal } from "../../lib/admin/AdminAuthz.js";

/**
 * 능력 표의 Core 프리셋 열. 순서: owner, admin, reviewer, auditor, viewer, service.
 * logs.read는 서버 로그 파일 조회 능력으로 owner와 admin만 가진다.
 */
const PRESET_ORDER = ["owner", "admin", "reviewer", "auditor", "viewer", "service"];
const PLAN_TABLE   = {
  "mem.read"           : "O O W M W S",
  "mem.write"          : "O O - - - S",
  "mem.anchor"         : "O O - - - S",
  "mem.delete.soft"    : "O O - - - S",
  "mem.delete.hard"    : "O O - - - -",
  "mem.bulk"           : "O O - - - -",
  "mem.merge"          : "O O - - - -",
  "review.decide"      : "O O W - - -",
  "export.data"        : "O O - M - -",
  "import.data"        : "O O - - - -",
  "key.manage"         : "O O - - - -",
  "key.policy"         : "O O - - - -",
  "egress.policy"      : "O O - - - -",
  "ws.create"          : "O O - - - -",
  "ws.quota"           : "O O - - - -",
  "retention.manage"   : "O O - - - -",
  "legal_hold.manage"  : "O - - - - -",
  "erasure.request"    : "O O - - - -",
  "erasure.execute"    : "O - - - - -",
  "job.dry_run"        : "O O - - - -",
  "job.apply"          : "O O - - - -",
  "audit.read"         : "O O - O - -",
  "audit.export"       : "O O - O - -",
  "webhook.manage"     : "O O - - - -",
  "usage.read"         : "O O - O W -",
  "quality.read"       : "O O - O W -",
  "logs.read"          : "O O - - - -",
  "oauth_client.manage": "O O - - - -",
  "admin_user.manage"  : "O - - - - -",
  "system.update"      : "O - - - - -"
};

/** PLAN_TABLE의 칸 값 */
const planCell = (cap, role) => PLAN_TABLE[cap].split(" ")[PRESET_ORDER.indexOf(role)];

/** 프리셋 하나를 전역으로 바인딩한 관리자 주체 */
const roleOf = (role, workspace = null) => ({ kind: "admin_session", id: `s-${role}`, bindings: [{ role, workspace }] });

/** 프리셋 x 능력 교차표. 칸은 허용이면 방식, 거부면 "-" */
function crossTable(caps) {
  const table = {};
  for (const role of CORE_PRESETS) {
    table[role] = {};
    for (const cap of caps) {
      const d = decide(roleOf(role), cap);
      table[role][cap] = d.allowed ? d.mode : "-";
    }
  }
  return table;
}

describe("프리셋 x 대표 능력 교차표", () => {
  const table = crossTable(REPRESENTATIVE_CAPABILITIES);

  it("Core 프리셋은 6종이고 대표 능력은 능력 표의 행마다 하나다", () => {
    assert.deepEqual([...CORE_PRESETS].sort(), ["admin", "auditor", "owner", "reviewer", "service", "viewer"]);
    assert.equal(new Set(REPRESENTATIVE_CAPABILITIES).size, REPRESENTATIVE_CAPABILITIES.length);
    for (const cap of REPRESENTATIVE_CAPABILITIES) assert.ok(isCapability(cap), cap);
    assert.equal(Object.values(table).reduce((n, row) => n + Object.keys(row).length, 0),
      CORE_PRESETS.length * REPRESENTATIVE_CAPABILITIES.length);
  });

  it("기대 교차표와 코드의 능력 목록, 프리셋 목록이 서로 빠짐없이 같다", () => {
    assert.deepEqual(Object.keys(PLAN_TABLE).sort(), [...CAPABILITIES].sort());
    assert.deepEqual([...PRESET_ORDER].sort(), [...CORE_PRESETS].sort());
    for (const cap of Object.keys(PLAN_TABLE)) assert.equal(PLAN_TABLE[cap].split(" ").length, PRESET_ORDER.length, cap);
  });

  it("대표 능력 칸마다 판정 결과가 기대 교차표와 같다", () => {
    for (const role of CORE_PRESETS) {
      for (const cap of REPRESENTATIVE_CAPABILITIES) assert.equal(table[role][cap], planCell(cap, role), `${role} ${cap}`);
    }
  });

  it("모든 능력 칸에서 허용 칸은 같은 방식으로 허용, - 칸은 거부다(양방향)", () => {
    for (const role of PRESET_ORDER) {
      for (const cap of CAPABILITIES) {
        const d    = decide(roleOf(role), cap);
        const cell = planCell(cap, role);
        if (cell === "-") assert.equal(d.allowed, false, `${role} ${cap}는 거부여야 한다`);
        else {
          assert.equal(d.allowed, true, `${role} ${cap}는 허용이어야 한다`);
          assert.equal(d.mode, cell, `${role} ${cap} 방식`);
        }
      }
    }
  });

  it("코드의 프리셋 표가 준 능력은 모두 기대 교차표의 허용 칸이다", () => {
    for (const role of PRESET_ORDER) {
      for (const [cap, mode] of Object.entries(ROLE_PRESETS[role])) assert.equal(planCell(cap, role), mode, `${role} ${cap}`);
    }
  });

  it("owner는 모든 능력을 가진다", () => {
    for (const cap of CAPABILITIES) assert.equal(decide(roleOf("owner"), cap).allowed, true, cap);
  });

  it("owner 전용 능력은 owner 밖의 프리셋에 없다", () => {
    for (const cap of OWNER_ONLY_CAPABILITIES) {
      const holders = CORE_PRESETS.filter((role) => decide(roleOf(role), cap).allowed);
      assert.deepEqual(holders, ["owner"], cap);
    }
  });

  it("admin은 owner 전용 능력을 뺀 나머지를 모두 가진다", () => {
    const ownerOnly = new Set(OWNER_ONLY_CAPABILITIES);
    for (const cap of CAPABILITIES) assert.equal(decide(roleOf("admin"), cap).allowed, !ownerOnly.has(cap), cap);
  });

  it("egress.policy, key.policy, key.manage는 owner와 admin만 가진다", () => {
    for (const cap of ["egress.policy", "key.policy", "key.manage"]) {
      const holders = CORE_PRESETS.filter((role) => decide(roleOf(role), cap).allowed).sort();
      assert.deepEqual(holders, ["admin", "owner"], cap);
    }
  });

  it("읽기 역할(reviewer, auditor, viewer)에는 기억 쓰기, 삭제, 가져오기 능력이 없다", () => {
    const writes = CAPABILITIES.filter((cap) => /^(mem\.(write|anchor|delete|bulk|merge)|import\.|erasure\.|job\.apply)/.test(cap));
    for (const role of ["reviewer", "auditor", "viewer"]) {
      for (const cap of writes) assert.equal(decide(roleOf(role), cap).allowed, false, `${role} ${cap}`);
    }
  });

  it("service 능력은 기억 능력뿐이다", () => {
    for (const cap of CAPABILITIES) {
      if (decide(roleOf("service"), cap).allowed) assert.match(cap, /^mem\./);
    }
  });

  it("auditor의 기억 읽기와 내보내기는 마스킹 판정이다", () => {
    for (const cap of ["mem.read", "export.data"]) {
      const d = decide(roleOf("auditor"), cap);
      assert.equal(d.allowed, true);
      assert.equal(d.redact, true, cap);
    }
    assert.equal(decide(roleOf("auditor"), "audit.read").redact, false);
    assert.equal(decide(roleOf("owner"), "mem.read").redact, false);
  });
});

describe("결정 표 단계", () => {
  it("마스터 키 주체는 owner이고 어떤 workspace에서도 허용이다", () => {
    const p = masterPrincipal();
    assert.equal(p.kind, "master");
    for (const cap of CAPABILITIES) {
      assert.equal(decide(p, cap).allowed, true, cap);
      assert.equal(decide(p, cap, { workspace: "ws-a" }).allowed, true, cap);
    }
    assert.deepEqual(decide(p, "mem.read").range, { all: true });
  });

  it("주체가 없거나 형식이 틀리면 principal 단계에서 거부한다", () => {
    for (const p of [null, undefined, {}, { kind: "admin_session" }, { kind: "x", id: "a", bindings: [] }]) {
      const d = decide(p, "mem.read");
      assert.equal(d.allowed, false);
      assert.equal(d.deniedAt, "principal");
    }
  });

  it("모르는 능력은 capability 단계에서 거부한다", () => {
    for (const cap of ["mem.everything", "", null, "constructor", "__proto__"]) {
      const d = decide(masterPrincipal(), cap);
      assert.equal(d.allowed, false);
      assert.equal(d.deniedAt, "capability");
      assert.equal(d.reason, "unknown_capability");
    }
  });

  it("모르는 역할 바인딩은 능력을 주지 않는다", () => {
    for (const role of ["ghost", "constructor", "__proto__", "toString"]) {
      const d = decide(roleOf(role), "mem.read");
      assert.equal(d.allowed, false, role);
      assert.equal(d.deniedAt, "capability");
    }
  });

  it("인증 표지 능력은 유효한 주체면 허용이고 범위를 묻지 않는다", () => {
    assert.equal(decide(roleOf("viewer", "ws-a"), CAP_AUTHENTICATED).allowed, true);
    assert.equal(decide(null, CAP_AUTHENTICATED).allowed, false);
  });

  it("명시 거부가 프리셋 부여보다 앞선다", () => {
    const p = { ...roleOf("admin"), deny: ["key.manage"] };
    const d = decide(p, "key.manage");
    assert.equal(d.allowed, false);
    assert.equal(d.deniedAt, "deny");
    assert.equal(decide(p, "key.policy").allowed, true);
  });

  it("바인딩 합집합: 한 역할이 주지 않는 능력을 다른 역할이 주면 허용이다", () => {
    const p = { kind: "admin_session", id: "s", bindings: [{ role: "viewer", workspace: null }, { role: "reviewer", workspace: null }] };
    assert.equal(decide(p, "review.decide").allowed, true);
    assert.equal(decide(p, "usage.read").allowed, true);
    assert.equal(decide(p, "mem.write").allowed, false);
  });

  it("여러 바인딩이 같은 능력을 주면 넓은 방식을 쓴다(마스킹 해제)", () => {
    const p = { kind: "admin_session", id: "s", bindings: [{ role: "auditor", workspace: null }, { role: "viewer", workspace: null }] };
    const d = decide(p, "mem.read");
    assert.equal(d.mode, "W");
    assert.equal(d.redact, false);
  });

  it("workspace 바인딩은 그 workspace만 허용하고 전역 대상은 거부한다", () => {
    const p = roleOf("reviewer", "ws-a");
    assert.equal(decide(p, "mem.read", { workspace: "ws-a" }).allowed, true);
    const other = decide(p, "mem.read", { workspace: "ws-b" });
    assert.equal(other.allowed, false);
    assert.equal(other.deniedAt, "workspace");
    const global = decide(p, "mem.read");
    assert.equal(global.allowed, false);
    assert.equal(global.deniedAt, "workspace");
    assert.deepEqual(decide(p, "mem.read", { workspace: "ws-a" }).range, { all: false, workspaces: ["ws-a"] });
  });

  it("범위는 그 능력을 주는 바인딩의 workspace만 합친다", () => {
    const p = { kind: "admin_session", id: "s", bindings: [{ role: "reviewer", workspace: "ws-a" }, { role: "viewer", workspace: "ws-b" }] };
    assert.equal(decide(p, "review.decide", { workspace: "ws-b" }).allowed, false);
    assert.equal(decide(p, "mem.read", { workspace: "ws-b" }).allowed, true);
    assert.deepEqual(decide(p, "mem.read", { workspace: "ws-a" }).range.workspaces.sort(), ["ws-a", "ws-b"]);
  });

  it("범위 행이 하나라도 있으면 행에 없는 (능력, workspace) 조합은 거부한다", () => {
    const p = { ...roleOf("admin"), scopeRows: [{ cap: "mem.read", workspace: "ws-a" }] };
    assert.equal(decide(p, "mem.read", { workspace: "ws-a" }).allowed, true);
    assert.equal(decide(p, "mem.read", { workspace: "ws-b" }).allowed, false);
    assert.equal(decide(p, "mem.write", { workspace: "ws-a" }).allowed, false);
    assert.equal(decide(p, "mem.read").allowed, false);
    assert.equal(decide({ ...roleOf("admin"), scopeRows: [] }, "mem.write").allowed, true);
  });
});

describe("API 키 주체", () => {
  it("permissions를 능력으로 바꾼다: read는 mem.read, write는 mem.write와 mem.delete.soft, anchor는 mem.anchor", () => {
    assert.deepEqual([...capabilitiesFromPermissions(["read"])], ["mem.read"]);
    assert.deepEqual([...capabilitiesFromPermissions(["write"])].sort(), ["mem.delete.soft", "mem.write"]);
    assert.deepEqual([...capabilitiesFromPermissions(["anchor"])], ["mem.anchor"]);
    assert.deepEqual([...capabilitiesFromPermissions(["admin", "constructor", 7])], []);
    assert.deepEqual([...capabilitiesFromPermissions(null)], []);
  });

  it("service 프리셋 안에서 permissions가 준 능력만 허용한다", () => {
    const reader = apiKeyPrincipal({ keyId: "k1", permissions: ["read"], allowedWorkspaces: null });
    assert.equal(reader.kind, "api_key");
    assert.equal(decide(reader, "mem.read").allowed, true);
    assert.equal(decide(reader, "mem.read").mode, "S");
    const write = decide(reader, "mem.write");
    assert.equal(write.allowed, false);
    assert.equal(write.deniedAt, "capability");
    const both = apiKeyPrincipal({ keyId: "k2", permissions: ["read", "write"], allowedWorkspaces: null });
    for (const cap of CAPABILITIES) {
      const expected = ["mem.read", "mem.write", "mem.delete.soft"].includes(cap);
      assert.equal(decide(both, cap).allowed, expected, cap);
    }
  });

  it("allowed_workspaces NULL은 제한 없음, 배열은 교집합, 빈 배열은 전부 거부다", () => {
    const open = apiKeyPrincipal({ keyId: "k", permissions: ["read"], allowedWorkspaces: null });
    assert.equal(decide(open, "mem.read", { workspace: "any" }).allowed, true);
    const listed = apiKeyPrincipal({ keyId: "k", permissions: ["read"], allowedWorkspaces: ["ws-a"] });
    assert.equal(decide(listed, "mem.read", { workspace: "ws-a" }).allowed, true);
    assert.equal(decide(listed, "mem.read", { workspace: "ws-b" }).deniedAt, "workspace");
    assert.equal(decide(listed, "mem.read").deniedAt, "workspace");
    const none = apiKeyPrincipal({ keyId: "k", permissions: ["read"], allowedWorkspaces: [] });
    assert.equal(decide(none, "mem.read", { workspace: "ws-a" }).allowed, false);
  });
});

describe("판정 근거", () => {
  it("단계 목록과 거부 단계, 주체 요약을 담고 비밀 값은 담지 않는다", () => {
    const p = apiKeyPrincipal({ keyId: "k1", permissions: ["read"], allowedWorkspaces: ["ws-a"] });
    const d = decide(p, "mem.read", { workspace: "ws-b" });
    assert.deepEqual(d.steps.map((s) => s.step), ["principal", "capability", "deny", "workspace"]);
    assert.equal(d.deniedAt, "workspace");
    assert.deepEqual(d.principal, { kind: "api_key", id: "k1", roles: ["service"] });
    assert.ok(!("permissions" in d.principal));
  });

  it("허용 판정의 단계는 모두 통과로 표시된다", () => {
    const d = decide(masterPrincipal(), "audit.read", { workspace: "ws-a" });
    assert.equal(d.allowed, true);
    assert.equal(d.deniedAt, null);
    assert.ok(d.steps.every((s) => s.ok === true));
  });
});
