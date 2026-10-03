/**
 * 관리 라우트 능력 집행 시험(가짜 요청과 응답)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * requireCapability와 authorizeAdminRoute가 라우트 표의 능력과 범위 종류로 판정하고, 거부면 403을 쓰며,
 * 허용이면 판정 범위를 요청에 묶는지 본다. 마스터 키 주체는 표의 모든 라우트와 표 밖 경로를 응답에 손대지
 * 않고 통과한다. auditor 판정의 응답은 내용 필드가 해시와 길이로 바뀐다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  requireCapability, authorizeAdminRoute, adminScopeOf, adminPrincipalOf, masterPrincipal, apiKeyPrincipal, decide
} from "../../lib/admin/AdminAuthz.js";
import { ADMIN_ROUTES } from "../../lib/admin/admin-route-table.js";
import { redactForPrincipal } from "../../lib/admin/admin-redact.js";

const SAMPLE = "6f1c0f7e-2222-4000-8000-000000000003";

function fakeRes() {
  return {
    statusCode: 200,
    body      : "",
    ended     : false,
    chunks    : [],
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    end(chunk = "") { this.body += chunk; this.ended = true; }
  };
}

const sampleOf = (p) => p.split("/").map((seg) => (seg.startsWith(":") ? SAMPLE : seg)).join("/");
const session  = (role, workspace = null) => ({ kind: "admin_session", id: `s-${role}`, bindings: [{ role, workspace }] });

/** 라우트 하나를 판정한다. */
function authorize(principal, method, subPath, query = "") {
  const req = {};
  const res = fakeRes();
  const ok  = authorizeAdminRoute(req, res, { principal, method, subPath, searchParams: new URLSearchParams(query) });
  return { ok, req, res };
}

describe("requireCapability", () => {
  it("허용이면 판정을 돌려주고 주체와 범위를 요청에 묶는다", () => {
    const req = {};
    const res = fakeRes();
    const p   = masterPrincipal();
    const d   = requireCapability(req, res, { principal: p, cap: "mem.read" });
    assert.equal(d.allowed, true);
    assert.equal(res.ended, false);
    assert.deepEqual(adminScopeOf(req), { all: true });
    assert.equal(adminPrincipalOf(req), p);
  });

  it("거부면 403과 능력, 거부 단계를 쓰고 null을 돌려준다", () => {
    const req = {};
    const res = fakeRes();
    const d   = requireCapability(req, res, { principal: session("viewer"), cap: "key.manage" });
    assert.equal(d, null);
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.cap, "key.manage");
    assert.equal(body.deniedAt, "capability");
    assert.equal(adminScopeOf(req), null);
  });

  it("판정을 거치지 않은 요청의 범위는 없다", () => {
    assert.equal(adminScopeOf({}), null);
    assert.equal(adminPrincipalOf({}), null);
  });
});

