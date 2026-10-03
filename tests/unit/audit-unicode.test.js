/**
 * 감사 값의 유니코드 정규화와 자르기 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 길이 상한 경계마다 그림 문자(서로게이트 쌍)를 놓고, 홀로 남은 서로게이트를 넣어도 기록 값이 올바른 유니코드이며
 * 코드 포인트 단위로 잘리는지, 그리고 DB 왕복(text는 UTF-8, detail은 jsonb)을 흉내 낸 값의 해시가 기록 때의 해시와
 * 같은지 본다. 목록 비교가 아니라 성질을 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  buildAuditPayload, readAuditPayload, sanitizeAuditDetail,
  DETAIL_STRING_MAX, TARGET_ID_MAX, WORKSPACE_MAX, ACTOR_SESSION_MAX, ACTOR_IP_MAX
} from "../../lib/logging/audit-event.js";
import { computeRowHash, GENESIS_HASH } from "../../lib/logging/audit-chain.js";

const EMOJI = "\u{1F600}";

/** UTF-8 text 열 왕복(Node는 홀로 남은 서로게이트를 U+FFFD로 바꿔 보낸다) */
const textRoundTrip = (s) => (s === null ? null : Buffer.from(s, "utf8").toString("utf8"));

/** 기록 값 전체의 DB 왕복 */
function stored(record) {
  const out = { ...record };
  for (const k of ["action", "outcome", "actorKind", "actorKeyId", "actorSession", "actorIp", "targetType", "targetId", "workspace"]) {
    out[k] = textRoundTrip(record[k]);
  }
  out.detail = JSON.parse(Buffer.from(JSON.stringify(record.detail), "utf8").toString("utf8"));
  return out;
}

const codePoints = (s) => [...s].length;
const isWellFormed = (s) => s === null || s.isWellFormed();

/** 상한 max의 경계(max-2..max+1)에 그림 문자를 두는 문자열들 */
function boundaryStrings(max) {
  const out = [];
  for (let at = Math.max(0, max - 2); at <= max + 1; at++) out.push("a".repeat(at) + EMOJI + "b".repeat(3));
  return out;
}

function recordFor(fields) {
  return readAuditPayload(JSON.parse(JSON.stringify(buildAuditPayload({
    action: "memory.forget",
    actor : { keyId: "6f1c0f7e-7777-4000-8000-000000000008", sessionId: fields.session ?? "abcdef01", clientIp: fields.ip ?? "203.0.113.1" },
    target: { type: "topic", id: fields.target ?? "t" },
    workspace: fields.workspace ?? null,
    detail: { note: fields.note ?? "n" }
  }))));
}

/** 기록 값과 왕복한 값의 해시가 같고 모든 문자열이 올바른 유니코드인지 본다 */
function assertStableHash(record, label) {
  const row = { ...record, seq: 1, sourceEvent: "audit.record:1", recordedAt: "2026-10-04T00:00:00.000Z" };
  for (const k of ["actorSession", "actorIp", "targetId", "workspace"]) assert.ok(isWellFormed(record[k]), `${label} ${k}`);
  assert.ok(isWellFormed(record.detail.note), `${label} detail`);
  assert.equal(computeRowHash(GENESIS_HASH, stored(row)), computeRowHash(GENESIS_HASH, row), label);
}

describe("경계의 그림 문자", () => {
  const cases = [
    ["target", TARGET_ID_MAX, (r) => r.targetId],
    ["workspace", WORKSPACE_MAX, (r) => r.workspace],
    ["note", DETAIL_STRING_MAX, (r) => r.detail.note],
    ["session", ACTOR_SESSION_MAX, (r) => r.actorSession],
    ["ip", ACTOR_IP_MAX, (r) => r.actorIp]
  ];
  for (const [field, max, pick] of cases) {
    it(`${field}: 코드 포인트 ${max}개 이하로 자르고 쌍을 가르지 않으며 해시가 왕복에서 같다`, () => {
      for (const value of boundaryStrings(max)) {
        const record = recordFor({ [field]: value });
        const out    = pick(record);
        assert.ok(codePoints(out) <= max, `${field} ${codePoints(out)}`);
        assert.ok(out.isWellFormed(), field);
        assert.ok(value.startsWith(out), `${field}: 앞부분을 그대로 남긴다`);
        assertStableHash(record, `${field}@${value.length}`);
      }
    });
  }

  it("코드 포인트 수가 상한 이하이면 그림 문자를 지우지 않는다", () => {
    const value = "a".repeat(TARGET_ID_MAX - 1) + EMOJI;
    assert.equal(recordFor({ target: value }).targetId, value);
  });
});

describe("홀로 남은 서로게이트", () => {
  for (const lone of ["\uD83D", "\uDE00", "x\uD83Dy", "\uDE00\uD83D"]) {
    it(`${JSON.stringify(lone)}는 U+FFFD로 바꾸고 해시가 왕복에서 같다`, () => {
      const record = recordFor({ target: lone, workspace: lone, note: lone, session: lone, ip: lone });
      for (const v of [record.targetId, record.workspace, record.detail.note, record.actorSession, record.actorIp]) {
        assert.ok(v.isWellFormed(), JSON.stringify(v));
        assert.ok(v.includes("�"));
      }
      assertStableHash(record, JSON.stringify(lone));
    });
  }

  it("detail 배열과 중첩 객체의 문자열도 바꾼다", () => {
    const out = sanitizeAuditDetail({ list: ["\uD83D", "ok"], after: { name: "z\uDE00" } });
    assert.ok(out.list[0].isWellFormed());
    assert.ok(out.after.name.isWellFormed());
    assert.doesNotThrow(() => JSON.parse(Buffer.from(JSON.stringify(out)).toString()));
  });
});

describe("대상과 workspace의 비밀 형식", () => {
  it("대상 id와 workspace의 비밀 형식은 표식으로 바꾼다", () => {
    const secret = "sk-ant-api03-" + "Q".repeat(90);
    const record = recordFor({ target: `topic ${secret}`, workspace: `ws ${secret}` });
    assert.ok(!record.targetId.includes(secret));
    assert.ok(!record.workspace.includes(secret));
  });
});

describe("짧은 비밀 키 이름", () => {
  it("code, otp, key, session, pin과 privateKey 계열 키 이름은 거부한다", () => {
    for (const key of ["code", "OTP", "key", "session", "pin", "privateKey", "private_key", "sshPrivateKey"]) {
      assert.throws(() => sanitizeAuditDetail({ [key]: "x" }), /담지 않는다/, key);
    }
  });

  it("그 이름을 포함하는 식별 키(errorCode, keyId, memberKeyId)는 받는다", () => {
    assert.deepEqual(sanitizeAuditDetail({ errorCode: "E", keyId: "k", memberKeyId: "m" }), { errorCode: "E", keyId: "k", memberKeyId: "m" });
  });
});
