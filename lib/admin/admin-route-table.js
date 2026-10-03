/**
 * 관리 API 라우트 표
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * ADMIN_BASE 아래 관리 API 라우트마다 요구 능력, 범위 종류, 감사 행위를 한 줄로 선언한다.
 * admin-routes.js는 요청마다 이 표에서 항목을 찾아 AdminAuthz.requireCapability로 판정하고, 응답이 끝나면
 * 감사 행위(admin-audit-actions.js가 이 표에서 뽑는다)로 감사 이벤트를 남긴다. 표에 없는 경로는
 * UNLISTED_ROUTE_CAP(owner만 통과)을 요구한다.
 *
 * 항목
 *   module  라우트를 처리하는 lib/admin 모듈 이름
 *   method  HTTP 메서드
 *   path    ADMIN_BASE 아래 경로. ":이름" 조각은 경로 변수다
 *   cap     요구 능력(capabilities.js의 능력, CAP_PUBLIC 또는 CAP_AUTHENTICATED)
 *   scope   대상 범위 종류
 *             global     설치 전체가 대상이다. 판정 범위가 전체여야 한다
 *             workspace  질의 매개변수 workspace가 대상이다. 없으면 전역 대상이다
 *             self       주체 자신이 대상이다(로그인, 자기 정보)
 *   audit   감사 행위 이름(admin_audit_events.action). 감사하지 않는 GET은 false
 *   target  감사 대상 유형. 첫 경로 변수가 대상 id다. 생략하면 대상 없음
 *   ref     "prefix8"이면 감사 대상 id를 앞 8자로 줄인다(세션 id)
 *   ipLimit true면 server.js가 클라이언트 IP별 요청 제한(rateLimiter)을 먼저 건다(인증, 키 생성, 가져오기, 자기 정보)
 */

import { CAP_PUBLIC, CAP_AUTHENTICATED } from "./capabilities.js";

/** 라우트 범위 종류 */
export const ROUTE_SCOPES = Object.freeze(["global", "workspace", "self"]);

export const ADMIN_AUTH_ACTION = "admin.auth";

const AUTH = CAP_AUTHENTICATED;