describe("authorizeAdminRoute", () => {
  it("마스터 키 주체는 표의 모든 라우트를 응답에 손대지 않고 통과한다", () => {
    for (const r of ADMIN_ROUTES) {
      const { ok, res } = authorize(masterPrincipal(), r.method, sampleOf(r.path));
      assert.equal(ok, true, `${r.method} ${r.path}`);
      assert.equal(res.ended, false);
      assert.equal(res.statusCode, 200);
    }
  });

  it("표 밖 경로는 owner만 통과한다", () => {
    assert.equal(authorize(masterPrincipal(), "DELETE", "/x|y;z").ok, true);
    const denied = authorize(session("admin"), "GET", "/no-such-route");
    assert.equal(denied.ok, false);
    assert.equal(denied.res.statusCode, 403);
  });

  it("라우트 표의 능력으로 판정한다", () => {
    assert.equal(authorize(session("viewer"), "GET", "/stats").ok, true);
    assert.equal(authorize(session("viewer"), "GET", "/keys").ok, false);
    assert.equal(authorize(session("admin"), "PATCH", `/keys/${SAMPLE}/policy`).ok, true);
    assert.equal(authorize(session("auditor"), "GET", "/audit/export").ok, true);
    assert.equal(authorize(session("auditor"), "POST", "/import").ok, false);
    assert.equal(authorize(session("admin"), "DELETE", `/memory/fragments/${SAMPLE}`).ok, true);
    assert.equal(authorize(session("reviewer"), "DELETE", `/memory/fragments/${SAMPLE}`).ok, false);
  });

  it("workspace 범위 라우트는 질의 매개변수 workspace를 대상으로 쓰고 범위를 요청에 묶는다", () => {
    const p = session("reviewer", "ws-a");
    const global = authorize(p, "GET", "/memory/fragments");
    assert.equal(global.ok, false);
    assert.equal(JSON.parse(global.res.body).deniedAt, "workspace");
    const scoped = authorize(p, "GET", "/memory/fragments", "workspace=ws-a");
    assert.equal(scoped.ok, true);
    assert.deepEqual(adminScopeOf(scoped.req), { all: false, workspaces: ["ws-a"] });
    assert.equal(authorize(p, "GET", "/memory/fragments", "workspace=ws-b").ok, false);
  });

  it("전역 범위 라우트는 workspace 매개변수가 있어도 전체 범위를 요구한다", () => {
    const p = session("viewer", "ws-a");
    assert.equal(authorize(p, "GET", "/stats", "workspace=ws-a").ok, false);
  });

  it("API 키 주체는 자기 정보 라우트만 통과한다", () => {
    const key = apiKeyPrincipal({ keyId: "k1", permissions: ["read", "write"], allowedWorkspaces: null });
    assert.equal(authorize(key, "GET", "/me").ok, true);
    assert.equal(authorize(key, "GET", "/me/explain").ok, true);
    for (const [method, subPath] of [["GET", "/activity"], ["GET", "/memory/fragments"], ["POST", "/memory/fragments"], ["GET", "/stats"]]) {
      const { ok, res } = authorize(key, method, subPath, "workspace=ws-a");
      assert.equal(ok, false, `${method} ${subPath}`);
      assert.equal(res.statusCode, 403);
    }
  });

  it("auditor의 기억 읽기 응답은 내용 필드를 해시와 길이로 바꾼다", () => {
    const { ok, res } = authorize(session("auditor"), "GET", "/activity");
    assert.equal(ok, true);
    res.end(JSON.stringify([{ id: "f1", preview: "secret text", key_name: "k" }]));
    const rows = JSON.parse(res.body);
    assert.equal(rows[0].id, "f1");
    assert.equal(rows[0].key_name, "k");
    assert.equal(rows[0].preview.redacted, true);
    assert.equal(rows[0].preview.length, 11);
    assert.match(rows[0].preview.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!res.body.includes("secret text"));
  });

  it("auditor 내보내기는 줄마다 내용을 가린다", () => {
    const { ok, res } = authorize(session("auditor"), "GET", "/export");
    assert.equal(ok, true);
    res.write(JSON.stringify({ kind: "fragment", content: "alpha" }) + "\n");
    res.end();
    const line = JSON.parse(res.chunks[0].trim());
    assert.equal(line.kind, "fragment");
    assert.equal(line.content.redacted, true);
  });

  it("마스킹 판정이 아니면 응답 메서드를 바꾸지 않는다", () => {
    const res    = fakeRes();
    const before = res.end;
    authorizeAdminRoute({}, res, { principal: session("admin"), method: "GET", subPath: "/activity", searchParams: new URLSearchParams() });
    assert.equal(res.end, before);
    res.end(JSON.stringify([{ preview: "plain" }]));
    assert.equal(JSON.parse(res.body)[0].preview, "plain");
  });
});

describe("redactForPrincipal", () => {
  const meta = decide(session("auditor"), "mem.read");
  const full = decide(session("owner"), "mem.read");

  it("마스킹 판정이 아니면 같은 값을 그대로 돌려준다", () => {
    const value = { content: "x" };
    assert.equal(redactForPrincipal(full, value), value);
    assert.equal(redactForPrincipal(null, value), value);
  });

  it("중첩 객체와 배열의 내용 필드를 가리고 나머지는 둔다", () => {
    const out = redactForPrincipal(meta, {
      fragment: { id: "a", content: "hello", keywords: ["k1", "k2"], importance: 0.5 },
      links   : [{ id: "b", preview: "linked" }],
      nodes   : [{ label: "lab", context_summary: null }]
    });
    assert.equal(out.fragment.id, "a");
    assert.equal(out.fragment.importance, 0.5);
    assert.equal(out.fragment.content.redacted, true);
    assert.equal(out.fragment.keywords.redacted, true);
    assert.equal(out.links[0].preview.redacted, true);
    assert.equal(out.nodes[0].label.redacted, true);
    assert.equal(out.nodes[0].context_summary, null);
    assert.ok(!JSON.stringify(out).includes("hello"));
  });
});
