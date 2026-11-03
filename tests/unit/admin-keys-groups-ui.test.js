/**
 * admin.js -- Keys/Groups 렌더러 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 * 수정일: 2026-04-19 (ESM 모듈 직접 import 방식으로 전환)
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom, flatQuery } from "./admin-test-helper.js";

/* DOM mock을 모듈 import 전에 주입 */
setupDom();

const {
  renderKeyKpiRow,
  renderKeyTable,
  renderKeyInspector,
  keyInUseMessage
} = await import("../../assets/admin/modules/keys.js");

const {
  renderGroupKpiRow,
  renderGroupTable,
  renderGroupInspector,
  togglePermission,
  groupLimitLabel,
  parseGroupLimitInput
} = await import("../../assets/admin/modules/groups.js");

const { state } = await import("../../assets/admin/modules/state.js");

/* ================================================================
   Keys View
   ================================================================ */

describe("keyInUseMessage", () => {
  test("파편 수와 재통합 기록 수를 함께 알린다", () => {
    const msg = keyInUseMessage({ fragments: 0, reconsolidations: 3 });
    assert.match(msg, /0 stored fragments/);
    assert.match(msg, /3 link reconsolidation records/);
  });

  test("한쪽 수가 없으면 일반 문구를 쓴다", () => {
    assert.equal(keyInUseMessage({ fragments: 2 }), "Key has stored data. Deactivate it instead.");
    assert.equal(keyInUseMessage(undefined), "Key has stored data. Deactivate it instead.");
  });
});

describe("renderKeyKpiRow", () => {
  test("4개 KPI 카드 (glass-panel)", () => {
    const keys = [
      { id: "1", status: "active", groups: ["A"] },
      { id: "2", status: "active", groups: [] },
      { id: "3", status: "inactive", groups: ["A"] }
    ];
    const grid = renderKeyKpiRow(keys);
    assert.equal(grid.className, "grid grid-cols-4 gap-4 mb-8");
    const cards = grid.querySelectorAll(".glass-panel");
    assert.equal(cards.length, 4);
  });

  test("ACTIVE KEYS, REVOKED KEYS, TOTAL GROUPS, NO GROUP 라벨", () => {
    const keys = [{ id: "1", status: "active", groups: [] }];
    const grid = renderKeyKpiRow(keys);
    const labels = grid.querySelectorAll(".font-label").map(l => l.textContent);
    assert.ok(labels.includes("ACTIVE KEYS"));
    assert.ok(labels.includes("REVOKED KEYS"));
    assert.ok(labels.includes("TOTAL GROUPS"));
    assert.ok(labels.includes("NO GROUP"));
  });

  test("값에 font-headline text-3xl 사용", () => {
    const keys = [{ id: "1", status: "active", groups: [] }];
    const grid = renderKeyKpiRow(keys);
    const vals = grid.querySelectorAll(".text-3xl");
    assert.equal(vals.length, 4);
  });

  test("left accent bar 존재", () => {
    const keys = [];
    const grid = renderKeyKpiRow(keys);
    const bars = grid.querySelectorAll(".absolute");
    assert.equal(bars.length, 4);
  });
});

describe("renderKeyTable", () => {
  test("glass-panel wrapper", () => {
    const wrap = renderKeyTable([]);
    assert.ok(wrap.className.includes("glass-panel"));
  });

  test("8 columns in thead (including Fragments)", () => {
    const wrap = renderKeyTable([]);
    const ths = flatQuery(wrap, "th");
    assert.equal(ths.length, 8);
  });

  test("footer에 entry count 표시", () => {
    const keys = [
      { id: "k1", name: "A", status: "active" },
      { id: "k2", name: "B", status: "active" }
    ];
    const wrap = renderKeyTable(keys);
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(wrap);
    assert.ok(all.some(n => (n.textContent ?? "").includes("2 entries")));
  });
});

describe("renderKeyInspector", () => {
  beforeEach(() => { state.groups = []; });

  test("key=null이면 empty placeholder", () => {
    const panel = renderKeyInspector(null);
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "").includes("SELECT A KEY TO INSPECT")));
  });

  test("key identity card with border-l-2 border-primary", () => {
    const key = { id: "k1", name: "TestKey", key_prefix: "m_test", status: "active", today_calls: 10, created_at: "2024-01-01" };
    const panel = renderKeyInspector(key);
    const idCard = panel.querySelector(".border-l-2");
    assert.ok(idCard);
  });

  test("REVOKE KEY + DELETE PERMANENTLY 버튼", () => {
    const key = { id: "k1", name: "K", key_prefix: "m_k", status: "active" };
    const panel = renderKeyInspector(key);
    const buttons = flatQuery(panel, "button");
    const texts = buttons.map(b => b.textContent);
    assert.ok(texts.includes("REVOKE KEY"));
    assert.ok(texts.includes("DELETE PERMANENTLY"));
  });

  test("ASSIGNED GROUPS + ADD GROUP", () => {
    const key = { id: "k1", name: "K", key_prefix: "m_k", status: "active", groups: ["G1"] };
    const panel = renderKeyInspector(key);
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "").includes("ASSIGNED GROUPS")));
    assert.ok(all.some(n => (n.textContent ?? "").includes("ADD GROUP")));
  });
});

