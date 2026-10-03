/**
 * 관리 라우트 능력 집행 시험(가짜 요청과 응답)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * requireCapability와 authorizeAdminRoute가 라우트 표의 능력과 범위 종류로 판정하고, 거부면 403을 쓰며,
 * 허용이면 판정 범위를 요청에 묶는지 본다. 마스터 키 주체는 표의 모든 라우트와 표 밖 경로를 응답에 손대지
 * 않고 통과한다. auditor 판정의 응답은 허용 목록(식별자, 열거 값, 시각, 수치) 밖의 값이 해시와 길이로 바뀐다.
 * 마스킹 방식은 대상 workspace를 덮는 바인딩에서만 고르고, 질의 범위는 그 방식을 준 바인딩으로 좁힌다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  requireCapability, authorizeAdminRoute, adminScopeOf, adminPrincipalOf, masterPrincipal, apiKeyPrincipal, decide,
  requireFullScope
} from "../../lib/admin/AdminAuthz.js";
import { ADMIN_ROUTES } from "../../lib/admin/admin-route-table.js";
import { redactForPrincipal, REDACT_ALLOWED_FIELDS } from "../../lib/admin/admin-redact.js";

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

  it("세션 id 형식이 아닌 경로(GET /sessions/purge)는 /sessions/:id의 능력을 물려받지 않고 owner만 통과한다", () => {
    assert.equal(authorize(session("viewer"), "GET", `/sessions/${SAMPLE}`).ok, true);
    assert.equal(authorize(session("viewer"), "GET", "/sessions/purge").ok, false);
    assert.equal(authorize(session("admin"), "DELETE", "/sessions/purge").ok, false);
    assert.equal(authorize(masterPrincipal(), "GET", "/sessions/purge").ok, true);
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

  it("auditor의 기억 읽기 응답은 허용 목록 밖의 값을 해시와 길이로 바꾼다", () => {
    const { ok, res } = authorize(session("auditor"), "GET", "/activity");
    assert.equal(ok, true);
    res.end(JSON.stringify([{ id: "f1", preview: "secret text", key_name: "k" }]));
    const rows = JSON.parse(res.body);
    assert.equal(rows[0].id, "f1");
    assert.equal(rows[0].key_name.redacted, true);
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

describe("마스킹 방식과 질의 범위는 대상을 덮는 바인딩에서 정한다", () => {
  const mixed = { kind: "admin_session", id: "s-mixed", bindings: [{ role: "viewer", workspace: "ws-a" }, { role: "auditor", workspace: null }] };

  it("대상 workspace를 덮는 W 바인딩이 있으면 마스킹하지 않고 질의 범위는 그 workspace 하나다", () => {
    const d = decide(mixed, "mem.read", { workspace: "ws-a" });
    assert.equal(d.redact, false);
    assert.deepEqual(d.scope, { all: false, workspaces: ["ws-a"] });
  });

  it("다른 workspace와 전역 대상은 전역 auditor 바인딩만 덮으므로 마스킹이다", () => {
    for (const target of [{ workspace: "ws-b" }, {}]) {
      const d = decide(mixed, "mem.read", target);
      assert.equal(d.allowed, true);
      assert.equal(d.redact, true, JSON.stringify(target));
    }
  });

  it("라우트 판정: ws-b 목록은 가리고, ws-a 목록은 ws-a로만 걸러 그대로 보낸다", () => {
    const b = authorize(mixed, "GET", "/memory/fragments", "workspace=ws-b");
    b.res.end(JSON.stringify({ items: [{ id: "x", content: "clear b" }] }));
    assert.ok(!b.res.body.includes("clear b"));
    const a = authorize(mixed, "GET", "/memory/fragments", "workspace=ws-a");
    assert.deepEqual(adminScopeOf(a.req), { all: false, workspaces: ["ws-a"] });
  });

  it("owner는 workspace 매개변수가 있어도 질의 범위가 전체다", () => {
    assert.deepEqual(decide(masterPrincipal(), "mem.read", { workspace: "ws-a" }).scope, { all: true });
  });
});

describe("requireFullScope", () => {
  it("질의 범위가 전체일 때만 통과하고 그 밖은 403이다", () => {
    const full = authorize(masterPrincipal(), "GET", "/stats");
    assert.equal(requireFullScope(full.req, full.res), true);
    const part = authorize(session("reviewer", "ws-a"), "GET", "/memory/fragments", "workspace=ws-a");
    assert.equal(requireFullScope(part.req, part.res), false);
    assert.equal(part.res.statusCode, 403);
    const none = fakeRes();
    assert.equal(requireFullScope({}, none), false);
    assert.equal(JSON.parse(none.body).reason, "full_scope_required");
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

  it("중첩 객체와 배열에서 허용 목록 밖의 문자열을 가리고 식별자, 열거 값, 시각, 수치는 둔다", () => {
    const out = redactForPrincipal(meta, {
      fragment: { id: "a", type: "fact", content: "hello", keywords: ["k1", "k2"], importance: 0.5, created_at: "2026-10-03T01:02:03.123Z" },
      links   : [{ id: "b", relation_type: "related", preview: "linked" }],
      nodes   : [{ label: "lab", context_summary: null, is_anchor: true }],
      total   : "42"
    });
    assert.equal(out.fragment.id, "a");
    assert.equal(out.fragment.type, "fact");
    assert.equal(out.fragment.importance, 0.5);
    assert.equal(out.fragment.created_at, "2026-10-03T01:02:03.123Z");
    assert.equal(out.fragment.content.redacted, true);
    assert.ok(out.fragment.keywords.every((k) => k.redacted === true));
    assert.equal(out.links[0].relation_type, "related");
    assert.equal(out.links[0].preview.redacted, true);
    assert.equal(out.nodes[0].label.redacted, true);
    assert.equal(out.nodes[0].context_summary, null);
    assert.equal(out.nodes[0].is_anchor, true);
    assert.equal(out.total, "42");
    assert.ok(!JSON.stringify(out).includes("hello"));
  });

  it("목록에 없는 자유 서술 필드(goal, outcome, quality_rationale, suggestion, topic, agent_id)는 가린다", () => {
    const row = { goal: "g secret", outcome: "o secret", quality_rationale: "q secret", suggestion: "s secret", topic: "t secret", agent_id: "a secret" };
    const out = redactForPrincipal(meta, row);
    for (const key of Object.keys(row)) assert.equal(out[key].redacted, true, key);
    assert.ok(!JSON.stringify(out).includes("secret"));
  });

  it("허용 필드라도 형식에 맞지 않는 적대적 값은 가린다", () => {
    const hostile = {
      id          : "secret plan with spaces",
      type        : "Secret Text",
      created_at  : "2026-10-03 then the password is hunter2",
      valid_to    : "hunter2",
      key_id      : "a/../../b",
      count       : "hunter2",
      content     : "4821",
      relation_type: "x".repeat(64)
    };
    const out = redactForPrincipal(meta, hostile);
    for (const key of Object.keys(hostile)) assert.equal(out[key].redacted, true, key);
    assert.ok(!JSON.stringify(out).includes("hunter2"));
    assert.ok(!JSON.stringify(out).includes("4821"));
  });

  it("식별자 형식이 아닌 객체 키는 해시 이름으로 바꾸고 그 값도 가린다", () => {
    const out = redactForPrincipal(meta, { byTopic: { "my secret topic": 3, "id": "ok-1" } });
    const keys = Object.keys(out.byTopic);
    assert.ok(keys.includes("id"));
    assert.ok(keys.every((k) => !k.includes("secret")));
    assert.ok(keys.some((k) => /^redacted_[0-9a-f]{12}$/.test(k)));
  });

  it("허용 목록은 한 표에 있고 필드마다 형식 검사기를 가진다", () => {
    for (const [field, format] of Object.entries(REDACT_ALLOWED_FIELDS)) {
      assert.ok(format instanceof RegExp, field);
      assert.equal(format.test("free text with spaces"), false, field);
    }
  });
});
