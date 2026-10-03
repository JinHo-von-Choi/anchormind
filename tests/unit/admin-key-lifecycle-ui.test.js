/**
 * 관리 콘솔 키 수명 카드 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 구조 검사: 키 상세에 수명 입력, 회전, 폐기, 접근 검토 단추가 있고, 폐기한 키에는 회전과 폐기 단추가 없다.
 * 단추가 서버 라우트 표에 있는 경로를 부르는지 확인한다. 순수 함수 시험: 입력 상태에서 PATCH 본문을 만드는 규칙.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert                                     from "node:assert/strict";
import { setupDom, flatQuery }                    from "./admin-test-helper.js";

setupDom();

const { renderKeyInspector }                         = await import("../../assets/admin/modules/keys.js");
const { buildKeyLifecyclePatch, KEY_LIFECYCLE_LIMITS, rotateConfirmLabel, ROTATE_NOTE } = await import("../../assets/admin/modules/key-lifecycle.js");
const { MAX_ALLOWED_CIDRS }                          = await import("../../lib/admin/key-cidr.js");
const { KEY_OWNER_MAX, KEY_DESCRIPTION_MAX, KEY_REVOKE_REASON_MAX } = await import("../../lib/admin/key-lifecycle.js");
const { ADMIN_AUDIT_ACTIONS }                        = await import("../../lib/admin/admin-audit-actions.js");

const baseKey = { id: "k1", name: "K", key_prefix: "m_k", status: "active" };
const byId    = (panel, id) => flatQuery(panel, `#${id}`)[0] ?? null;
const blank   = { expiresAt: "", owner: "", kind: "", description: "", restrictAddresses: false, cidrsText: "" };

describe("키 수명 카드 구조", () => {
  test("수명 입력과 회전, 폐기, 접근 검토 단추가 있다", () => {
    const panel = renderKeyInspector(baseKey);
    for (const id of ["key-lifecycle-expires", "key-lifecycle-owner", "key-lifecycle-kind", "key-lifecycle-description",
      "key-lifecycle-restrict-addresses", "key-lifecycle-cidrs", "key-lifecycle-save", "key-lifecycle-grace-hours",
      "key-lifecycle-rotate", "key-lifecycle-revoke-reason", "key-lifecycle-revoke", "key-lifecycle-review"]) {
      assert.ok(byId(panel, id), `${id} 없음`);
    }
  });

  test("폐기한 키에는 회전과 폐기 단추가 없고 폐기 정보가 보인다", () => {
    const panel = renderKeyInspector({ ...baseKey, status: "inactive", revoked_at: "2026-10-03T00:00:00Z", revoked_by: "master:bearer", revoke_reason: "leak" });
    assert.equal(byId(panel, "key-lifecycle-rotate"), null);
    assert.equal(byId(panel, "key-lifecycle-revoke"), null);
    assert.ok(byId(panel, "key-lifecycle-review"));
    const texts = [];
    (function walk(n) { texts.push(n.textContent ?? ""); (n.children ?? []).forEach(walk); })(panel);
    assert.ok(texts.some((t) => t.startsWith("REVOKED ") && t.includes("leak")));
  });

  test("현재 값이 입력에 채워지고 대역이 없으면 대역 입력이 꺼진다", () => {
    const panel = renderKeyInspector({ ...baseKey, expires_at: "2027-01-01T00:00:00Z", owner: "team", allowed_cidrs: ["192.0.2.0/24"] });
    assert.equal(byId(panel, "key-lifecycle-expires").value, "2027-01-01T00:00:00.000Z");
    assert.equal(byId(panel, "key-lifecycle-owner").value, "team");
    assert.equal(byId(panel, "key-lifecycle-cidrs").value, "192.0.2.0/24");
    assert.equal(byId(panel, "key-lifecycle-restrict-addresses").checked, true);
    assert.equal(byId(renderKeyInspector(baseKey), "key-lifecycle-cidrs").disabled, true);
  });

  test("입력 한도는 서버 검증 한도와 같다", () => {
    assert.equal(KEY_LIFECYCLE_LIMITS.cidrs, MAX_ALLOWED_CIDRS);
    assert.equal(KEY_LIFECYCLE_LIMITS.owner, KEY_OWNER_MAX);
    assert.equal(KEY_LIFECYCLE_LIMITS.description, KEY_DESCRIPTION_MAX);
    assert.equal(KEY_LIFECYCLE_LIMITS.reason, KEY_REVOKE_REASON_MAX);
  });

  test("카드가 부르는 경로는 감사 선언이 있는 관리 라우트다", () => {
    for (const [method, path] of [["PATCH", "/keys/:id"], ["POST", "/keys/:id/rotate"], ["POST", "/keys/:id/revoke"], ["POST", "/keys/:id/access-review"]]) {
      assert.ok(ADMIN_AUDIT_ACTIONS.some((a) => a.module === "admin-keys" && a.method === method && a.path === path), `${method} ${path}`);
    }
  });
});

describe("수명 PATCH 본문", () => {
  test("바뀐 필드만 담는다", () => {
    assert.deepEqual(buildKeyLifecyclePatch(baseKey, blank), {});
    assert.deepEqual(buildKeyLifecyclePatch(baseKey, { ...blank, owner: " team " }), { owner: "team" });
    assert.deepEqual(buildKeyLifecyclePatch({ ...baseKey, owner: "team" }, { ...blank, owner: "" }), { owner: null });
  });

  test("같은 시각의 다른 표기는 변경이 아니다", () => {
    const key = { ...baseKey, expires_at: "2027-01-01T00:00:00Z" };
    assert.deepEqual(buildKeyLifecyclePatch(key, { ...blank, expiresAt: "2027-01-01T09:00:00+09:00" }), {});
    assert.deepEqual(buildKeyLifecyclePatch(key, { ...blank, expiresAt: "" }), { expires_at: null });
  });

  test("대역 제한 해제는 null, 빈 목록은 빈 배열이다", () => {
    const key = { ...baseKey, allowed_cidrs: ["192.0.2.0/24"] };
    assert.deepEqual(buildKeyLifecyclePatch(key, { ...blank, restrictAddresses: false }), { allowed_cidrs: null });
    assert.deepEqual(buildKeyLifecyclePatch(key, { ...blank, restrictAddresses: true, cidrsText: "" }), { allowed_cidrs: [] });
    assert.deepEqual(buildKeyLifecyclePatch(key, { ...blank, restrictAddresses: true, cidrsText: " 192.0.2.0/24 \n" }), {});
  });
});

describe("단추의 요청", () => {
  let calls;
  const realFetch = global.fetch;

  beforeEach(() => {
    calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: false, status: 400, headers: { get: () => "application/json" }, json: async () => ({ error: "rejected" }) };
    };
  });
  afterEach(() => { global.fetch = realFetch; });

  const click = (panel, id) => byId(panel, id)._listeners.click[0]();

  test("저장은 PATCH /keys/:id로 바뀐 필드만 보낸다", async () => {
    const panel = renderKeyInspector(baseKey);
    byId(panel, "key-lifecycle-kind").value = "service";
    await click(panel, "key-lifecycle-save");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/v1/internal/model/nothing/keys/k1");
    assert.equal(calls[0].options.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0].options.body), { kind: "service" });
  });

  test("회전은 두 번 눌러야 보내고, 겹침 시간을 비우면 본문 없이, 넣으면 graceHours로 보낸다", async () => {
    const panel = renderKeyInspector(baseKey);
    await click(panel, "key-lifecycle-rotate");
    assert.equal(calls.length, 0, "첫 클릭은 확인 요청");
    assert.match(byId(panel, "key-lifecycle-rotate").textContent, /^CONFIRM ROTATE/);
    await click(panel, "key-lifecycle-rotate");
    byId(panel, "key-lifecycle-grace-hours").value = "6";
    await click(panel, "key-lifecycle-rotate");
    await click(panel, "key-lifecycle-rotate");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "/v1/internal/model/nothing/keys/k1/rotate");
    assert.deepEqual(JSON.parse(calls[0].options.body), {});
    assert.deepEqual(JSON.parse(calls[1].options.body), { graceHours: 6 });
  });

  test("회전 확인 문구는 겹침 0이면 즉시 종료를 알린다", () => {
    assert.match(rotateConfirmLabel("0"), /END NOW/);
    assert.match(rotateConfirmLabel("6"), /6 HOURS/);
    assert.match(ROTATE_NOTE, /every session and OAuth token/);
  });

  test("오프셋 없는 만료 시각은 보내지 않는다", async () => {
    for (const bad of ["2027-01-01T00:00:00", "1", "March 7, 2027"]) {
      const panel = renderKeyInspector(baseKey);
      byId(panel, "key-lifecycle-expires").value = bad;
      await click(panel, "key-lifecycle-save");
    }
    assert.equal(calls.length, 0);
    const panel = renderKeyInspector(baseKey);
    byId(panel, "key-lifecycle-expires").value = "2027-01-01T09:00:00+09:00";
    await click(panel, "key-lifecycle-save");
    assert.equal(calls.length, 1);
  });

  test("폐기는 사유가 있어야 하고 두 번 눌러야 보낸다", async () => {
    const panel = renderKeyInspector(baseKey);
    await click(panel, "key-lifecycle-revoke");
    assert.equal(calls.length, 0, "사유 없음");
    byId(panel, "key-lifecycle-revoke-reason").value = "leak";
    await click(panel, "key-lifecycle-revoke");
    assert.equal(calls.length, 0, "첫 클릭은 확인 요청");
    await click(panel, "key-lifecycle-revoke");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/v1/internal/model/nothing/keys/k1/revoke");
    assert.deepEqual(JSON.parse(calls[0].options.body), { reason: "leak" });
  });

  test("접근 검토는 POST /keys/:id/access-review다", async () => {
    await click(renderKeyInspector(baseKey), "key-lifecycle-review");
    assert.equal(calls[0].url, "/v1/internal/model/nothing/keys/k1/access-review");
    assert.equal(calls[0].options.method, "POST");
  });
});