export const ADMIN_ROUTES = Object.freeze([
  { module: "admin-routes",   method: "POST",   path: "/auth",                      cap: CAP_PUBLIC,         scope: "self",      audit: ADMIN_AUTH_ACTION, ipLimit: true },
  { module: "admin-routes",   method: "GET",    path: "/stats",                     cap: "usage.read",       scope: "global",    audit: false },
  { module: "admin-routes",   method: "GET",    path: "/activity",                  cap: "mem.read",         scope: "global",    audit: false },
  { module: "admin-routes",   method: "GET",    path: "/metrics-summary",           cap: "usage.read",       scope: "global",    audit: false },
  { module: "admin-me",       method: "GET",    path: "/me",                        cap: AUTH,               scope: "self",      audit: false, ipLimit: true },
  { module: "admin-me",       method: "GET",    path: "/me/explain",                cap: AUTH,               scope: "self",      audit: false, ipLimit: true },
  { module: "admin-keys",     method: "GET",    path: "/keys",                      cap: "key.manage",       scope: "global",    audit: false },
  { module: "admin-keys",     method: "GET",    path: "/keys/:id/stats",            cap: "key.manage",       scope: "global",    audit: false },
  { module: "admin-keys",     method: "POST",   path: "/keys",                      cap: "key.manage",       scope: "global",    audit: "admin.key.create",                target: "api_key", ipLimit: true },
  { module: "admin-keys",     method: "PUT",    path: "/keys/:id/daily-limit",      cap: "key.policy",       scope: "global",    audit: "admin.key.daily_limit_update",    target: "api_key" },
  { module: "admin-keys",     method: "PUT",    path: "/keys/:id/permissions",      cap: "key.policy",       scope: "global",    audit: "admin.key.permissions_update",    target: "api_key" },
  { module: "admin-keys",     method: "PUT",    path: "/keys/:id/fragment-limit",   cap: "key.policy",       scope: "global",    audit: "admin.key.fragment_limit_update", target: "api_key" },
  { module: "admin-keys",     method: "PATCH",  path: "/keys/:id/workspace",        cap: "key.policy",       scope: "global",    audit: "admin.key.workspace_update",      target: "api_key" },
  { module: "admin-keys",     method: "PATCH",  path: "/keys/:id/policy",           cap: "key.policy",       scope: "global",    audit: "admin.key.policy_update",         target: "api_key" },
  { module: "admin-keys",     method: "PUT",    path: "/keys/:id",                  cap: "key.manage",       scope: "global",    audit: "admin.key.status_update",         target: "api_key" },
  { module: "admin-keys",     method: "DELETE", path: "/keys/:id",                  cap: "key.manage",       scope: "global",    audit: "admin.key.delete",                target: "api_key" },
  { module: "admin-keys",     method: "GET",    path: "/groups",                    cap: "key.manage",       scope: "global",    audit: false },
  { module: "admin-keys",     method: "POST",   path: "/groups",                    cap: "key.manage",       scope: "global",    audit: "admin.group.create",              target: "key_group" },
  { module: "admin-keys",     method: "GET",    path: "/groups/:id/members",        cap: "key.manage",       scope: "global",    audit: false },
  { module: "admin-keys",     method: "POST",   path: "/groups/:id/members",        cap: "key.manage",       scope: "global",    audit: "admin.group.member_add",          target: "key_group" },
  { module: "admin-keys",     method: "DELETE", path: "/groups/:id/members/:keyId", cap: "key.manage",       scope: "global",    audit: "admin.group.member_remove",       target: "key_group" },
  { module: "admin-keys",     method: "DELETE", path: "/groups/:id",                cap: "key.manage",       scope: "global",    audit: "admin.group.delete",              target: "key_group" },
  { module: "admin-memory",   method: "GET",    path: "/memory/overview",           cap: "mem.read",         scope: "workspace", audit: false },
  { module: "admin-memory",   method: "GET",    path: "/memory/search-events",      cap: "quality.read",     scope: "global",    audit: false },
  { module: "admin-memory",   method: "GET",    path: "/memory/fragments",          cap: "mem.read",         scope: "workspace", audit: false },
  { module: "admin-memory",   method: "GET",    path: "/memory/fragments/:id",      cap: "mem.read",         scope: "workspace", audit: false },
  { module: "admin-memory",   method: "GET",    path: "/memory/fragments/:id/history", cap: "mem.read",      scope: "global",    audit: false },
  { module: "admin-memory",   method: "GET",    path: "/memory/anomalies",          cap: "quality.read",     scope: "global",    audit: false },
  { module: "admin-memory",   method: "GET",    path: "/memory/graph",              cap: "mem.read",         scope: "workspace", audit: false },
  { module: "admin-memory",   method: "POST",   path: "/memory/fragments",          cap: "mem.write",        scope: "global",    audit: "admin.memory.fragment_create",    target: "fragment" },
  { module: "admin-memory",   method: "PATCH",  path: "/memory/fragments/:id",      cap: "mem.write",        scope: "global",    audit: "admin.memory.fragment_update",    target: "fragment" },
  { module: "admin-memory",   method: "DELETE", path: "/memory/fragments/:id",      cap: "mem.delete.hard",  scope: "global",    audit: "admin.memory.fragment_delete",    target: "fragment" },
  { module: "admin-memory",   method: "POST",   path: "/search",                    cap: "mem.read",         scope: "global",    audit: "admin.memory.search" },
  { module: "admin-memory",   method: "GET",    path: "/search-events",             cap: "quality.read",     scope: "global",    audit: false },
  { module: "admin-sessions", method: "GET",    path: "/sessions",                  cap: "usage.read",       scope: "global",    audit: false },
  { module: "admin-sessions", method: "GET",    path: "/sessions/:id",              cap: "usage.read",       scope: "global",    audit: false },
  { module: "admin-sessions", method: "POST",   path: "/sessions/cleanup",          cap: "job.apply",        scope: "global",    audit: "admin.session.cleanup" },
  { module: "admin-sessions", method: "POST",   path: "/sessions/reflect-all",      cap: "job.apply",        scope: "global",    audit: "admin.session.reflect_all" },
  { module: "admin-sessions", method: "POST",   path: "/sessions/:id/reflect",      cap: "job.apply",        scope: "global",    audit: "admin.session.reflect",           target: "session", ref: "prefix8" },
  { module: "admin-sessions", method: "DELETE", path: "/sessions/:id",              cap: "job.apply",        scope: "global",    audit: "admin.session.close",             target: "session", ref: "prefix8" },
  { module: "admin-logs",     method: "GET",    path: "/logs/files",                cap: "logs.read",        scope: "global",    audit: false },
  { module: "admin-logs",     method: "GET",    path: "/logs/read",                 cap: "logs.read",        scope: "global",    audit: false },
  { module: "admin-logs",     method: "GET",    path: "/logs/stats",                cap: "logs.read",        scope: "global",    audit: false },
  { module: "admin-export",   method: "POST",   path: "/import",                    cap: "import.data",      scope: "global",    audit: "admin.import", ipLimit: true },
  { module: "admin-export",   method: "GET",    path: "/export",                    cap: "export.data",      scope: "global",    audit: "admin.export" },
  { module: "admin-audit",    method: "GET",    path: "/audit",                     cap: "audit.read",       scope: "global",    audit: false },
  { module: "admin-audit",    method: "POST",   path: "/audit/verify",              cap: "audit.read",       scope: "global",    audit: "admin.audit.verify" },
  { module: "admin-audit",    method: "GET",    path: "/audit/export",              cap: "audit.export",     scope: "global",    audit: "admin.audit.export" }
]);

/**
 * 선언 경로를 판정 정규식으로 바꾼다.
 *
 * @param {string} path
 * @returns {RegExp}
 */
export function compileRoutePath(path) {
  const source = path.split("/").map((seg) => (seg.startsWith(":") ? "([^/]+)" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  return new RegExp(`^${source}$`);
}

const COMPILED = ADMIN_ROUTES.map((entry) => Object.freeze({ ...entry, pattern: compileRoutePath(entry.path) }));

/**
 * 메서드와 ADMIN_BASE 아래 경로에 맞는 라우트 항목을 찾는다.
 *
 * @param {string} method
 * @param {string} subPath ADMIN_BASE를 뺀 경로(질의 문자열 없음)
 * @returns {{ entry: object, params: string[] }|null} params는 디코딩하지 않은 경로 변수다
 */
export function findAdminRoute(method, subPath) {
  for (const entry of COMPILED) {
    if (entry.method !== method) continue;
    const m = entry.pattern.exec(subPath);
    if (m) return { entry, params: m.slice(1) };
  }
  return null;
}

/**
 * 클라이언트 IP별 요청 제한을 거는 관리 요청인지 본다.
 *
 * @param {string} method
 * @param {string} subPath ADMIN_BASE를 뺀 경로
 * @returns {boolean}
 */
export function isRateLimitedAdminRequest(method, subPath) {
  return findAdminRoute(method, subPath)?.entry.ipLimit === true;
}
