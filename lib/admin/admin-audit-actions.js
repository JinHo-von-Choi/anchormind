/**
 * 관리 요청 감사 행위 선언
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 상태를 바꾸는 관리 라우트(GET이 아닌 요청)와 내보내기 GET은 라우트 표(admin-route-table.js)의 audit 값으로
 * 행위 이름을 선언한다. 응답이 끝나면 admin-routes.js가 선언을 찾아 감사 이벤트를 기록한다
 * (lib/logging/audit-outbox.recordAudit). 선언이 없는 요청(없는 경로, 잘못된 메서드)은 admin.request로 남는다.
 * tests/unit/admin-audit-actions.test.js가 관리 모듈의 비GET 라우트마다 선언이 있는지 소스에서 확인한다.
 *
 * 선언 항목(ADMIN_AUDIT_ACTIONS)
 *   module  라우트를 처리하는 lib/admin 모듈 이름
 *   method  HTTP 메서드
 *   path    ADMIN_BASE 아래 경로. ":이름" 조각은 경로 변수다
 *   action  감사 행위 이름(admin_audit_events.action)
 *   target  대상 유형. 첫 경로 변수가 대상 id다. 생략하면 대상 없음
 *   ref     "prefix8"이면 대상 id를 앞 8자로 줄인다(세션 id)
 *
 * 처리기는 noteAdminAudit(res, { targetId, detail })로 대상 id(생성한 자원)와 변경 전후 값을 덧붙인다.
 * detail은 감사 규칙을 따른다(본문과 비밀 금지, 본문은 contentFingerprint로).
 */

import { ADMIN_ROUTES, ADMIN_AUTH_ACTION, compileRoutePath } from "./admin-route-table.js";

export const ADMIN_AUDIT_FALLBACK_ACTION = "admin.request";
export { ADMIN_AUTH_ACTION };

/** 라우트 표에서 감사 행위를 선언한 항목. action은 라우트 표의 audit 값이다. */
export const ADMIN_AUDIT_ACTIONS = Object.freeze(
  ADMIN_ROUTES
    .filter((route) => typeof route.audit === "string")
    .map(({ module, method, path, audit, target, ref }) => Object.freeze({
      module, method, path, action: audit, ...(target ? { target } : {}), ...(ref ? { ref } : {})
    }))
);

const COMPILED = ADMIN_AUDIT_ACTIONS.map((entry) => Object.freeze({ ...entry, pattern: compileRoutePath(entry.path) }));

/**
 * 경로 조각의 퍼센트 인코딩을 푼다. 형식이 틀린 인코딩(예: %FF, %G1)은 조각을 그대로 돌려준다.
 * 응답 종료 처리기에서 불리므로 던지지 않는다.
 *
 * @param {string} segment
 * @returns {string}
 */
export function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (err) {
    if (err instanceof URIError) return segment;
    throw err;
  }
}

/**
 * 메서드와 ADMIN_BASE 아래 경로에 맞는 선언을 찾는다.
 *
 * @param {string} method
 * @param {string} subPath ADMIN_BASE를 뺀 경로(질의 문자열 없음)
 * @returns {{ entry: object, params: string[] }|null}
 */
export function findAdminAuditAction(method, subPath) {
  for (const entry of COMPILED) {
    if (entry.method !== method) continue;
    const m = entry.pattern.exec(subPath);
    if (m) return { entry, params: m.slice(1).map(decodePathSegment) };
  }
  return null;
}

/** 응답 객체별 처리기 메모 */
const notes = new WeakMap();

/**
 * 처리기가 감사 이벤트에 대상 id와 detail을 덧붙인다. 여러 번 부르면 detail을 합친다.
 *
 * @param {object} res
 * @param {{ targetId?: string|null, detail?: object }} note
 */
export function noteAdminAudit(res, { targetId, detail } = {}) {
  const prev = notes.get(res) ?? {};
  notes.set(res, {
    targetId: targetId ?? prev.targetId ?? null,
    detail  : { ...(prev.detail ?? {}), ...(detail ?? {}) }
  });
}

/**
 * 처리기 메모를 꺼낸다.
 *
 * @param {object} res
 * @returns {{ targetId: string|null, detail: object }}
 */
export function takeAdminAuditNote(res) {
  const note = notes.get(res) ?? { targetId: null, detail: {} };
  notes.delete(res);
  return note;
}

/**
 * 관리 요청 하나의 감사 이벤트 값을 만든다.
 *
 * @param {{ method: string, subPath: string, maskedPath: string, status: number, outcome: string,
 *           actor: object, note?: { targetId: string|null, detail: object } }} args
 * @returns {{ action: string, outcome: string, actor: object, target: object|null, detail: object }}
 */
export function adminAuditEvent({ method, subPath, maskedPath, status, outcome, actor, note = { targetId: null, detail: {} } }) {
  const found  = findAdminAuditAction(method, subPath);
  const entry  = found?.entry ?? null;
  const rawId  = note.targetId ?? found?.params[0] ?? null;
  const id     = rawId !== null && entry?.ref === "prefix8" ? String(rawId).slice(0, 8) : rawId;
  return {
    action : entry?.action ?? ADMIN_AUDIT_FALLBACK_ACTION,
    outcome,
    actor,
    target : entry?.target ? { type: entry.target, id } : null,
    detail : { ...note.detail, method, path: maskedPath, status }
  };
}
