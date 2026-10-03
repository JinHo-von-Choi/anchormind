/**
 * 감사 이벤트 payload 순수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * payload 구성과 검증, 행위자 판정, detail 정리(본문과 비밀 키 거부, 비밀 문자열 가림, 크기 제한),
 * 본문 지문, HTTP 상태의 결과 분류를 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import crypto           from "node:crypto";

import {
  AUDIT_TOPIC, AuditEventError, isValidAuditAction, auditActor, contentFingerprint,
  sanitizeAuditDetail, buildAuditPayload, readAuditPayload, outcomeForStatus,
  DETAIL_STRING_MAX, DETAIL_ARRAY_MAX
} from "../../lib/logging/audit-event.js";

const KEY_ID = "6f1c0f7e-1111-4000-8000-000000000001";

describe("행위 이름", () => {
  it("점으로 구분한 소문자 조각만 받는다", () => {
    assert.equal(isValidAuditAction("admin.key.policy_update"), true);
    assert.equal(isValidAuditAction("Admin.key"), false);
    assert.equal(isValidAuditAction("memory..remember"), false);
    assert.equal(isValidAuditAction("a".repeat(65)), false);
    assert.equal(isValidAuditAction(null), false);
  });

  it("topic은 outbox topic 형식이다", () => {
    assert.equal(AUDIT_TOPIC, "audit.record");
  });
});

describe("행위자", () => {
  it("마스터, 키, 익명, 시스템을 구분한다", () => {
    assert.deepEqual(auditActor({ keyId: "master", sessionId: "c1a2b3c4d", clientIp: "203.0.113.7" }),
      { kind: "master", keyId: null, session: "c1a2b3c4", ip: "203.0.113.7" });
    assert.deepEqual(auditActor({ keyId: KEY_ID, sessionId: "0f8e2d6c-9999-4000-8000-000000000000" }),
      { kind: "key", keyId: KEY_ID, session: "0f8e2d6c", ip: null });
    assert.equal(auditActor({ keyId: "none" }).kind, "anonymous");
    assert.equal(auditActor({ keyId: "unknown", clientIp: "1.2.3.4" }).kind, "anonymous");
    assert.equal(auditActor(null).kind, "anonymous");
    assert.deepEqual(auditActor("system"), { kind: "system", keyId: null, session: null, ip: null });
  });

  it("관리자 계정 행위자는 계정 id를 keyId 자리에 담고, payload 판독에서 id 없는 계정 행위자는 거부한다", () => {
    const userId = "0b9d6a3e-5c1f-4e2a-8d7b-112233445566";
    assert.deepEqual(auditActor({ adminUserId: userId, sessionId: "u1a2b3c4d", clientIp: "203.0.113.9" }),
      { kind: "admin", keyId: userId, session: "u1a2b3c4", ip: "203.0.113.9" });
    const payload = buildAuditPayload({ action: "admin.user.create", actor: { adminUserId: userId } });
    assert.equal(readAuditPayload(JSON.parse(JSON.stringify(payload))).actorKind, "admin");
    assert.equal(readAuditPayload(JSON.parse(JSON.stringify(payload))).actorKeyId, userId);
    const forged = { ...payload, actor: { kind: "admin", keyId: null, session: null, ip: null } };
    assert.throws(() => readAuditPayload(forged), (e) => e instanceof AuditEventError && e.field === "actor");
    assert.equal(auditActor({ adminUserId: "x y" }).kind, "anonymous");
  });

  it("키 형식이 아닌 keyId는 키 행위자로 보지 않는다", () => {
    assert.equal(auditActor({ keyId: "x y;z" }).kind, "anonymous");
  });
});

describe("본문 지문", () => {
  it("sha256과 문자 길이만 돌려준다", () => {
    const fp = contentFingerprint("안녕 memento");
    assert.equal(fp.sha256, crypto.createHash("sha256").update("안녕 memento", "utf8").digest("hex"));
    assert.equal(fp.length, 10);
    assert.deepEqual(Object.keys(fp).sort(), ["length", "sha256"]);
  });

  it("문자열이 아니면 null이다", () => {
    assert.equal(contentFingerprint(undefined), null);
    assert.equal(contentFingerprint(42), null);
  });
});

describe("detail 정리", () => {
  it("본문과 비밀을 가리키는 키는 거부한다", () => {
    for (const key of ["content", "body", "token", "password", "apiKey", "api_key", "Authorization", "cookie", "secretValue", "contextSummary", "rawKey"]) {
      assert.throws(() => sanitizeAuditDetail({ [key]: "x" }), AuditEventError, key);
    }
  });

  it("중첩 객체 안의 금지 키도 거부한다", () => {
    assert.throws(() => sanitizeAuditDetail({ after: { content: "x" } }), AuditEventError);
  });

  it("Sha256과 Length 접미 키는 지문 형식일 때만 받는다", () => {
    const ok = sanitizeAuditDetail({ contentSha256: "b".repeat(64), contentLength: 12 });
    assert.deepEqual(ok, { contentSha256: "b".repeat(64), contentLength: 12 });
    assert.throws(() => sanitizeAuditDetail({ contentSha256: "본문 그대로" }), AuditEventError);
    assert.throws(() => sanitizeAuditDetail({ contentLength: -1 }), AuditEventError);
    assert.throws(() => sanitizeAuditDetail({ contentLength: "12" }), AuditEventError);
  });

  it("문자열 값의 비밀 형식은 가리고 길이를 제한하며 제어 문자를 지운다", () => {
    const secret = "sk-ant-api03-" + "A".repeat(90);
    const out    = sanitizeAuditDetail({ note: `key ${secret}`, long: "x".repeat(DETAIL_STRING_MAX + 50), ctl: "a\u0000b\nc" });
    assert.ok(!out.note.includes(secret), out.note);
    assert.equal(out.long.length, DETAIL_STRING_MAX);
    assert.equal(out.ctl, "a b c");
  });

  it("배열은 스칼라만, 상한까지 받는다", () => {
    const out = sanitizeAuditDetail({ changed: Array.from({ length: DETAIL_ARRAY_MAX + 5 }, (_, i) => `f${i}`) });
    assert.equal(out.changed.length, DETAIL_ARRAY_MAX);
    assert.throws(() => sanitizeAuditDetail({ list: [{ a: 1 }] }), AuditEventError);
  });

  it("유한하지 않은 수, 함수, 너무 깊은 중첩은 거부한다", () => {
    assert.throws(() => sanitizeAuditDetail({ n: Number.POSITIVE_INFINITY }), AuditEventError);
    assert.throws(() => sanitizeAuditDetail({ f: () => 1 }), AuditEventError);
    assert.throws(() => sanitizeAuditDetail({ a: { b: { c: { d: 1 } } } }), AuditEventError);
  });

  it("undefined 값은 빠지고 생략한 detail은 빈 객체다", () => {
    assert.deepEqual(sanitizeAuditDetail({ a: undefined, b: null }), { b: null });
    assert.deepEqual(sanitizeAuditDetail(undefined), {});
  });

  it("일반 객체가 아니면 거부한다", () => {
    assert.throws(() => sanitizeAuditDetail([1]), AuditEventError);
    assert.throws(() => sanitizeAuditDetail("x"), AuditEventError);
  });
});

describe("payload 구성과 판독", () => {
  const base = {
    action    : "memory.remember",
    actor     : { keyId: KEY_ID, sessionId: "abcdef0123", clientIp: "::1" },
    target    : { type: "fragment", id: "frag-1" },
    workspace : "team-a",
    detail    : { contentSha256: "c".repeat(64), contentLength: 3, type: "fact" },
    occurredAt: new Date("2026-10-03T01:02:03.004Z")
  };

  it("구성한 payload를 다시 읽으면 같은 기록 값이 나온다", () => {
    const payload = buildAuditPayload(base);
    const record  = readAuditPayload(JSON.parse(JSON.stringify(payload)));
    assert.deepEqual(record, {
      occurredAt  : "2026-10-03T01:02:03.004Z",
      action      : "memory.remember",
      outcome     : "success",
      actorKind   : "key",
      actorKeyId  : KEY_ID,
      actorSession: "abcdef01",
      actorIp     : "::1",
      targetType  : "fragment",
      targetId    : "frag-1",
      workspace   : "team-a",
      detail      : { contentSha256: "c".repeat(64), contentLength: 3, type: "fact" }
    });
  });

  it("행위 이름, 결과, 대상 유형이 틀리면 거부한다", () => {
    assert.throws(() => buildAuditPayload({ ...base, action: "Bad Action" }), (e) => e instanceof AuditEventError && e.field === "action");
    assert.throws(() => buildAuditPayload({ ...base, outcome: "ok" }), (e) => e.field === "outcome");
    assert.throws(() => buildAuditPayload({ ...base, target: { type: "Fragment!", id: "x" } }), (e) => e.field === "target");
  });

  it("대상 id와 workspace는 길이 상한으로 자른다", () => {
    const record = readAuditPayload(buildAuditPayload({ ...base, target: { type: "fragment", id: "x".repeat(300) }, workspace: "w".repeat(300) }));
    assert.equal(record.targetId.length, 200);
    assert.equal(record.workspace.length, 128);
  });

  it("판독은 판이 다르거나 형식이 깨진 payload를 거부한다", () => {
    assert.throws(() => readAuditPayload({ ...buildAuditPayload(base), v: 2 }), AuditEventError);
    assert.throws(() => readAuditPayload({ ...buildAuditPayload(base), occurredAt: "어제" }), AuditEventError);
    assert.throws(() => readAuditPayload({ ...buildAuditPayload(base), detail: { content: "본문" } }), AuditEventError);
    assert.throws(() => readAuditPayload(null), AuditEventError);
  });

  it("대상과 workspace를 생략하면 null이다", () => {
    const record = readAuditPayload(buildAuditPayload({ action: "admin.sessions.cleanup", actor: "system" }));
    assert.equal(record.targetType, null);
    assert.equal(record.targetId, null);
    assert.equal(record.workspace, null);
    assert.equal(record.actorKind, "system");
  });
});

describe("HTTP 상태의 결과 분류", () => {
  it("400 미만은 성공, 401과 403은 거부, 그 밖의 오류는 실패다", () => {
    assert.equal(outcomeForStatus(200), "success");
    assert.equal(outcomeForStatus(204), "success");
    assert.equal(outcomeForStatus(401), "denied");
    assert.equal(outcomeForStatus(403), "denied");
    assert.equal(outcomeForStatus(404), "failure");
    assert.equal(outcomeForStatus(500), "failure");
  });
});
