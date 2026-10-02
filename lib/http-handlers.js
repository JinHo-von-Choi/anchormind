/**
 * HTTP 요청 핸들러 — re-export 허브
 * 각 핸들러는 lib/handlers/ 하위 모듈에 구현되어 있다.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 * 수정일: 2026-04-04
 */

export { setWorkerRefs, recordConsolidateRun, applyCorsOrigin } from "./handlers/_common.js";
export { handleHealth, handleLive, handleReady, handleMetrics } from "./handlers/health-handler.js";
export { handleMcpPost, handleMcpGet, handleMcpDelete }        from "./handlers/mcp-handler.js";
export { handleLegacySseGet, handleLegacySsePost }             from "./handlers/sse-handler.js";
export {
  handleOAuthServerMetadata,
  handleOAuthResourceMetadata,
  handleOAuthRegister,
  handleOAuthAuthorize,
  handleOAuthToken
}                                                               from "./handlers/oauth-handler.js";
export { handleSessionRotate }                                  from "./handlers/session-handler.js";
export { handleAdminUi, handleAdminImage, handleAdminStatic, handleAdminApi } from "./admin/admin-routes.js";
