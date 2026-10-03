/**
 * 관리 콘솔 감사 로그 뷰 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 순수 함수(조회 조건 질의, 행위자와 대상 표기, detail 요약, 검증 요약)와 렌더 구조(서버 값을 textContent로
 * 넣는 표, 이어 보기 단추, 콘솔이 부르는 경로가 서버 라우트와 맞는지)를 본다.
 */

import { describe, it, beforeEach } from "node:test";
import assert                       from "node:assert/strict";
import { readFileSync }             from "node:fs";
import path                         from "node:path";
import { fileURLToPath }            from "node:url";
import { setupDom, flatQuery }      from "./admin-test-helper.js";

setupDom();

const {
  AUDIT_FILTER_FIELDS, buildAuditQuery, actorLabel, targetLabel, detailSummary, verifySummary, renderAudit
} = await import("../../assets/admin/modules/audit.js");
const { state } = await import("../../assets/admin/modules/state.js");

const ROOT       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE     = readFileSync(path.join(ROOT, "assets", "admin", "modules", "audit.js"), "utf8");
const SERVER     = readFileSync(path.join(ROOT, "lib", "admin", "admin-audit.js"), "utf8");
const ADMIN_JS   = readFileSync(path.join(ROOT, "assets", "admin", "admin.js"), "utf8");
const LAYOUT_JS  = readFileSync(path.join(ROOT, "assets", "admin", "modules", "layout.js"), "utf8");

const EVENT = {
  seq: 12, occurredAt: "2026-10-03T01:00:00.000Z", action: "admin.key.policy_update", outcome: "success",
  actorKind: "key", actorKeyId: "6f1c0f7e-4444-4000-8000-000000000005", targetType: "api_key", targetId: "k-1",
  detail: { changed: ["symbolic_hard_gate"], status: 200 }
};

/** 모든 하위 노드의 textContent를 모은다. */
function allText(node) {
  if (!node || typeof node !== "object") return typeof node === "string" ? node : "";
  return [node.textContent ?? "", ...(node.children ?? []).map(allText)].join(" ");
}

let responses;
beforeEach(() => {
  responses = [];
  state.auditFilter     = Object.fromEntries(AUDIT_FILTER_FIELDS.map(f => [f.key, ""]));
  state.auditEvents     = [];
  state.auditNextBefore = null;
  state.auditVerify     = null;
  global.fetch = async (url) => {
    responses.push(url);
    const body = { events: [EVENT], nextBefore: 12 };
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body };
  };
});

describe("조회 조건 질의", () => {
  it("빈 값은 빼고 커서와 쪽 크기를 붙인다", () => {
    const q = new URLSearchParams(buildAuditQuery({ action: " admin.* ", actor: "", outcome: "denied" }, { before: 40, limit: 50 }));
    assert.equal(q.get("action"), "admin.*");
    assert.equal(q.get("outcome"), "denied");
    assert.equal(q.has("actor"), false);
    assert.equal(q.get("before"), "40");
    assert.equal(q.get("limit"), "50");
  });

  it("내보내기용 질의는 쪽 크기를 넣지 않는다", () => {
    assert.equal(new URLSearchParams(buildAuditQuery({ actor: "master" }, { limit: null })).has("limit"), false);
  });

  it("입력 칸은 서버의 조회 매개변수 이름과 같다", () => {
    const store = readFileSync(path.join(ROOT, "lib", "logging", "AuditStore.js"), "utf8");
    for (const { key } of AUDIT_FILTER_FIELDS) assert.ok(store.includes(`"${key}"`), `AuditStore가 ${key}를 읽지 않는다`);
  });
});

describe("표기", () => {
  it("키 행위자는 앞 8자, 그 밖은 종류다", () => {
    assert.equal(actorLabel(EVENT), "key:6f1c0f7e");
    assert.equal(actorLabel({ actorKind: "master" }), "master");
  });

  it("대상은 유형:id, 없으면 -다", () => {
    assert.equal(targetLabel(EVENT), "api_key:k-1");
    assert.equal(targetLabel({ targetType: null }), "-");
  });

  it("detail 요약은 객체를 JSON으로 적고 길면 자른다", () => {
    assert.equal(detailSummary({ changed: ["a"], status: 200 }), 'changed=["a"], status=200');
    assert.ok(detailSummary({ note: "x".repeat(500) }).endsWith("..."));
    assert.equal(detailSummary({}), "-");
  });

  it("검증 요약은 끊김, 빈 표, 온전을 구분한다", () => {
    assert.match(verifySummary({ ok: false, checked: 3, broken: { seq: 4, reason: "row_hash_mismatch" } }), /seq 4/);
    assert.match(verifySummary({ ok: true, checked: 0 }), /없다/);
    assert.match(verifySummary({ ok: true, checked: 9, anchor: "genesis", complete: true }), /9행/);
  });
});

describe("렌더", () => {
  it("행을 표로 그리고 다음 쪽이 있으면 MORE 단추를 둔다", async () => {
    const container = globalThis.document.createElement("div");
    await renderAudit(container);
    assert.match(responses[0], /\/audit\?limit=50$/);
    const text = allText(container);
    assert.ok(text.includes("admin.key.policy_update"));
    assert.ok(text.includes("key:6f1c0f7e"));
    assert.ok(flatQuery(container, "#audit-more-btn").length === 1);
    for (const id of ["audit-refresh-btn", "audit-export-btn", "audit-verify-btn", "audit-apply-btn"]) {
      assert.equal(flatQuery(container, `#${id}`).length, 1, id);
    }
  });

  it("서버 값을 innerHTML로 넣지 않는다", () => {
    assert.doesNotMatch(SOURCE, /innerHTML/);
  });

  it("콘솔이 부르는 경로를 서버가 판정한다", () => {
    for (const route of ["/audit/export", "/audit/verify"]) {
      assert.ok(SOURCE.includes(route), `콘솔이 ${route}를 부르지 않는다`);
      assert.ok(SERVER.includes(`\${ADMIN_BASE}${route}`), `서버에 ${route} 판정이 없다`);
    }
  });

  it("뷰가 등록되고 사이드바에 있다", () => {
    assert.match(ADMIN_JS, /registerView\("audit",\s*renderAudit\)/);
    assert.match(LAYOUT_JS, /id: "audit"/);
  });
});
