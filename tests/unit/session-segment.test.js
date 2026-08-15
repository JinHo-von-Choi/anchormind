/**
 * 세션 세그먼트(파생 논리 세션 ID) 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-15
 *
 * lib/sessions.js currentSegmentId / lib/tools/memory.js resolveSegmentedSessionId /
 * 조회 계층(reconstruct.js, admin-sessions.js) family LIKE 패턴의 핵심 분기를
 * 순수 함수로 재현해 Redis/PostgreSQL 의존성 없이 검증한다. 이 파일의 재현 로직은
 * 실제 구현과 1:1로 대응하며, 실제 구현이 바뀌면 함께 갱신해야 한다.
 *
 * 1. 세그먼트 회전 조건 — 유휴(idleMs) 초과, 절대 수명(maxAgeMs) 초과, 미초과 시 유지
 * 2. 명시 sessionId 비적용 — 클라이언트가 sessionId를 직접 전달하면 세그먼트로 덮어쓰지 않음
 * 3. 패밀리 조회 — 원본 ID로 파생 세그먼트 전체를 포함하는 LIKE 패턴/집합 매칭
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/* 1. 세그먼트 회전 — lib/sessions.js advanceSegment 재현                */
/* ------------------------------------------------------------------ */

function advanceSegment(session, now, { idleMs, maxAgeMs }) {
  if (session.segmentSeq == null)         session.segmentSeq         = 1;
  if (session.segmentStartedAt == null)   session.segmentStartedAt   = session.createdAt ?? now;
  if (session.lastToolActivityAt == null) session.lastToolActivityAt = session.segmentStartedAt;

  const idleExpired = (now - session.lastToolActivityAt) > idleMs;
  const ageExpired   = (now - session.segmentStartedAt)  > maxAgeMs;

  let previousSeq = null;

  if (idleExpired || ageExpired) {
    previousSeq               = session.segmentSeq;
    session.segmentSeq        = session.segmentSeq + 1;
    session.segmentStartedAt  = now;
  }

  session.lastToolActivityAt = now;

  return previousSeq;
}

const IDLE_MS    = 2_700_000;   // 45분
const MAX_AGE_MS = 43_200_000;  // 12시간

