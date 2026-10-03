/**
 * 관리 라우트 감사 행위 선언 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 상태를 바꾸는 관리 라우트(GET이 아닌 요청)는 lib/admin/admin-audit-actions.js에 감사 행위를 선언한다.
 * 소스를 정적으로 읽어 본다.
 *   1. admin-keys.js 라우트 표의 비GET 항목마다 대표 경로가 admin-keys 선언으로 판정된다.
 *   2. if 분기로 라우트를 판정하는 모듈은 소스의 비GET 메서드 비교 수가 메서드별로 선언 수와 같다.
 *   3. 선언은 서로 가리지 않고, 행위 이름은 형식에 맞고 겹치지 않으며, 선언 모듈 파일이 있다.
 * 행위 이름 목록 전체를 고정하지 않는다. 새 비GET 라우트를 선언 없이 추가하면 실패한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path             from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN_AUDIT_ACTIONS, ADMIN_AUDIT_FALLBACK_ACTION, findAdminAuditAction, adminAuditEvent,
  noteAdminAudit, takeAdminAuditNote
} from "../../lib/admin/admin-audit-actions.js";
import { isValidAuditAction } from "../../lib/logging/audit-event.js";

const ROOT      = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADMIN_DIR = path.join(ROOT, "lib", "admin");
const BASE      = "${ADMIN_BASE}";
const SAMPLE_ID = "6f1c0f7e-2222-4000-8000-000000000003";
const MUTATING  = ["POST", "PUT", "PATCH", "DELETE"];

const source = (name) => readFileSync(path.join(ADMIN_DIR, `${name}.js`), "utf8");

/** admin-keys.js 라우트 표의 (메서드, 대표 경로) */
function keyRoutes() {
  const line = /\{\s*method:\s*"([A-Z]+)",\s*match:\s*(?:exact|regex)\((?:new RegExp\()?`([^`]+)`\)?\)/g;
  return [...source("admin-keys").matchAll(line)].map(([, method, raw]) => ({
    method,
    sample: raw.replace(BASE, "").replace(/^\^/, "").replace(/\$$/, "").replace(/\(\[\^\/\]\+\)/g, SAMPLE_ID)
  }));
}

/** if 분기 모듈의 비GET 메서드 비교 수(메서드별) */
function methodComparisons(name) {
  const counts = {};
  for (const [, method] of source(name).matchAll(/req\.method\s*(?:===|!==)\s*"([A-Z]+)"/g)) {
    if (MUTATING.includes(method)) counts[method] = (counts[method] ?? 0) + 1;
  }
  return counts;
}

/** 선언의 모듈별 비GET 메서드 수 */
function declaredMethods(name) {
  const counts = {};
  for (const e of ADMIN_AUDIT_ACTIONS.filter(a => a.module === name && MUTATING.includes(a.method))) {
    counts[e.method] = (counts[e.method] ?? 0) + 1;
  }
  return counts;
}

/** 선언 경로의 대표 경로 */
const sampleOf = (p) => p.split("/").map(seg => (seg.startsWith(":") ? SAMPLE_ID : seg)).join("/");

describe("비GET 관리 라우트의 감사 행위 선언", () => {
  it("admin-keys 라우트 표의 비GET 항목마다 선언이 있다", () => {
    const routes = keyRoutes().filter(r => MUTATING.includes(r.method));
    assert.ok(routes.length >= 10, `추출된 비GET 라우트가 ${routes.length}건뿐이다`);
    for (const r of routes) {
      const found = findAdminAuditAction(r.method, r.sample);
      assert.ok(found, `${r.method} ${r.sample} 선언 없음`);
      assert.equal(found.entry.module, "admin-keys", `${r.method} ${r.sample}`);
    }
  });

  it("admin-keys 선언 수가 라우트 표의 비GET 항목 수와 같다", () => {
    const table = keyRoutes().filter(r => MUTATING.includes(r.method)).length;
    assert.equal(ADMIN_AUDIT_ACTIONS.filter(a => a.module === "admin-keys" && MUTATING.includes(a.method)).length, table);
  });

  for (const name of ["admin-memory", "admin-sessions", "admin-export", "admin-routes", "admin-audit"]) {
    it(`${name}의 비GET 메서드 비교 수와 선언 수가 메서드별로 같다`, () => {
      assert.deepEqual(methodComparisons(name), declaredMethods(name));
    });
  }

  it("비GET 라우트를 판정하는 관리 모듈은 모두 위 검사 대상이다", () => {
    const covered = new Set(["admin-keys", "admin-memory", "admin-sessions", "admin-export", "admin-routes", "admin-audit"]);
    for (const file of readdirSync(ADMIN_DIR).filter(f => f.endsWith(".js") && f !== "admin-audit-actions.js" && f !== "admin-route-table.js")) {
      const name = file.replace(/\.js$/, "");
      const text = source(name);
      const hasMutating = MUTATING.some(m => text.includes(`req.method === "${m}"`) || text.includes(`req.method !== "${m}"`) || text.includes(`method: "${m}"`));
      if (hasMutating) assert.ok(covered.has(name), `${name}에 비GET 라우트가 있지만 검사 대상이 아니다`);
    }
  });
});

describe("선언 표", () => {
  it("행위 이름은 형식에 맞고 겹치지 않는다", () => {
    const seen = new Set();
    for (const e of ADMIN_AUDIT_ACTIONS) {
      assert.ok(isValidAuditAction(e.action), e.action);
      assert.ok(!seen.has(e.action), `중복 ${e.action}`);
      seen.add(e.action);
    }
    assert.ok(isValidAuditAction(ADMIN_AUDIT_FALLBACK_ACTION));
  });

  it("선언 모듈 파일이 있다", () => {
    for (const e of ADMIN_AUDIT_ACTIONS) assert.ok(existsSync(path.join(ADMIN_DIR, `${e.module}.js`)), e.module);
  });

  it("모든 선언이 자기 대표 경로를 스스로 판정한다(앞 선언이 가리지 않는다)", () => {
    for (const e of ADMIN_AUDIT_ACTIONS) {
      assert.equal(findAdminAuditAction(e.method, sampleOf(e.path))?.entry.action, e.action, `${e.method} ${e.path}`);
    }
  });
});

describe("감사 이벤트 값", () => {
  const actor = { keyId: "master", sessionId: "c1234567", clientIp: "127.0.0.1" };

  it("선언의 행위와 첫 경로 변수를 대상으로 쓰고 상태와 가린 경로를 detail에 둔다", () => {
    const event = adminAuditEvent({
      method: "PATCH", subPath: `/keys/${SAMPLE_ID}/policy`, maskedPath: "/keys/6f1c0f7e/policy",
      status: 200, outcome: "success", actor
    });
    assert.equal(event.action, "admin.key.policy_update");
    assert.deepEqual(event.target, { type: "api_key", id: SAMPLE_ID });
    assert.deepEqual(event.detail, { method: "PATCH", path: "/keys/6f1c0f7e/policy", status: 200 });
  });

  it("세션 대상은 앞 8자만 남긴다", () => {
    const event = adminAuditEvent({ method: "DELETE", subPath: `/sessions/${SAMPLE_ID}`, maskedPath: "/sessions/6f1c0f7e", status: 200, outcome: "success", actor });
    assert.deepEqual(event.target, { type: "session", id: SAMPLE_ID.slice(0, 8) });
  });

  it("처리기 메모의 대상 id와 detail을 합친다", () => {
    const res = {};
    noteAdminAudit(res, { targetId: "new-key-id", detail: { permissions: ["read"] } });
    noteAdminAudit(res, { detail: { daily_limit: 10 } });
    const note  = takeAdminAuditNote(res);
    const event = adminAuditEvent({ method: "POST", subPath: "/keys", maskedPath: "/keys", status: 201, outcome: "success", actor, note });
    assert.deepEqual(event.target, { type: "api_key", id: "new-key-id" });
    assert.deepEqual(event.detail, { permissions: ["read"], daily_limit: 10, method: "POST", path: "/keys", status: 201 });
    assert.deepEqual(takeAdminAuditNote(res), { targetId: null, detail: {} });
  });

  it("선언이 없는 요청은 대체 행위로 남는다", () => {
    const event = adminAuditEvent({ method: "POST", subPath: "/nothing-here", maskedPath: "/nothing-here", status: 404, outcome: "failure", actor });
    assert.equal(event.action, ADMIN_AUDIT_FALLBACK_ACTION);
    assert.equal(event.target, null);
  });
});
