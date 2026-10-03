/**
 * 감사 이벤트 생산자
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 감사 대상 행위는 topic audit.record 이벤트를 outbox에 남기고, 감사 승격 소비자(audit-consumer.js)가
 * admin_audit_events 해시 체인에 옮긴다.
 *
 *   enqueueAudit(client, event)  호출자 트랜잭션 연결로 기록한다. 업무 변경과 함께 커밋되거나 사라진다.
 *                                규칙 위반과 기록 오류를 호출자에게 던진다.
 *   recordAudit(event)           업무 트랜잭션 밖(응답 직후, 거부 판정 직후)에서 짧은 독립 트랜잭션으로
 *                                기록한다. 거부하지 않는다: 실패는 경고 로그와
 *                                memento_audit_enqueue_failed_total로 남기고 null을 돌려준다.
 *
 * event: { action, outcome?, actor?, target?, workspace?, detail?, occurredAt? } (audit-event.buildAuditPayload)
 * 발생 시각은 호출 시점에 정한다. MEMENTO_AUDIT_DB=off이면 두 함수 모두 기록하지 않고 null이다.
 *
 * 이 모듈은 의미 쓰기 관문, 도구 처리기, 관리 라우트가 가져온다. 설정, outbox, DB, 로거, 지표 모듈은
 * 처음 기록할 때 동적으로 불러온다(가져오는 쪽의 정적 의존을 늘리지 않는다).
 */

import { AUDIT_TOPIC, buildAuditPayload } from "./audit-event.js";

const AGGREGATE_ID_MAX = 200;

let depsPromise = null;

/**
 * 기록에 필요한 모듈. 불러오기에 실패하면 다음 호출에서 다시 시도한다.
 *
 * @returns {Promise<{ config: object, outbox: object, db: object, logger: object, metrics: object }>}
 */
function loadDeps() {
  depsPromise ??= Promise.all([
    import("../config.js"),
    import("../outbox/Outbox.js"),
    import("../tools/db.js"),
    import("../logger.js"),
    import("./audit-metrics.js")
  ]).then(([config, outbox, db, logger, metrics]) => ({ config, outbox, db, logger, metrics }))
    .catch((err) => {
      depsPromise = null;
      throw err;
    });
  return depsPromise;
}

/**
 * 감사 표 스위치.
 *
 * @param {{ config: object }} deps
 * @returns {boolean}
 */
function enabled(deps) {
  return typeof deps.config.auditDbEnabled === "function" && deps.config.auditDbEnabled();
}

/**
 * outbox 이벤트 값. aggregateId는 "대상유형:대상id"다.
 *
 * @param {object} payload
 * @returns {{ topic: string, aggregateId: string|null, payload: object }}
 */
function outboxEvent(payload) {
  const target      = payload.target;
  const aggregateId = target ? (target.id ? `${target.type}:${target.id}` : target.type).slice(0, AGGREGATE_ID_MAX) : null;
  return { topic: AUDIT_TOPIC, aggregateId, payload };
}

/**
 * 호출자 트랜잭션 안에서 감사 이벤트를 기록한다.
 *
 * @param {import("pg").PoolClient} client BEGIN을 실행한 연결
 * @param {object} event
 * @returns {Promise<{ id: string }|null>}
 */
export async function enqueueAudit(client, event) {
  const payload = buildAuditPayload(event);
  const deps    = await loadDeps();
  if (!enabled(deps)) return null;
  return deps.outbox.enqueue(client, outboxEvent(payload));
}

/**
 * 기록 실패를 알린다.
 *
 * @param {string} action
 * @param {unknown} err
 */
async function reportFailure(action, err) {
  const message = err instanceof Error ? err.message : String(err);
  try {
    const deps = await loadDeps();
    deps.metrics.auditEnqueueFailedTotal.inc();
    deps.logger.logWarn(`[Audit] audit event not recorded (action=${action}): ${message}`);
  } catch (loadErr) {
    process.emitWarning(`audit event not recorded (action=${action}): ${message}; ${loadErr.message}`, "AuditWarning");
  }
}

/**
 * 독립 트랜잭션으로 감사 이벤트를 기록한다. 거부하지 않는다.
 *
 * @param {object} event
 * @returns {Promise<{ id: string }|null>}
 */
export function recordAudit(event) {
  const action = typeof event?.action === "string" ? event.action.slice(0, 64) : "unknown";
  let   payload;
  try {
    payload = buildAuditPayload(event);
  } catch (err) {
    return reportFailure(action, err).then(() => null);
  }
  return loadDeps()
    .then((deps) => (enabled(deps) ? deps.outbox.enqueueStandalone(deps.db.getPrimaryPool(), outboxEvent(payload)) : null))
    .catch(async (err) => {
      await reportFailure(action, err);
      return null;
    });
}