/* ================================================================
   Groups View
   ================================================================ */

describe("renderGroupKpiRow", () => {
  test("4개 KPI 카드 (glass-panel)", () => {
    const groups = [{ id: "g1", name: "A", member_count: 2 }];
    const keys = [{ id: "k1", groups: ["A"] }];
    const grid = renderGroupKpiRow(groups, keys);
    const cards = grid.querySelectorAll(".glass-panel");
    assert.equal(cards.length, 4);
  });

  test("TOTAL GROUPS, TOTAL MEMBERS, EMPTY GROUPS, UNASSIGNED KEYS", () => {
    const grid = renderGroupKpiRow([], []);
    const labels = grid.querySelectorAll(".font-label").map(l => l.textContent);
    assert.ok(labels.includes("TOTAL GROUPS"));
    assert.ok(labels.includes("TOTAL MEMBERS"));
    assert.ok(labels.includes("EMPTY GROUPS"));
    assert.ok(labels.includes("UNASSIGNED KEYS"));
  });
});

describe("renderGroupTable", () => {
  test("glass-panel wrapper", () => {
    const wrap = renderGroupTable([]);
    assert.ok(wrap.className.includes("glass-panel"));
  });

  test("5 columns", () => {
    const wrap = renderGroupTable([]);
    const ths = flatQuery(wrap, "th");
    assert.equal(ths.length, 5);
  });
});

describe("renderGroupInspector", () => {
  test("selected=null이면 empty placeholder", () => {
    const panel = renderGroupInspector(null, []);
    const all = [];
    function walk(n) { all.push(n); (n.children ?? []).forEach(walk); }
    walk(panel);
    assert.ok(all.some(n => (n.textContent ?? "").includes("SELECT A GROUP TO INSPECT")));
  });

  test("group identity card with border-l-2 border-secondary", () => {
    const group = { id: "g1", name: "TestGroup", description: "Test", member_count: 2 };
    const panel = renderGroupInspector(group, []);
    const idCard = panel.querySelector(".border-secondary");
    assert.ok(idCard);
  });

  test("ADD MEMBER + DELETE GROUP 버튼", () => {
    const group = { id: "g1", name: "G", member_count: 0 };
    const panel = renderGroupInspector(group, []);
    const buttons = flatQuery(panel, "button");
    const texts = buttons.map(b => b.textContent);
    assert.ok(texts.includes("ADD MEMBER"));
    assert.ok(texts.includes("DELETE GROUP"));
  });

  test("멤버 행에 권한 버튼 다섯 개가 있고 켜진 권한만 눌린 상태다", () => {
    const group  = { id: "g1", name: "G", member_count: 1 };
    const panel  = renderGroupInspector(group, [{ id: "k1", name: "K", key_prefix: "mmcp_", permissions: ["read", "amend"] }]);
    const perms  = flatQuery(panel, "button").filter(b => b.dataset?.memberPerm);
    assert.deepEqual(perms.map(b => b.textContent), ["read", "share", "link", "amend", "forget"]);
    assert.deepEqual(perms.filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.textContent), ["read", "amend"]);
  });

  test("권한 전환은 정해진 순서를 지키고 권한 열이 없는 멤버는 기본 권한에서 시작한다", () => {
    assert.deepEqual(togglePermission(["read", "amend"], "share"), ["read", "share", "amend"]);
    assert.deepEqual(togglePermission(undefined, "link"), ["read", "share"]);
  });
});

describe("그룹 파편 상한 입력과 표시", () => {
  test("빈 값은 상한 없음, 취소는 변경 없음, 정수가 아니면 거부 대상이다", () => {
    assert.equal(parseGroupLimitInput(""), null);
    assert.equal(parseGroupLimitInput(" 120 "), 120);
    assert.equal(parseGroupLimitInput(null), undefined);
    assert.ok(Number.isNaN(parseGroupLimitInput("-1")));
    assert.ok(Number.isNaN(parseGroupLimitInput("1.5")));
  });

  test("상한이 있으면 멤버 전체 파편 수와 함께 보여 준다", () => {
    assert.equal(groupLimitLabel({ fragment_limit: null }), "Fragment limit: none");
    assert.match(groupLimitLabel({ fragment_limit: 1000, fragment_count: 250 }), /Fragments 250 \/ 1,000/);
  });
});