describe("세션 세그먼트 회전 조건", () => {
  it("TC1: 신규 세션 첫 호출 — 회전 없이 segmentSeq=1로 초기화", () => {
    const now     = Date.now();
    const session = { createdAt: now };

    const previousSeq = advanceSegment(session, now, { idleMs: IDLE_MS, maxAgeMs: MAX_AGE_MS });

    assert.equal(previousSeq, null);
    assert.equal(session.segmentSeq, 1);
    assert.equal(session.lastToolActivityAt, now);
  });

  it("TC2: 유휴 idleMs 초과 → 회전, segmentSeq 증가 + segmentStartedAt 갱신", () => {
    const start   = Date.now();
    const session = {
      createdAt         : start,
      segmentSeq        : 1,
      segmentStartedAt  : start,
      lastToolActivityAt: start
    };
    const now = start + IDLE_MS + 1;

    const previousSeq = advanceSegment(session, now, { idleMs: IDLE_MS, maxAgeMs: MAX_AGE_MS });

    assert.equal(previousSeq, 1);
    assert.equal(session.segmentSeq, 2);
    assert.equal(session.segmentStartedAt, now);
  });

  it("TC3: 유휴 idleMs와 정확히 동일(경계) → 회전하지 않음(> 비교, >= 아님)", () => {
    const start   = Date.now();
    const session = {
      createdAt: start, segmentSeq: 1, segmentStartedAt: start, lastToolActivityAt: start
    };
    const now = start + IDLE_MS;

    const previousSeq = advanceSegment(session, now, { idleMs: IDLE_MS, maxAgeMs: MAX_AGE_MS });

    assert.equal(previousSeq, null);
    assert.equal(session.segmentSeq, 1);
  });

  it("TC4: 유휴는 미초과지만 절대 수명(maxAgeMs) 초과 → 회전", () => {
    const start   = Date.now();
    const session = {
      createdAt         : start,
      segmentSeq         : 1,
      segmentStartedAt   : start,
      lastToolActivityAt : start + MAX_AGE_MS - 1000 /** 최근 활동 — 유휴 아님 */
    };
    const now = start + MAX_AGE_MS + 1;

    const previousSeq = advanceSegment(session, now, { idleMs: IDLE_MS, maxAgeMs: MAX_AGE_MS });

    assert.equal(previousSeq, 1);
    assert.equal(session.segmentSeq, 2);
  });

  it("TC5: 유휴·수명 모두 미초과 → 회전 없음, lastToolActivityAt만 갱신", () => {
    const start   = Date.now();
    const session = {
      createdAt: start, segmentSeq: 3, segmentStartedAt: start, lastToolActivityAt: start
    };
    const now = start + 60_000;

    const previousSeq = advanceSegment(session, now, { idleMs: IDLE_MS, maxAgeMs: MAX_AGE_MS });

    assert.equal(previousSeq, null);
    assert.equal(session.segmentSeq, 3);
    assert.equal(session.lastToolActivityAt, now);
  });

  it("TC6: 연속 회전 — segmentSeq가 1→2→3으로 순차 증가하며 직전 seq를 정확히 반환", () => {
    const start   = Date.now();
    const session = { createdAt: start };

    advanceSegment(session, start, { idleMs: IDLE_MS, maxAgeMs: MAX_AGE_MS });
    assert.equal(session.segmentSeq, 1);

    const t2   = start + IDLE_MS + 1;
    const prev1 = advanceSegment(session, t2, { idleMs: IDLE_MS, maxAgeMs: MAX_AGE_MS });
    assert.equal(prev1, 1);
    assert.equal(session.segmentSeq, 2);

    const t3   = t2 + IDLE_MS + 1;
    const prev2 = advanceSegment(session, t3, { idleMs: IDLE_MS, maxAgeMs: MAX_AGE_MS });
    assert.equal(prev2, 2);
    assert.equal(session.segmentSeq, 3);
  });

  it("TC7: sessionSegment.enabled=false — currentSegmentId는 원본 ID를 그대로 반환(회전 로직 미도달)", () => {
    function currentSegmentIdDisabled(sessionId, enabled) {
      if (!sessionId) return sessionId;
      if (!enabled) return sessionId;
      throw new Error("disabled 상태에서는 회전 로직에 도달하지 않아야 함");
    }

    assert.equal(currentSegmentIdDisabled("raw-transport-id", false), "raw-transport-id");
  });
});

/* ------------------------------------------------------------------ */
/* 2. 명시 sessionId 비적용 — lib/tools/memory.js resolveSegmentedSessionId 재현 */
/* ------------------------------------------------------------------ */

async function resolveSegmentedSessionIdLocal(args, currentSegmentIdFn) {
  const rawSessionId = args._sessionId;
  delete args._sessionId;

  if (!rawSessionId) return rawSessionId;

  const segmentId = await currentSegmentIdFn(rawSessionId);

  if (!args.sessionId) args.sessionId = segmentId;

  return segmentId;
}

