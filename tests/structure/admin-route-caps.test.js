/**
 * 관리 라우트 능력 선언 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 * 수정일: 2026-10-04
 *
 * 관리 API 라우트 표(lib/admin/admin-route-table.js)를 본다.
 *   1. 항목마다 능력(cap), 범위 종류(scope), 감사(audit) 세 값이 형식에 맞는다. 능력 없는 항목은 0이다.
 *   2. 관리 모듈 소스에서 읽은 (메서드, 경로)마다 그 모듈의 같은 메서드 항목이 있고, 항목마다 소스에 같은
 *      메서드의 경로가 있다. 경로만 맞고 메서드가 다른 항목은 대응으로 치지 않는다.
 *   3. 관리 모듈이 비교하는 HTTP 메서드는 그 모듈의 표 항목에 있다.
 * 경로 목록 전체를 고정하지 않는다. 처리기에 라우트를 더하면서 표에 항목을 더하지 않으면 실패한다.
 * 마지막 묶음은 소스를 고쳐 넣은 변형으로 검사가 누락을 잡는지 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path             from "node:path";

import { ROOT } from "./_source-scan.js";
import { SAMPLE, routePairs, uncoveredRoutes } from "./_admin-checks.js";
import {
  ADMIN_ROUTES, ROUTE_SCOPES, findAdminRoute, compileRoutePath, isRateLimitedAdminRequest, RouteTableError
} from "../../lib/admin/admin-route-table.js";
import { CAPABILITIES, CAP_PUBLIC, CAP_AUTHENTICATED } from "../../lib/admin/capabilities.js";
import { isValidAuditAction } from "../../lib/logging/audit-event.js";

const ADMIN_DIR = path.join(ROOT, "lib", "admin");
const MARKERS   = new Set([CAP_PUBLIC, CAP_AUTHENTICATED]);

/** 라우트 표 밖의 관리 모듈(선언, 저장소, 도우미) */
const NON_ROUTE_MODULES = new Set([
  "admin-route-table", "admin-audit-actions", "capabilities", "AdminAuthz", "ScopeFilter", "admin-auth",
  "admin-login-guard", "admin-metrics", "ApiKeyStore", "OAuthClientStore", "key-policy", "key-state-cache",
  "admin-principal", "admin-redact"
]);

const sampleOf = (p) => p.split("/").map((seg) => (seg.startsWith(":") ? SAMPLE : seg)).join("/");
const sourceOf = (module) => readFileSync(path.join(ADMIN_DIR, `${module}.js`), "utf8");

/** 표에 오른 처리 모듈 */
const routeModules = [...new Set(ADMIN_ROUTES.map((r) => r.module))];

describe("관리 라우트 표 항목 형식", () => {
  it("항목마다 cap, scope, audit 세 값이 있고 형식에 맞는다(능력 없는 라우트 0)", () => {
    const missing = ADMIN_ROUTES.filter((r) => !(CAPABILITIES.includes(r.cap) || MARKERS.has(r.cap)));
    assert.deepEqual(missing, []);
    for (const r of ADMIN_ROUTES) {
      assert.ok(ROUTE_SCOPES.includes(r.scope), `${r.method} ${r.path} scope=${r.scope}`);
      assert.ok(r.audit === false || isValidAuditAction(r.audit), `${r.method} ${r.path} audit=${r.audit}`);
      if (r.method !== "GET") assert.equal(typeof r.audit, "string", `${r.method} ${r.path}는 감사 행위를 선언한다`);
    }
  });

  it("인증 없이 부르는 라우트는 로그인 하나뿐이고 표지 능력 라우트는 주체 자신이 대상이다", () => {
    assert.deepEqual(ADMIN_ROUTES.filter((r) => r.cap === CAP_PUBLIC).map((r) => `${r.method} ${r.path}`), ["POST /auth"]);
    for (const r of ADMIN_ROUTES.filter((x) => MARKERS.has(x.cap))) assert.equal(r.scope, "self", r.path);
    for (const r of ADMIN_ROUTES.filter((x) => !MARKERS.has(x.cap))) assert.notEqual(r.scope, "self", r.path);
  });

  it("인증 라우트와 자기 정보 라우트는 IP별 요청 제한 대상이다", () => {
    for (const r of ADMIN_ROUTES.filter((x) => MARKERS.has(x.cap))) {
      assert.equal(isRateLimitedAdminRequest(r.method, sampleOf(r.path)), true, `${r.method} ${r.path}`);
    }
    assert.equal(isRateLimitedAdminRequest("GET", "/stats"), false);
  });

  it("(메서드, 경로)는 겹치지 않고 항목마다 자기 대표 경로를 스스로 판정한다", () => {
    const seen = new Set();
    for (const r of ADMIN_ROUTES) {
      const id = `${r.method} ${r.path}`;
      assert.ok(!seen.has(id), `중복 ${id}`);
      seen.add(id);
      assert.equal(findAdminRoute(r.method, sampleOf(r.path))?.entry.path, r.path, id);
    }
  });

  it("형식이 붙은 경로 변수는 그 형식의 값만 받고, 같은 자리의 글자 그대로 조각은 받지 않는다", () => {
    assert.equal(findAdminRoute("GET", `/sessions/${SAMPLE}`)?.entry.path, "/sessions/:id(uuid)");
    for (const method of ["GET", "DELETE"]) assert.equal(findAdminRoute(method, "/sessions/purge"), null, method);
    assert.equal(findAdminRoute("POST", "/sessions/purge/reflect"), null);
    assert.throws(() => compileRoutePath("/x/:id(nope)"), RouteTableError);
    assert.throws(() => compileRoutePath("/x/:i-d"), RouteTableError);
  });

  it("처리 모듈 파일이 있다", () => {
    for (const m of routeModules) assert.ok(existsSync(path.join(ADMIN_DIR, `${m}.js`)), m);
  });
});

