/**
 * 관리 라우트 능력 선언 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 관리 API 라우트 표(lib/admin/admin-route-table.js)를 본다.
 *   1. 항목마다 능력(cap), 범위 종류(scope), 감사(audit) 세 값이 형식에 맞는다. 능력 없는 항목은 0이다.
 *   2. 관리 모듈 소스에서 읽은 라우트 경로마다 그 모듈의 표 항목이 있고, 표 항목마다 그 모듈 소스에 경로가 있다.
 *   3. 관리 모듈이 비교하는 HTTP 메서드는 그 모듈의 표 항목에 있다.
 * 경로 목록 전체를 고정하지 않는다. 처리기에 라우트를 더하면서 표에 항목을 더하지 않으면 실패한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path             from "node:path";

import { ROOT, scanFile } from "./_source-scan.js";
import { ADMIN_ROUTES, ROUTE_SCOPES, findAdminRoute, compileRoutePath } from "../../lib/admin/admin-route-table.js";
import { CAPABILITIES, CAP_PUBLIC, CAP_AUTHENTICATED } from "../../lib/admin/capabilities.js";
import { isValidAuditAction } from "../../lib/logging/audit-event.js";

const ADMIN_DIR = path.join(ROOT, "lib", "admin");
const SAMPLE    = "6f1c0f7e-2222-4000-8000-000000000003";
const MARKERS   = new Set([CAP_PUBLIC, CAP_AUTHENTICATED]);

/** 라우트 경로가 아니라 접두로만 쓰는 문자열(모듈별) */
const PREFIX_ONLY = Object.freeze({ "admin-memory": ["/memory"], "admin-routes": ["/assets/"] });

/** 경로 앞에 붙는 모듈 접두(처리기가 접두를 뺀 하위 경로로 비교하는 모듈) */
const SUB_PATH_PREFIX = Object.freeze({ "admin-memory": "/memory" });

/** 라우트 표 밖의 관리 모듈(선언, 저장소, 도우미) */
const NON_ROUTE_MODULES = new Set([
  "admin-route-table", "admin-audit-actions", "capabilities", "AdminAuthz", "ScopeFilter", "admin-auth",
  "admin-login-guard", "admin-metrics", "ApiKeyStore", "OAuthClientStore", "key-policy", "key-state-cache",
  "admin-principal", "admin-redact"
]);

const sampleOf = (p) => p.split("/").map((seg) => (seg.startsWith(":") ? SAMPLE : seg)).join("/");

/** 정규식 원문을 대표 경로들로 바꾼다. 선택 그룹 (\/x)?는 있는 경우와 없는 경우 둘을 만든다. */
function samplesFromRegexSource(source) {
  const body = source.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/");
  const optional = /\((\/[a-z-]+)\)\?/;
  const variants = optional.test(body) ? [body.replace(optional, "$1"), body.replace(optional, "")] : [body];
  return variants.map((v) => v.replace(/\(\[\^\/\]\+\)|\(\[0-9a-f-\]\{36\}\)/g, SAMPLE));
}

/** 모듈 소스에서 라우트 대표 경로를 모은다. */
function routeSamples(module) {
  const file   = `lib/admin/${module}.js`;
  const raw    = readFileSync(path.join(ROOT, file), "utf8");
  const prefix = SUB_PATH_PREFIX[module] ?? "";
  const skip   = new Set(PREFIX_ONLY[module] ?? []);
  const out    = new Set();
  for (const { text } of scanFile(file).strings) {
    if (/^\$\{\}\/[a-z]/.test(text) && !text.includes(" ")) out.add(text.slice(3));
    else if (/^\^\$\{\}\/[a-z]/.test(text)) for (const s of samplesFromRegexSource(text.slice(4))) out.add(s);
    else if (/^\/[a-z-]+(\/[a-z-]*)*$/.test(text) && (prefix || module === "admin-export")) out.add(prefix + text);
  }
  for (const [, source] of raw.matchAll(/\/\^\\\/v1\\\/internal\\\/model\\\/nothing(\\\/[^\s]*?)\$\//g)) {
    for (const s of samplesFromRegexSource(source)) out.add(s);
  }
  if (prefix) {
    for (const [, source] of raw.matchAll(/\/\^(\\\/[a-z][^\s]*?)\$\//g)) {
      for (const s of samplesFromRegexSource(source)) out.add(prefix + s);
    }
  }
  return [...out]
    .filter((p) => !skip.has(p))
    .map((p) => (p.endsWith("/") ? p + SAMPLE : p));
}

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

  it("(메서드, 경로)는 겹치지 않고 항목마다 자기 대표 경로를 스스로 판정한다", () => {
    const seen = new Set();
    for (const r of ADMIN_ROUTES) {
      const id = `${r.method} ${r.path}`;
      assert.ok(!seen.has(id), `중복 ${id}`);
      seen.add(id);
      assert.equal(findAdminRoute(r.method, sampleOf(r.path))?.entry.path, r.path, id);
    }
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
    it(`${module}: 소스의 라우트 경로마다 표 항목이 있다`, () => {
      const entries = ADMIN_ROUTES.filter((r) => r.module === module).map((r) => compileRoutePath(r.path));
      const samples = routeSamples(module);
      assert.ok(samples.length > 0, `${module}에서 경로를 읽지 못했다`);
      for (const s of samples) assert.ok(entries.some((re) => re.test(s)), `${module} ${s} 항목 없음`);
    });

    it(`${module}: 표 항목마다 소스에 경로가 있다`, () => {
      const samples = routeSamples(module);
      for (const r of ADMIN_ROUTES.filter((x) => x.module === module)) {
        const re = compileRoutePath(r.path);
        assert.ok(samples.some((s) => re.test(s)), `${r.method} ${r.path}가 ${module} 소스에 없다`);
      }
    });

    it(`${module}: 소스가 비교하는 메서드는 표 항목에 있다`, () => {
      const raw      = readFileSync(path.join(ADMIN_DIR, `${module}.js`), "utf8");
      const compared = new Set([...raw.matchAll(/(?:req\.method\s*(?:===|!==)\s*|method:\s*)"([A-Z]+)"/g)].map((m) => m[1]));
      const declared = new Set(ADMIN_ROUTES.filter((r) => r.module === module).map((r) => r.method));
      for (const m of compared) assert.ok(declared.has(m), `${module} ${m}`);
    });
  }
});