describe("명시 sessionId 비적용 — 세그먼트는 _sessionId 폴백 경로에만 적용", () => {
  it("TC8: 클라이언트가 sessionId를 명시 전달 — args.sessionId 유지, 세그먼트로 덮어쓰지 않음", async () => {
    const args = { _sessionId: "transport-abc", sessionId: "client-custom-session" };
    const currentSegmentIdFn = mock.fn(async (id) => `${id}#3`);

    const segmentId = await resolveSegmentedSessionIdLocal(args, currentSegmentIdFn);

    assert.equal(args.sessionId, "client-custom-session", "클라이언트 명시값이 유지되어야 함");
    assert.ok(!("_sessionId" in args), "_sessionId는 삭제되어야 함");
    assert.equal(currentSegmentIdFn.mock.callCount(), 1, "활동 추적용 세그먼트 조회는 계속 수행됨");
    assert.equal(segmentId, "transport-abc#3");
  });

  it("TC9: 클라이언트가 sessionId를 전달하지 않음 — 파생 세그먼트 ID로 승격", async () => {
    const args = { _sessionId: "transport-xyz" };
    const currentSegmentIdFn = mock.fn(async (id) => `${id}#1`);

    const segmentId = await resolveSegmentedSessionIdLocal(args, currentSegmentIdFn);

    assert.equal(args.sessionId, "transport-xyz#1");
    assert.equal(segmentId, "transport-xyz#1");
  });

  it("TC10: 전송계층 세션 없음(_sessionId 없음) — args.sessionId 불변, currentSegmentId 미호출", async () => {
    const args = { sessionId: "client-only" };
    const currentSegmentIdFn = mock.fn(async (id) => `${id}#1`);

    const segmentId = await resolveSegmentedSessionIdLocal(args, currentSegmentIdFn);

    assert.equal(args.sessionId, "client-only");
    assert.equal(currentSegmentIdFn.mock.callCount(), 0);
    assert.equal(segmentId, undefined);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 패밀리 조회 — 원본 ID → 파생 세그먼트 전체 포함 LIKE 패턴/집합 매칭  */
/* ------------------------------------------------------------------ */

/** lib/tools/reconstruct.js, lib/admin/admin-sessions.js와 동일한 이스케이프 규칙 */
function escapeLike(str) {
  return str.replace(/[%_\\]/g, "\\$&");
}

/** Postgres LIKE 패턴을 JS 정규식으로 변환해 검증 대상 값과 대조한다 */
function likeMatch(value, pattern) {
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      regex += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") {
      regex += ".*";
    } else if (ch === "_") {
      regex += ".";
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`).test(value);
}

describe("패밀리 조회 — 원본 세션 ID로 파생 세그먼트 포함", () => {
  it("TC11: 원본 ID로 만든 family 패턴이 파생 세그먼트를 매칭", () => {
    const original = "550e8400-e29b-41d4-a716-446655440000";
    const pattern   = `${escapeLike(original)}#%`;

    assert.ok(likeMatch(`${original}#1`,  pattern));
    assert.ok(likeMatch(`${original}#42`, pattern));
    assert.ok(!likeMatch(original, pattern), "원본 ID 자체는 LIKE가 아닌 등호(=) 조건에서 별도로 매칭됨");
    assert.ok(!likeMatch("other-session#1", pattern));
  });

  it("TC12: LIKE 와일드카드 문자가 포함된 세션 ID도 안전하게 이스케이프", () => {
    const original = "sess_100%weird";
    const pattern   = `${escapeLike(original)}#%`;

    assert.ok(likeMatch(`${original}#2`, pattern));
    assert.ok(!likeMatch("sessX100Yweird#2", pattern), "이스케이프된 _, % 는 와일드카드가 아닌 리터럴로만 매칭");
  });

  it("TC13: admin-sessions.js orphan 판정 — 세그먼트 ID를 원본 ID로 환원 후 활성 세션과 대조", () => {
    const activeIds   = new Set(["sess-active-1", "sess-active-2"]);
    const unreflected = ["sess-active-1#2", "sess-closed-1#1", "sess-active-2#5"];

    const orphan = unreflected.filter(sid => !activeIds.has(sid.split("#")[0]));

    assert.deepEqual(orphan, ["sess-closed-1#1"]);
  });

  it("TC14: 세그먼트 미적용(원본 ID에 '#' 없음) 상태에서도 family 필터가 회귀 없이 동작", () => {
    const activeIds   = new Set(["legacy-session-1"]);
    const unreflected = ["legacy-session-1", "legacy-session-2"];

    const orphan = unreflected.filter(sid => !activeIds.has(sid.split("#")[0]));

    assert.deepEqual(orphan, ["legacy-session-2"]);
  });
});
