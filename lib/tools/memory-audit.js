/**
 * 기억 도구의 감사 이벤트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * remember, amend, forget, link 처리기(lib/tools/memory.js)가 남기는 감사 이벤트 값을 만든다.
 * 본문은 sha256과 길이만 남기고, 실패는 오류 분류(code 또는 이름)만 남긴다. 앵커 지정과 변경은
 * memory.anchor를 따로 남긴다. 관문 차단은 WriteGate가 gate.block으로 남긴다. 파일 감사 로그 기록(auditTool)도
 * 여기에 둔다.
 */

import { logAudit }           from "../utils.js";
import { recordAudit }        from "../logging/audit-outbox.js";
import { contentFingerprint } from "../logging/audit-event.js";

/**
 * 도구 감사 기록(파일 감사 로그). 서버가 주입한 행위자(args._auditActor)를 붙인다.
 *
 * @param {Object} args
 * @param {string} operation
 * @param {Object} fields
 * @returns {Promise<void>}
 */
export function auditTool(args, operation, fields) {
  return logAudit(operation, { ...fields, actor: args._auditActor });
}

/** amend에서 감사 detail.changed로 남기는 필드 */
export const AMEND_AUDIT_FIELDS = Object.freeze([
  "content", "topic", "keywords", "type", "importance", "isAnchor", "supersedes",
  "assertionStatus", "resolutionStatus", "outcome", "phase"
]);

/**
 * 감사 이벤트(admin_audit_events)를 남긴다. 행위자는 서버가 주입한 args._auditActor다.
 * 기록은 응답을 기다리게 하지 않고, 실패는 audit-outbox가 경고와 지표로 남긴다.
 *
 * @param {Object} args
 * @param {{ action: string, outcome?: string, target?: Object|null, detail?: Object }|Array<Object>} events
 */
export function recordToolAudit(args, events) {
  const workspace = args.workspace ?? args._defaultWorkspace ?? null;
  for (const event of [events].flat()) {
    recordAudit({ outcome: "success", ...event, actor: args._auditActor, workspace });
  }
}

/**
 * 본문 지문 detail. 본문이 없으면 빈 객체다.
 *
 * @param {unknown} content
 * @returns {{ contentSha256?: string, contentLength?: number }}
 */
export function contentAuditDetail(content) {
  const fp = contentFingerprint(content);
  return fp ? { contentSha256: fp.sha256, contentLength: fp.length } : {};
}

/**
 * 실패 감사 이벤트의 오류 분류. 메시지(입력 값이 섞일 수 있다)는 남기지 않는다.
 *
 * @param {unknown} err
 * @returns {string|number}
 */
export function auditErrorCode(err) {
  return err?.code ?? err?.name ?? "Error";
}

/**
 * 파편 대상.
 *
 * @param {string|null|undefined} id
 * @returns {{ type: string, id: string }|null}
 */
export function fragmentTarget(id) {
  return id ? { type: "fragment", id: String(id) } : null;
}

/**
 * remember 성공의 감사 이벤트. 앵커 지정이면 memory.anchor를 함께 남긴다.
 *
 * @param {Object} args
 * @param {Object} result
 * @returns {Array<Object>}
 */
export function rememberAuditEvents(args, result) {
  const target = fragmentTarget(result.id);
  const events = [{
    action: "memory.remember",
    target,
    detail: { ...contentAuditDetail(args.content), type: args.type, isAnchor: args.isAnchor === true, duplicate: result.duplicate === true }
  }];
  if (args.isAnchor === true) events.push({ action: "memory.anchor", target, detail: { isAnchor: true } });
  return events;
}

/**
 * forget 대상. id가 있으면 파편, 없으면 주제다.
 *
 * @param {Object} args
 * @returns {{ type: string, id: string }|null}
 */
export function forgetTarget(args) {
  if (args.id) return fragmentTarget(args.id);
  return args.topic ? { type: "topic", id: String(args.topic) } : null;
}

/**
 * amend의 감사 이벤트. 갱신하지 못하면 failure이고, 앵커 값을 바꾸면 memory.anchor를 함께 남긴다.
 *
 * @param {Object} args
 * @param {Object} result
 * @returns {Array<Object>}
 */
export function amendAuditEvents(args, result) {
  const target  = fragmentTarget(args.id);
  const updated = result.updated === true;
  const events  = [{
    action : "memory.amend",
    outcome: updated ? "success" : "failure",
    target,
    detail : {
      changed: AMEND_AUDIT_FIELDS.filter((f) => args[f] !== undefined),
      ...contentAuditDetail(args.content),
      merged : result.merged === true
    }
  }];
  if (updated && typeof args.isAnchor === "boolean") events.push({ action: "memory.anchor", target, detail: { isAnchor: args.isAnchor } });
  return events;
}

/**
 * withAudit 실패 이벤트. outcome은 failure이고 detail에는 오류 분류만 담는다.
 *
 * @param {{ action: string, target?: Object|null }} spec
 * @param {unknown} err
 * @returns {Object}
 */
export function failureEvent(spec, err) {
  return { ...spec, outcome: "failure", detail: { errorCode: auditErrorCode(err) } };
}

/**
 * remember 실패의 감사 이벤트.
 *
 * @param {Object} args
 * @param {unknown} err
 * @returns {Object}
 */
export function rememberFailureEvent(args, err) {
  return {
    action : "memory.remember",
    outcome: "failure",
    detail : { ...contentAuditDetail(args.content), type: args.type, errorCode: auditErrorCode(err) }
  };
}

/**
 * forget 성공의 감사 이벤트.
 *
 * @param {Object} args
 * @param {Object} result
 * @returns {Object}
 */
export function forgetAuditEvent(args, result) {
  return {
    action: "memory.forget",
    target: forgetTarget(args),
    detail: { deleted: Number.isInteger(result.deleted) ? result.deleted : null, force: args.force === true }
  };
}

/**
 * link 성공의 감사 이벤트.
 *
 * @param {Object} args
 * @returns {Object}
 */
export function linkAuditEvent(args) {
  return {
    action: "memory.link",
    target: fragmentTarget(args.fromId),
    detail: { toId: args.toId ?? null, relationType: args.relationType ?? null }
  };
}
