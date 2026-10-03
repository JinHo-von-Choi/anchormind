/**
 * SearchScope 파편 단위 workspace 허가 범위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 읽기 관문이 enforce에서 범위 제한 키의 요청에 붙인 허가 범위(_workspaceReadRange)는 recall 검색 질의로
 * 이어져 SearchScope.fromQuery가 readRange로 받는다. applyTo는 workspace-read-policy의 isWorkspaceReadable로
 * 범위 밖 workspace 파편을 거른다. 범위가 없으면(warn, off, 범위 없는 키, master) 기존 판정과 같다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { SearchScope }             from "../../lib/memory/read/SearchScope.js";
import { buildRecallSearchQuery }  from "../../lib/memory/processors/MemoryRecaller.js";

const frag = (workspace) => ({ id: `f-${workspace}`, workspace, agent_id: "default" });

describe("SearchScope readRange", () => {
  it("범위가 없으면 전체 workspace 조회에서 모든 파편을 통과시킨다", () => {
    const scope = new SearchScope({ allWorkspaces: true, agentId: null });
    for (const ws of [null, "ws-a", "ws-b"]) assert.equal(scope.applyTo(frag(ws)), true, String(ws));
    assert.equal(scope.readRange, null);
  });

  it("범위가 있으면 전체 workspace 조회에서도 범위 밖 파편을 거른다", () => {
    const scope = new SearchScope({ allWorkspaces: true, agentId: null, readRange: ["ws-a"] });
    assert.equal(scope.applyTo(frag("ws-a")), true);
    assert.equal(scope.applyTo(frag(null)), true);
    assert.equal(scope.applyTo(frag("ws-b")), false);
  });

  it("범위 판정은 기존 workspace 조건과 함께 적용된다", () => {
    const scope = new SearchScope({ workspace: "ws-b", agentId: null, readRange: ["ws-a"] });
    assert.equal(scope.applyTo(frag("ws-b")), false);
    assert.equal(scope.applyTo(frag("ws-a")), false);
    assert.equal(scope.applyTo(frag(null)), true);
  });

  it("범위가 있으면 noop이 아니다", () => {
    assert.equal(new SearchScope({ allWorkspaces: true, agentId: null }).isNoop(), true);
    assert.equal(new SearchScope({ allWorkspaces: true, agentId: null, readRange: ["ws-a"] }).isNoop(), false);
  });

  it("fromQuery는 질의의 readRange를 받는다", () => {
    const scope = SearchScope.fromQuery({ allWorkspaces: true, readRange: ["ws-a"] });
    assert.deepEqual(scope.readRange, ["ws-a"]);
    assert.equal(scope.applyTo(frag("ws-b")), false);
  });
});

describe("recall 검색 질의의 허가 범위 전달", () => {
  const ctx = { fragmentCount: 0, anchorTime: 0, agentId: "default", groupKeyIds: ["k"], workspace: "ws-a", allWorkspaces: false };

  it("관문이 붙인 허가 범위를 검색 질의의 readRange로 옮긴다", () => {
    const q = buildRecallSearchQuery({ keywords: ["x"], _workspaceReadRange: ["ws-a"] }, ctx);
    assert.deepEqual(q.readRange, ["ws-a"]);
    assert.deepEqual(SearchScope.fromQuery(q).readRange, ["ws-a"]);
  });

  it("허가 범위가 없으면 검색 질의에 readRange가 없다", () => {
    const q = buildRecallSearchQuery({ keywords: ["x"] }, ctx);
    assert.equal(Object.hasOwn(q, "readRange"), false);
  });
});

describe("SearchScope 생성 위치의 허가 범위 전달", () => {
  it("객체 리터럴로 SearchScope를 만드는 운영 코드는 readRange를 넘긴다", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "../../lib");
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js")) files.push(full);
      }
    };
    walk(root);
    const missing = [];
    let   seen    = 0;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(new SearchScope|SearchScope\.fromQuery)\(\{/g)) {
        const body = src.slice(m.index, src.indexOf("});", m.index));
        seen++;
        if (!/\breadRange\s*:/.test(body)) missing.push(`${path.relative(root, file)}:${m.index}`);
      }
    }
    assert.ok(seen >= 2);
    assert.deepEqual(missing, []);
  });
});
