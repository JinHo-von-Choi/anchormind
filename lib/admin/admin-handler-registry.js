/**
 * 관리 API 모듈 처리기 레지스트리
 *
 * 라우트 표의 등장 순서와 실제 디스패치 순서를 분리한다. 경로가 겹칠 수 있는
 * admin-audit는 admin-export보다 먼저 실행하며, 라우트 표와 등록 모듈의 차이는
 * 서버 기동(import) 시 코드 오류로 처리한다.
 */

import { ADMIN_ROUTES } from "./admin-route-table.js";
import { handleAdminUsers } from "./admin-users.js";
import { handleMe } from "./admin-me.js";
import { handleKeys } from "./admin-keys.js";
import { handleMemory, handleSearch, handleSearchEvents } from "./admin-memory.js";
import { handleSessions } from "./admin-sessions.js";
import { handleLogs } from "./admin-logs.js";
import { handleExport, handleImport } from "./admin-export.js";
import { handleReview } from "./admin-review.js";
import { handleAudit } from "./admin-audit.js";

/** admin-routes는 인라인 처리, admin-user-auth는 인증 흐름에서 직접 처리한다. */
export const DIRECT_ADMIN_ROUTE_MODULES = Object.freeze(["admin-routes", "admin-user-auth"]);

/**
 * 등록 모듈과 라우트 표 모듈의 일대일 대응을 검사하고 불변 레지스트리를 만든다.
 *
 * @param {Array<{module: string, handlers: Function[]}>} entries
 * @param {Iterable<string>} routeModules
 * @param {Iterable<string>} [directModules]
 * @returns {{registry: Readonly<Record<string, readonly Function[]>>, modules: readonly string[], handlers: readonly Function[]}}
 */
export function buildAdminHandlerRegistry(entries, routeModules, directModules = DIRECT_ADMIN_ROUTE_MODULES) {
  const direct   = new Set(directModules);
  const expected = new Set([...routeModules].filter((module) => !direct.has(module)));
  const seen     = new Set();
  const registry = {};
  const handlers = [];

  for (const entry of entries) {
    if (seen.has(entry.module)) throw new Error(`duplicate admin handler module: ${entry.module}`);
    if (!Array.isArray(entry.handlers) || entry.handlers.length === 0 || entry.handlers.some((handler) => typeof handler !== "function")) {
      throw new Error(`invalid admin handlers: ${entry.module}`);
    }
    seen.add(entry.module);
    registry[entry.module] = Object.freeze([...entry.handlers]);
    handlers.push(...entry.handlers);
  }

  const missing    = [...expected].filter((module) => !seen.has(module));
  const unexpected = [...seen].filter((module) => !expected.has(module));
  if (missing.length || unexpected.length) {
    throw new Error(`admin handler registry mismatch: missing=[${missing.join(",")}] unexpected=[${unexpected.join(",")}]`);
  }

  return Object.freeze({
    registry: Object.freeze(registry),
    modules : Object.freeze(entries.map((entry) => entry.module)),
    handlers: Object.freeze(handlers)
  });
}

/** 명시적 디스패치 순서. admin-audit는 admin-export보다 앞이어야 한다. */
const HANDLER_ENTRIES = Object.freeze([
  { module: "admin-me",       handlers: [handleMe] },
  { module: "admin-users",    handlers: [handleAdminUsers] },
  { module: "admin-keys",     handlers: [handleKeys] },
  { module: "admin-review",   handlers: [handleReview] },
  { module: "admin-memory",   handlers: [handleSearch, handleSearchEvents, handleMemory] },
  { module: "admin-sessions", handlers: [handleSessions] },
  { module: "admin-logs",     handlers: [handleLogs] },
  { module: "admin-audit",    handlers: [handleAudit] },
  { module: "admin-export",   handlers: [handleExport, handleImport] }
]);

const routeModules = new Set(ADMIN_ROUTES.map((route) => route.module));
const built        = buildAdminHandlerRegistry(HANDLER_ENTRIES, routeModules);

export const ADMIN_HANDLER_REGISTRY = built.registry;
export const ADMIN_HANDLER_MODULES  = built.modules;
export const ADMIN_MODULE_HANDLERS  = built.handlers;

/** @returns {Promise<boolean>} 처리한 핸들러가 있으면 true */
export async function dispatchAdminModuleHandlers(req, res, url) {
  for (const handler of ADMIN_MODULE_HANDLERS) {
    if (await handler(req, res, url)) return true;
  }
  return false;
}
