/**
 * SessionLinker.consolidateSessionFragments 그룹 분리 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-15
 *
 * 검증 범위:
 * - workspace → case_id → topic 우선순위 경계로 그룹 배열 반환
 * - Working Memory 항목이 대응 DB 파편에 편입되거나 자체 topic 그룹으로 귀속
 * - 각 그룹의 wmItemIds/sourceFragmentIds 반환
 * - 콘텐츠가 전혀 없는 그룹은 결과에서 제외, 전체가 비면 null
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

  it("단일 workspace/topic 세션은 그룹 1개로 종합된다", async () => {
    const rows = [
      makeRow({ id: "d1", type: "decision", content: "결정: Redis 캐시 레이어 도입", workspace: "proj-a", topic: "nginx" }),
      makeRow({ id: "e1", type: "error",    content: "NPE 원인 파악 완료",           workspace: "proj-a", topic: "nginx" }),
    ];
    const linker  = makeLinker({ ids: ["d1", "e1"], rows });
    const groups  = await linker.consolidateSessionFragments("sess-1", "default", null);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].workspace, "proj-a");
    assert.equal(groups[0].topic, "nginx");
    assert.deepEqual(groups[0].decisions, ["결정: Redis 캐시 레이어 도입"]);
    assert.deepEqual(groups[0].errors_resolved, ["NPE 원인 파악 완료"]);
    assert.deepEqual(groups[0].sourceFragmentIds.sort(), ["d1", "e1"]);
  });

  it("서로 다른 workspace는 별도 그룹으로 분리된다", async () => {
    const rows = [
      makeRow({ id: "a1", type: "decision", content: "프로젝트 A 결정: TypeScript 채택", workspace: "proj-a" }),
      makeRow({ id: "b1", type: "decision", content: "프로젝트 B 결정: Go 채택",         workspace: "proj-b" }),
    ];
    const linker = makeLinker({ ids: ["a1", "b1"], rows });
    const groups = await linker.consolidateSessionFragments("sess-2", "default", null);

    assert.equal(groups.length, 2);
    const workspaces = groups.map(g => g.workspace).sort();
    assert.deepEqual(workspaces, ["proj-a", "proj-b"]);
  });

  it("동일 workspace 내 서로 다른 case_id는 별도 그룹으로 분리된다", async () => {
    const rows = [
      makeRow({ id: "c1", type: "error", content: "케이스1 에러 해결 완료", workspace: "proj-a", case_id: "case-1" }),
      makeRow({ id: "c2", type: "error", content: "케이스2 에러 해결 완료", workspace: "proj-a", case_id: "case-2" }),
    ];
    const linker = makeLinker({ ids: ["c1", "c2"], rows });
    const groups = await linker.consolidateSessionFragments("sess-3", "default", null);

    assert.equal(groups.length, 2);
    const caseIds = groups.map(g => g.caseId).sort();
    assert.deepEqual(caseIds, ["case-1", "case-2"]);
  });

  it("case_id가 없으면 topic 경계로 분리된다", async () => {
    const rows = [
      makeRow({ id: "t1", type: "fact", content: "nginx 설정 변경 사실 기록", workspace: "proj-a", topic: "nginx" }),
      makeRow({ id: "t2", type: "fact", content: "redis 캐시 설정 사실 기록", workspace: "proj-a", topic: "redis" }),
    ];
    const linker = makeLinker({ ids: ["t1", "t2"], rows });
    const groups = await linker.consolidateSessionFragments("sess-4", "default", null);

    assert.equal(groups.length, 2);
    const topics = groups.map(g => g.topic).sort();
    assert.deepEqual(topics, ["nginx", "redis"]);
  });

  it("DB 파편과 id가 일치하는 WM 항목은 동일 그룹에 편입되고 내용은 중복되지 않는다", async () => {
    const rows = [
      makeRow({ id: "d1", type: "decision", content: "결정: PostgreSQL 16 채택", workspace: "proj-a", topic: "db" }),
    ];
    const wmItems = [
      { id: "d1", content: "결정: PostgreSQL 16 채택", type: "decision", topic: "db" },
    ];
    const linker = makeLinker({ ids: ["d1"], rows, wmItems });
    const groups = await linker.consolidateSessionFragments("sess-5", "default", null);

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].decisions, ["결정: PostgreSQL 16 채택"]);
    assert.deepEqual(groups[0].wmItemIds, ["d1"]);
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
