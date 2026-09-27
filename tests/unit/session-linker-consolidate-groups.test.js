/**
 * SessionLinker.consolidateSessionFragments 그룹 분리 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-15
 * 수정일: 2026-09-28 (DB 파편은 재종합하지 않고 WM 전용 항목만 종합)
 *
 * 검증 범위:
 * - workspace → case_id → topic 우선순위 경계로 그룹 배열 반환
 * - 이미 영속화된 DB 파편은 새 종합 내용이 되지 않음
 * - Working Memory 항목이 대응 DB 파편에 편입되거나 자체 workspace/topic 그룹으로 귀속
 * - error는 [해결됨] 표기가 있을 때만 errors_resolved, 그 외는 errors_open
 * - 새 내용도 evict할 WM 항목도 없는 그룹은 결과에서 제외, 전체가 비면 null
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

import { SessionLinker } from "../../lib/memory/link/SessionLinker.js";

function makeRow(overrides = {}) {
  return {
    id      : "row-id",
    content : "내용",
    type    : "fact",
    workspace: null,
    case_id : null,
    topic   : null,
    ...overrides,
  };
}

function makeLinker({ ids = [], rows = [], wmItems = [] } = {}) {
  const store = {
    getByIds: mock.fn(async () => rows),
  };
  const index = {
    getSessionFragments: mock.fn(async () => ids),
    getWorkingMemory   : mock.fn(async () => wmItems),
  };
  return new SessionLinker(store, index);
}

describe("SessionLinker.consolidateSessionFragments — 그룹 분리", () => {

  it("DB 파편만 있는 세션은 새로 종합할 내용이 없어 null을 반환한다", async () => {
    const rows = [
      makeRow({ id: "d1", type: "decision", content: "결정: Redis 캐시 레이어 도입", workspace: "proj-a", topic: "nginx" }),
      makeRow({ id: "e1", type: "error",    content: "NPE 원인 파악 완료",           workspace: "proj-a", topic: "nginx" }),
      makeRow({ id: "p1", type: "episode",  content: "세션 sess-1xx... 종합: 이전 종합", workspace: "proj-a", topic: "session_reflect" }),
    ];
    const linker = makeLinker({ ids: ["d1", "e1", "p1"], rows });
    const groups = await linker.consolidateSessionFragments("sess-1", "default", null);

    assert.equal(groups, null);
  });

  it("서로 다른 workspace의 WM 항목은 별도 그룹으로 분리된다", async () => {
    const wmItems = [
      { id: "a1", type: "decision", content: "프로젝트 A 결정: TypeScript 채택", workspace: "proj-a", topic: "lang" },
      { id: "b1", type: "decision", content: "프로젝트 B 결정: Go 채택",         workspace: "proj-b", topic: "lang" },
    ];
    const linker = makeLinker({ wmItems });
    const groups = await linker.consolidateSessionFragments("sess-2", "default", null);

    assert.equal(groups.length, 2);
    const byWs = Object.fromEntries(groups.map(g => [g.workspace, g.decisions]));
    assert.deepEqual(byWs["proj-a"], ["프로젝트 A 결정: TypeScript 채택"]);
    assert.deepEqual(byWs["proj-b"], ["프로젝트 B 결정: Go 채택"]);
  });

  it("DB 파편에 대응하는 WM 항목은 파편의 case_id 그룹으로 편입된다", async () => {
    const rows = [
      makeRow({ id: "c1", type: "error", content: "케이스1 에러 해결 완료", workspace: "proj-a", case_id: "case-1" }),
      makeRow({ id: "c2", type: "error", content: "케이스2 에러 해결 완료", workspace: "proj-a", case_id: "case-2" }),
    ];
    const wmItems = [
      { id: "c1", type: "error", content: "케이스1 에러 해결 완료", workspace: "proj-a" },
      { id: "c2", type: "error", content: "케이스2 에러 해결 완료", workspace: "proj-a" },
    ];
    const linker = makeLinker({ ids: ["c1", "c2"], rows, wmItems });
    const groups = await linker.consolidateSessionFragments("sess-3", "default", null);

    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(g => g.caseId).sort(), ["case-1", "case-2"]);
    for (const g of groups) {
      assert.deepEqual(g.errors_resolved, []);
      assert.deepEqual(g.errors_open, []);
      assert.equal(g.summary, null);
      assert.equal(g.wmItemIds.length, 1);
    }
  });

  it("case_id가 없으면 WM 항목의 topic 경계로 분리된다", async () => {
    const wmItems = [
      { id: "t1", type: "fact", content: "nginx 설정 변경 사실 기록", workspace: "proj-a", topic: "nginx" },
      { id: "t2", type: "fact", content: "redis 캐시 설정 사실 기록", workspace: "proj-a", topic: "redis" },
    ];
    const linker = makeLinker({ wmItems });
    const groups = await linker.consolidateSessionFragments("sess-4", "default", null);

    assert.equal(groups.length, 2);
    const topics = groups.map(g => g.topic).sort();
    assert.deepEqual(topics, ["nginx", "redis"]);
  });

  it("DB 파편과 id가 일치하는 WM 항목은 evict 대상으로만 편입되고 내용은 다시 종합되지 않는다", async () => {
    const rows = [
      makeRow({ id: "d1", type: "decision", content: "결정: PostgreSQL 16 채택", workspace: "proj-a", topic: "db" }),
    ];
    const wmItems = [
      { id: "d1", content: "결정: PostgreSQL 16 채택", type: "decision", topic: "db" },
    ];
    const linker = makeLinker({ ids: ["d1"], rows, wmItems });
    const groups = await linker.consolidateSessionFragments("sess-5", "default", null);

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].decisions, []);
    assert.deepEqual(groups[0].wmItemIds, ["d1"]);
    assert.deepEqual(groups[0].sourceFragmentIds, ["d1"]);
  });

  it("WM error는 [해결됨] 표기가 있을 때만 errors_resolved로 분류된다", async () => {
    const wmItems = [
      { id: "w1", type: "error", content: "배치 큐 타임아웃 원인을 아직 찾지 못했다", topic: "queue" },
      { id: "w2", type: "error", content: "[해결됨] 배치 큐 커넥션 누수를 풀 반환으로 해결", topic: "queue" },
    ];
    const linker = makeLinker({ wmItems });
    const groups = await linker.consolidateSessionFragments("sess-9", "default", null);

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].errors_open, ["배치 큐 타임아웃 원인을 아직 찾지 못했다"]);
    assert.deepEqual(groups[0].errors_resolved, ["배치 큐 커넥션 누수를 풀 반환으로 해결"]);
  });

  it("사실 없이 결정만 있는 WM 그룹은 건수 요약을 만들지 않는다", async () => {
    const wmItems = [
      { id: "w1", type: "decision", content: "배치 큐는 단일 큐로 운영하기로 결정", topic: "queue" },
    ];
    const linker = makeLinker({ wmItems });
    const groups = await linker.consolidateSessionFragments("sess-10", "default", null);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].summary, null);
    assert.deepEqual(groups[0].decisions, ["배치 큐는 단일 큐로 운영하기로 결정"]);
  });

  it("DB 파편과 id가 일치하지 않는 WM 항목은 자체 topic 그룹으로 귀속된다", async () => {
    const rows    = [];
    const wmItems = [
      { id: "wm-only-1", content: "임시 메모: 배포 창구는 화요일 오전으로 고정", type: "fact", topic: "deploy" },
    ];
    const linker = makeLinker({ ids: [], rows, wmItems });
    const groups = await linker.consolidateSessionFragments("sess-6", "default", null);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].workspace, null);
    assert.equal(groups[0].topic, "deploy");
    assert.equal(groups[0].wmItemIds.length, 1);
    assert.ok(groups[0].summary.includes("배포 창구는 화요일 오전으로 고정"));
  });

  it("세션 파편과 WM이 모두 없으면 null 반환", async () => {
    const linker = makeLinker({ ids: [], rows: [], wmItems: [] });
    const groups = await linker.consolidateSessionFragments("sess-7", "default", null);
    assert.equal(groups, null);
  });

  it("내용이 비어 있는 그룹은 결과에서 제외되고 전체가 비면 null", async () => {
    const rows = [
      makeRow({ id: "blank-1", type: "fact", content: "   ", workspace: "proj-a" }),
    ];
    const linker = makeLinker({ ids: ["blank-1"], rows });
    const groups = await linker.consolidateSessionFragments("sess-8", "default", null);
    assert.equal(groups, null);
  });
});
