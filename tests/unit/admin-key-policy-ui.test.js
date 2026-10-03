/**
 * 관리 콘솔 키 정책 카드 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 구조 검사: 키 상세에 세 정책 입력과 저장 단추가 있고, 저장이 서버의 실제 라우트를
 * 부르는지. 순수 함수 시험: 입력 상태에서 PATCH 본문을 만드는 규칙.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert                                     from "node:assert/strict";
import { readFileSync }                           from "node:fs";
import { fileURLToPath }                          from "node:url";
import path                                       from "node:path";
import { setupDom, flatQuery }                    from "./admin-test-helper.js";

setupDom();

const {
  renderKeyInspector,
  buildKeyPolicyPatch,
  parseWorkspaceLines,
  KEY_MODE_OPTIONS,
  KEY_WORKSPACE_LIMITS
} = await import("../../assets/admin/modules/keys.js");

const { listPresets, getPreset } = await import("../../lib/memory/ModeRegistry.js");
const { MAX_ALLOWED_WORKSPACES, MAX_WORKSPACE_LENGTH } = await import("../../lib/admin/key-policy.js");

const ROOT        = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEYS_SRC    = readFileSync(path.join(ROOT, "assets", "admin", "modules", "keys.js"), "utf8");
const ROUTES_SRC  = readFileSync(path.join(ROOT, "lib", "admin", "admin-keys.js"), "utf8");
const INDEX_HTML  = readFileSync(path.join(ROOT, "assets", "admin", "index.html"), "utf8");

const baseKey = { id: "k1", name: "K", key_prefix: "m_k", status: "active" };

const byId = (panel, id) => flatQuery(panel, `#${id}`)[0] ?? null;

describe("키 상세의 정책 카드 구조", () => {
  test("세 입력과 저장 단추가 있다", () => {
    const panel = renderKeyInspector(baseKey);
    for (const id of ["key-policy-default-mode", "key-policy-workspaces", "key-policy-restrict-workspaces", "key-policy-hard-gate", "key-policy-save"]) {
      assert.ok(byId(panel, id), `${id} 없음`);
    }
  });

  test("default_mode 선택지는 서버가 받는 preset과 일치한다", () => {
    const assignable = listPresets().filter((name) => getPreset(name).requiresMaster !== true).sort();
    assert.deepEqual([...KEY_MODE_OPTIONS].sort(), assignable);
    const select = byId(renderKeyInspector(baseKey), "key-policy-default-mode");
    const values = select.children.map((opt) => opt.value);
    assert.deepEqual(values, ["", ...KEY_MODE_OPTIONS]);
  });

  test("입력 한도는 서버 검증 한도와 같고 카드 문구에 쓰인다", () => {
    assert.equal(KEY_WORKSPACE_LIMITS.count, MAX_ALLOWED_WORKSPACES);
    assert.equal(KEY_WORKSPACE_LIMITS.length, MAX_WORKSPACE_LENGTH);
    const texts = [];
    (function walk(n) { texts.push(n.textContent ?? ""); (n.children ?? []).forEach(walk); })(renderKeyInspector(baseKey));
    assert.ok(texts.some((t) => t.includes(`${MAX_ALLOWED_WORKSPACES} entries of ${MAX_WORKSPACE_LENGTH} characters`)));
  });

  test("현재 키 값이 입력에 채워진다", () => {
    const key   = { ...baseKey, default_mode: "write-only", allowed_workspaces: ["a", "b"], symbolic_hard_gate: true };
    const panel = renderKeyInspector(key);
    assert.equal(byId(panel, "key-policy-default-mode").value, "write-only");
    assert.equal(byId(panel, "key-policy-restrict-workspaces").checked, true);
    assert.equal(byId(panel, "key-policy-workspaces").value, "a\nb");
    assert.equal(byId(panel, "key-policy-hard-gate").checked, true);
  });

  test("제한 없는 키는 workspace 입력이 꺼져 있다", () => {
    const panel = renderKeyInspector({ ...baseKey, default_mode: null, allowed_workspaces: null, symbolic_hard_gate: false });
    assert.equal(byId(panel, "key-policy-restrict-workspaces").checked, false);
    assert.equal(byId(panel, "key-policy-workspaces").disabled, true);
    assert.equal(byId(panel, "key-policy-default-mode").value, "");
  });
});

describe("저장 단추의 요청", () => {
  let calls;
  let reply;
  const realFetch = global.fetch;

  beforeEach(() => {
    calls = [];
    reply = { ok: false, status: 400, body: { error: "rejected" } };
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: reply.ok, status: reply.status, headers: { get: () => "application/json" }, json: async () => reply.body };
    };
  });
  afterEach(() => { global.fetch = realFetch; });

  const click = (panel) => byId(panel, "key-policy-save")._listeners.click[0]();

  test("바뀐 필드만 PATCH /keys/:id/policy로 보낸다", async () => {
    const panel = renderKeyInspector({ ...baseKey, default_mode: null, allowed_workspaces: null, symbolic_hard_gate: false });
    byId(panel, "key-policy-hard-gate").checked = true;
    await click(panel);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/v1/internal/model/nothing/keys/k1/policy");
    assert.equal(calls[0].options.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0].options.body), { symbolic_hard_gate: true });
  });

  test("세 필드를 모두 바꾸면 한 요청에 담는다", async () => {
    const panel = renderKeyInspector({ ...baseKey, default_mode: null, allowed_workspaces: null, symbolic_hard_gate: false });
    byId(panel, "key-policy-default-mode").value = "recall-only";
    byId(panel, "key-policy-restrict-workspaces").checked = true;
    byId(panel, "key-policy-workspaces").value = "alpha\n beta \n\nalpha";
    byId(panel, "key-policy-hard-gate").checked = true;
    await click(panel);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      default_mode: "recall-only", allowed_workspaces: ["alpha", "beta"], symbolic_hard_gate: true
    });
  });

  test("바뀐 값이 없으면 요청하지 않는다", async () => {
    await click(renderKeyInspector(baseKey));
    assert.equal(calls.length, 0);
  });
});

describe("buildKeyPolicyPatch", () => {
  const key  = { default_mode: "recall-only", allowed_workspaces: ["a"], symbolic_hard_gate: false };
  const same = { defaultMode: "recall-only", restrict: true, workspacesText: "a", hardGate: false };

  test("같은 입력은 빈 본문", () => {
    assert.deepEqual(buildKeyPolicyPatch(key, same), {});
  });

  test("mode 해제는 null", () => {
    assert.deepEqual(buildKeyPolicyPatch(key, { ...same, defaultMode: "" }), { default_mode: null });
  });

  test("제한 해제는 null, 제한하고 비우면 빈 배열", () => {
    assert.deepEqual(buildKeyPolicyPatch(key, { ...same, restrict: false }), { allowed_workspaces: null });
    assert.deepEqual(buildKeyPolicyPatch(key, { ...same, workspacesText: "" }), { allowed_workspaces: [] });
    assert.deepEqual(buildKeyPolicyPatch({ ...key, allowed_workspaces: null }, { ...same, restrict: true, workspacesText: "" }), { allowed_workspaces: [] });
  });

  test("정책 열이 없는 키는 기본값(null, null, false)과 비교한다", () => {
    assert.deepEqual(buildKeyPolicyPatch({}, { defaultMode: "", restrict: false, workspacesText: "", hardGate: false }), {});
  });

  test("workspace 순서가 바뀌면 변경으로 본다", () => {
    const two = { ...key, allowed_workspaces: ["a", "b"] };
    assert.deepEqual(buildKeyPolicyPatch(two, { ...same, workspacesText: "b\na" }), { allowed_workspaces: ["b", "a"] });
  });
});

describe("parseWorkspaceLines", () => {
  test("줄 단위로 나누고 공백, 빈 줄, 중복을 버린다", () => {
    assert.deepEqual(parseWorkspaceLines(" a \r\n\r\nb\na\n"), ["a", "b"]);
  });

  test("쉼표는 구분자가 아니다", () => {
    assert.deepEqual(parseWorkspaceLines("a,b"), ["a,b"]);
  });

  test("비어 있는 입력은 빈 배열", () => {
    assert.deepEqual(parseWorkspaceLines(""), []);
    assert.deepEqual(parseWorkspaceLines(undefined), []);
  });
});

describe("콘솔과 서버의 정합", () => {
  test("저장 호출 경로가 서버 라우트 표에 PATCH로 있다", () => {
    assert.match(KEYS_SRC, /api\("\/keys\/" \+ key\.id \+ "\/policy", \{ method: "PATCH"/);
    assert.match(ROUTES_SRC, /method: "PATCH",\s*match: regex\(new RegExp\(`\^\$\{ADMIN_BASE\}\/keys\/\(\[\^\/\]\+\)\/policy\$`\)\),\s*handler: setKeyPolicy/);
  });

  test("콘솔 소스에 인라인 핸들러와 외부 호스트가 없다", () => {
    assert.doesNotMatch(KEYS_SRC, /\bon(click|change|input)\s*=/i);
    assert.doesNotMatch(KEYS_SRC, /https?:\/\//);
    assert.doesNotMatch(INDEX_HTML, /<script[^>]+src="(?:https?:)?\/\//);
  });
});