describe("관리 모듈 소스와 라우트 표의 대응", () => {
  it("lib/admin의 처리 모듈은 모두 표에 오른다", () => {
    const modules = readdirSync(ADMIN_DIR).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
    for (const m of modules) {
      assert.ok(routeModules.includes(m) || NON_ROUTE_MODULES.has(m), `${m}가 라우트 표에도, 비라우트 목록에도 없다`);
    }
  });

  for (const module of routeModules) {
    it(`${module}: 소스의 (메서드, 경로)마다 같은 메서드의 표 항목이 있다`, () => {
      assert.ok(routePairs(module, sourceOf(module)).tokens.length > 0, `${module}에서 경로를 읽지 못했다`);
      assert.deepEqual(uncoveredRoutes(module, sourceOf(module), ADMIN_ROUTES, compileRoutePath), []);
    });

    it(`${module}: 표 항목마다 소스에 같은 메서드의 경로가 있다`, () => {
      const { tokens } = routePairs(module, sourceOf(module));
      for (const r of ADMIN_ROUTES.filter((x) => x.module === module)) {
        const re = compileRoutePath(r.path);
        assert.ok(tokens.some((t) => t.methods.includes(r.method) && t.variants.some((v) => re.test(v))),
          `${r.method} ${r.path}가 ${module} 소스에 없다`);
      }
    });

    it(`${module}: 소스가 비교하는 메서드는 표 항목에 있다`, () => {
      const compared = new Set([...sourceOf(module).matchAll(/(?:req\.method\s*(?:===|!==)\s*|method:\s*)"([A-Z]+)"/g)].map((m) => m[1]));
      const declared = new Set(ADMIN_ROUTES.filter((r) => r.module === module).map((r) => r.method));
      for (const m of compared) assert.ok(declared.has(m), `${module} ${m}`);
    });
  }
});

describe("라우트 대응 검사의 변형 소스 시험", () => {
  const sessions = sourceOf("admin-sessions");
  const anchor   = "async function routeSessions(req, res, url) {";
  const inject   = (extra) => sessions.replace(anchor, `${anchor}\n${extra}`);
  const check    = (source) => uncoveredRoutes("admin-sessions", source, ADMIN_ROUTES, compileRoutePath);

  it("실제 소스는 누락이 없다", () => {
    assert.ok(sessions.includes(anchor));
    assert.deepEqual(check(sessions), []);
  });

  it("기존 경로 아래 새 경로(POST /sessions/purge)는 /sessions/:id에 흡수되지 않고 누락으로 잡힌다", () => {
    const out = check(inject("  if (req.method === \"POST\" && url.pathname === `${SESSION_PREFIX}/purge`) { return true; }"));
    assert.ok(out.some((m) => m.includes("POST /sessions/purge")), out.join("; "));
  });

  it("같은 메서드의 변수 경로 자리에 새 글자 그대로 경로(GET /sessions/purge)를 더해도 /sessions/:id에 흡수되지 않는다", () => {
    const out = check(inject("  if (req.method === \"GET\" && url.pathname === `${SESSION_PREFIX}/purge`) { return true; }"));
    assert.ok(out.some((m) => m.includes("GET /sessions/purge")), out.join("; "));
  });

  it("같은 경로에 다른 메서드를 더하면 그 메서드의 항목이 없어 누락으로 잡힌다", () => {
    const out = check(inject("  if (req.method === \"PUT\" && url.pathname === SESSION_PREFIX) { return true; }"));
    assert.ok(out.some((m) => m.includes("PUT /sessions")), out.join("; "));
  });

  it("match 변수로 판정하는 경로의 메서드를 바꾸면 잡힌다", () => {
    const changed = sessions.replace('if (req.method === "DELETE" && sessionDeleteMatch) {', 'if (req.method === "PATCH" && sessionDeleteMatch) {');
    assert.notEqual(changed, sessions);
    const out = check(changed);
    assert.ok(out.some((m) => m.includes(`PATCH /sessions/${SAMPLE}`)), out.join("; "));
  });
});
