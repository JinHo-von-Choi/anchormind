/**
 * 관리 API 주체 자기 정보 라우트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * GET /me                         요청 주체의 종류, 역할, 가진 능력과 방식, 능력별 workspace 범위
 * GET /me/explain?cap=&workspace= 결정 표(AdminAuthz.decide)의 판정과 단계별 근거
 * 두 라우트는 요청한 주체 자신의 판정만 돌려준다. 다른 주체의 값, 키 해시, 비밀은 싣지 않는다.
 * 마스터 키(또는 마스터 키 로그인 세션)와 API 키 Bearer 모두 부를 수 있다(admin-principal.js).
 */

import { ADMIN_BASE }                                    from "./admin-auth.js";
import { CAPABILITIES, CAP_AUTHENTICATED, isCapability } from "./capabilities.js";
import { decide, adminPrincipalOf }                      from "./AdminAuthz.js";
import { MAX_WORKSPACE_LENGTH }                          from "./key-policy.js";

const ME_PATH      = `${ADMIN_BASE}/me`;
const EXPLAIN_PATH = `${ADMIN_BASE}/me/explain`;

/**
 * 주체가 가진 능력 목록. 대상 workspace와 관계없이 능력이 있으면(전역 대상에서 범위 단계로만 거부되어도) 싣는다.
 *
 * @param {object} principal
 * @returns {Array<{ cap: string, mode: string, range: object }>}
 */
export function principalCapabilities(principal) {
  const held = [];
  for (const cap of CAPABILITIES) {
    const d = decide(principal, cap);
    if (d.allowed || d.deniedAt === "workspace") held.push({ cap, mode: d.mode, range: d.range });
  }
  return held;
}

/**
 * explain의 workspace 매개변수가 형식에 맞는지 본다(길이 상한, 제어 문자 없음).
 *
 * @param {string} value
 * @returns {boolean}
 */
function isWorkspaceParam(value) {
  if (value.length > MAX_WORKSPACE_LENGTH) return false;
  return Array.from(value).every((ch) => {
    const code = ch.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  });
}

/** 400 응답 */
function badRequest(res, field, error) {
  res.statusCode = 400;
  res.end(JSON.stringify({ error, field }));
  return true;
}

/**
 * GET /me/explain
 */
function explain(res, url, principal) {
  const cap       = url.searchParams.get("cap");
  const workspace = url.searchParams.get("workspace");
  if (!cap) return badRequest(res, "cap", "cap is required");
  if (!isCapability(cap)) return badRequest(res, "cap", "unknown capability");
  if (workspace !== null && !isWorkspaceParam(workspace)) return badRequest(res, "workspace", "invalid workspace");
  res.statusCode = 200;
  res.end(JSON.stringify(decide(principal, cap, { workspace })));
  return true;
}

/**
 * /me, /me/explain 처리기
 *
 * @returns {Promise<boolean>} 처리 여부
 */
export async function handleMe(req, res, url) {
  if (req.method !== "GET" || (url.pathname !== ME_PATH && url.pathname !== EXPLAIN_PATH)) return false;
  const principal = adminPrincipalOf(req);
  if (!principal) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return true;
  }
  if (url.pathname === EXPLAIN_PATH) return explain(res, url, principal);
  const decided = decide(principal, CAP_AUTHENTICATED).principal;
  const summary = principal.kind === "admin_session" ? { ...decided, username: principal.username } : decided;
  res.statusCode = 200;
  res.end(JSON.stringify({ principal: summary, capabilities: principalCapabilities(principal) }));
  return true;
}
