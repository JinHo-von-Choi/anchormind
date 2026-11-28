import { AsyncLocalStorage } from "node:async_hooks";

const authorization = new AsyncLocalStorage();

/** HTTP 인증이나 로컬 CLI 진입점에서 확인한 권한을 DB 실행기에 전한다. */
export function withRowAuthorization(actor, body) {
  return authorization.run(actor, body);
}

export function withSessionRowAuthorization(session, body) {
  const authenticated = session?.authenticated === true;
  const keyId = authenticated && typeof session.keyId === "string" ? session.keyId : null;
  const isMaster = authenticated && session.isMaster === true && session.keyId == null && session.permissions == null;
  return withRowAuthorization({ keyId, isMaster }, body);
}

export function resolveRowAuthorization({ subject, implicitSubject, keyId, hasKeys, global } = {}) {
  const actor = authorization.getStore();
  const service = subject === "admin" || subject === "system";
  if (service && !implicitSubject) return { kind: "service" };
  if (hasKeys || keyId) return { kind: "key" };
  if (global) return { kind: "global" };
  if (service && !actor?.keyId) return { kind: "service" };
  if (actor?.isMaster === true) return { kind: "master" };
  if (actor?.keyId) return { kind: "key", fallbackKeyId: actor.keyId };
  return { kind: "" };
}
