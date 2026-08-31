/**
 * workspace anchor 예약 선택과 응답 정합성 테스트
 *
 * 모든 fixture는 합성 ID/content만 사용한다.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ContextBuilder,
  selectAnchorFragments,
} from "../../lib/memory/read/ContextBuilder.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadAnchorConfig(values = {}, validate = false) {
  const env = { ...process.env };
  delete env.MEMENTO_CONTEXT_ANCHOR_LIMIT;
  delete env.MEMENTO_CONTEXT_WORKSPACE_ANCHOR_RESERVE;
  Object.assign(env, values);
  const script = [
    `import { MEMORY_CONFIG } from "${path.join(ROOT, "config", "memory.js")}";`,
    validate
      ? `import { validateMemoryConfig } from "${path.join(ROOT, "config", "validate-memory-config.js")}"; validateMemoryConfig(MEMORY_CONFIG);`
      : "",
    "console.log(JSON.stringify(MEMORY_CONFIG.contextInjection));",
  ].join("");
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
  }).trim());
}

function anchor(id, importance, workspace = null, createdAt = "2026-01-01T00:00:00.000Z") {
  return {
    id,
    type: "fact",
    topic: "synthetic-anchor",
    content: `synthetic content ${id}`,
    importance,
    workspace,
    created_at: createdAt,
  };
}

function candidateRows(rows) {
  return rows.map(row => ({ ...row, candidate_count: String(rows.length) }));
}

describe("anchor 환경 설정", () => {
  it("미설정 시 total=20, workspace reserve=10", () => {
    const config = loadAnchorConfig();
    assert.equal(config.maxAnchorFragments, 20);
    assert.equal(config.workspaceAnchorReserve, 10);
  });

  it("total은 기존 1~30 클램프를 유지한다", () => {
    assert.equal(loadAnchorConfig({ MEMENTO_CONTEXT_ANCHOR_LIMIT: "0" }).maxAnchorFragments, 1);
    assert.equal(loadAnchorConfig({ MEMENTO_CONTEXT_ANCHOR_LIMIT: "30" }).maxAnchorFragments, 30);
    assert.equal(loadAnchorConfig({ MEMENTO_CONTEXT_ANCHOR_LIMIT: "999" }).maxAnchorFragments, 30);
  });

  it("reserve=0과 reserve=total은 검증을 통과한다", () => {
    assert.equal(loadAnchorConfig({ MEMENTO_CONTEXT_WORKSPACE_ANCHOR_RESERVE: "0" }, true).workspaceAnchorReserve, 0);
    assert.equal(loadAnchorConfig({
      MEMENTO_CONTEXT_ANCHOR_LIMIT: "20",
      MEMENTO_CONTEXT_WORKSPACE_ANCHOR_RESERVE: "20",
    }, true).workspaceAnchorReserve, 20);
  });

  for (const invalid of ["-1", "21", "1.5", "not-an-integer"]) {
    it(`잘못된 reserve=${invalid}는 검증 시 fail-fast`, () => {
      assert.throws(() => loadAnchorConfig({
        MEMENTO_CONTEXT_ANCHOR_LIMIT: "20",
        MEMENTO_CONTEXT_WORKSPACE_ANCHOR_RESERVE: invalid,
      }, true));
    });
  }
});

describe("workspace anchor 예약 선택", () => {
  const globals = Array.from({ length: 25 }, (_, i) => anchor(`global-${i + 1}`, 0.99 - i * 0.01));

  for (const count of [0, 1, 9, 10, 15]) {
    it(`workspace 후보 ${count}개 경계`, () => {
      const workspaceRows = Array.from(
        { length: count },
        (_, i) => anchor(`workspace-${i + 1}`, 0.8 - i * 0.01, "workspace-a")
      );
      const result = selectAnchorFragments(workspaceRows, globals, {
        limit: 20,
        reserve: 10,
        workspaceApplied: true,
      });
      const ids = new Set(result.fragments.map(fragment => fragment.id));
      for (const fragment of workspaceRows.slice(0, 10)) {
        assert.ok(ids.has(fragment.id), `${fragment.id}가 예약 선택되어야 한다`);
      }
      assert.equal(result.fragments.length, 20);
      assert.equal(result.meta.selected.reservedWorkspace, Math.min(count, 10));
      assert.equal(result.meta.candidates.workspace, count);
      assert.equal(result.meta.candidates.global, 25);
    });
  }

  it("예약 후 남은 슬롯은 잔여 workspace와 global을 통합 중요도순으로 채운다", () => {
    const workspaceRows = [
      ...Array.from({ length: 10 }, (_, i) => anchor(`reserved-${i + 1}`, 1 - i * 0.01, "workspace-a")),
      anchor("workspace-remainder-high", 0.88, "workspace-a"),
      anchor("workspace-remainder-low", 0.60, "workspace-a"),
    ];
    const globalRows = [
      anchor("global-high", 0.89),
      anchor("global-middle", 0.70),
    ];
    const result = selectAnchorFragments(workspaceRows, globalRows, {
      limit: 13,
      reserve: 10,
      workspaceApplied: true,
    });
    assert.deepEqual(result.fragments.slice(10).map(fragment => fragment.id), [
      "global-high",
      "workspace-remainder-high",
      "global-middle",
    ]);
  });

  it("reserve=0이면 workspace/global 순수 통합 top-N", () => {
    const result = selectAnchorFragments(
      [anchor("workspace-low", 0.4, "workspace-a"), anchor("workspace-high", 0.9, "workspace-a")],
      [anchor("global-middle", 0.7)],
      { limit: 2, reserve: 0, workspaceApplied: true }
    );
    assert.deepEqual(result.fragments.map(fragment => fragment.id), ["workspace-high", "global-middle"]);
    assert.equal(result.meta.selected.reservedWorkspace, 0);
  });

  it("reserve=total이면 workspace를 먼저 채우고 부족분만 global로 채운다", () => {
    const result = selectAnchorFragments(
      [anchor("workspace-low", 0.1, "workspace-a")],
      [anchor("global-high", 1.0), anchor("global-next", 0.9)],
      { limit: 2, reserve: 2, workspaceApplied: true }
    );
    assert.deepEqual(result.fragments.map(fragment => fragment.id), ["workspace-low", "global-high"]);
  });

  it("workspace 미지정이면 reserve를 적용하지 않고 global만 최대 total 선택", () => {
    const result = selectAnchorFragments([anchor("must-not-select", 1.0, "workspace-a")], globals, {
      limit: 20,
      reserve: 10,
      workspaceApplied: false,
    });
    assert.equal(result.fragments.length, 20);
    assert.equal(result.meta.reserveApplied, false);
    assert.equal(result.meta.selected.workspace, 0);
    assert.equal(result.meta.selected.global, 20);
    assert.ok(!result.fragments.some(fragment => fragment.id === "must-not-select"));
  });

  it("후보/선택/제외 메타는 전체 후보 수를 기준으로 산술 정합하다", () => {
    const result = selectAnchorFragments(
      [anchor("workspace-1", 0.8, "workspace-a")],
      [anchor("global-1", 0.9)],
      {
        limit: 2,
        reserve: 1,
        workspaceApplied: true,
        workspaceCandidateCount: 7,
        globalCandidateCount: 11,
      }
    );
    assert.deepEqual(result.meta.candidates, { workspace: 7, global: 11, total: 18 });
    assert.equal(result.meta.selected.total, 2);
    assert.equal(result.meta.excluded.total, 16);
    assert.equal(result.meta.candidates.total, result.meta.selected.total + result.meta.excluded.total);
  });

  it("동점은 created_at DESC NULLS LAST, id ASC 순서로 결정한다", () => {
    const rows = [
      anchor("id-c", 0.8, null, null),
      anchor("id-b", 0.8, null, "2026-02-01T00:00:00.000Z"),
      anchor("id-a", 0.8, null, "2026-02-01T00:00:00.000Z"),
      anchor("id-d", 0.8, null, "2026-01-01T00:00:00.000Z"),
    ];
    const result = selectAnchorFragments([], rows.reverse(), {
      limit: 4,
      reserve: 0,
      workspaceApplied: false,
    });
    assert.deepEqual(result.fragments.map(fragment => fragment.id), ["id-a", "id-b", "id-d", "id-c"]);
  });
});

describe("ContextBuilder anchor 조회와 응답", () => {
  function makeBuilder(poolQuery) {
    const recallMock = mock.fn(async params => {
      if (params.topic === "session_reflect") return { fragments: [] };
      return { fragments: [] };
    });
    const indexMock = {
      getWorkingMemory: mock.fn(async () => []),
      setSeenIds      : mock.fn(async () => {}),
    };
    const storeMock = { searchBySource: mock.fn(async () => []) };
    return new ContextBuilder({
      recall : recallMock,
      store  : storeMock,
      index  : indexMock,
      getPool: () => ({ query: poolQuery }),
    });
  }

  it("workspace 지정 시 exact workspace와 global을 분리 조회하고 key scope를 함께 유지한다", async () => {
    const calls = [];
    const builder = makeBuilder(async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    });

    await builder.build({ workspace: "workspace-a", _keyId: "key-a", _groupKeyIds: ["key-a", "key-shared"] });

    assert.equal(calls.length, 2);
    const workspaceCall = calls.find(call => /AND workspace = \$\d+/.test(call.sql));
    const globalCall = calls.find(call => /AND workspace IS NULL/.test(call.sql));
    assert.ok(workspaceCall);
    assert.ok(globalCall);
    assert.match(workspaceCall.sql, /key_id = ANY\(\$\d+::text\[\]\)/);
    assert.deepEqual(workspaceCall.params, [["key-a", "key-shared"], "workspace-a", 20]);
    assert.deepEqual(globalCall.params, [["key-a", "key-shared"], 20]);
    for (const call of calls) {
      assert.match(call.sql, /ORDER BY importance DESC, created_at DESC NULLS LAST, id ASC/);
      assert.match(call.sql, /LIMIT \$\d+/);
    }
  });

  it("키의 default workspace도 예약 조회에 적용한다", async () => {
    const calls = [];
    const builder = makeBuilder(async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    });
    await builder.build({ _defaultWorkspace: "workspace-default" });
    assert.equal(calls.length, 2);
    assert.ok(calls.some(call => call.params.includes("workspace-default")));
  });

  it("workspace가 없으면 global-only 단일 조회로 최대 20개를 유지한다", async () => {
    const globals = Array.from({ length: 25 }, (_, i) => anchor(`global-${i + 1}`, 1 - i * 0.01));
    const calls = [];
    const builder = makeBuilder(async (sql, params) => {
      calls.push({ sql, params });
      return { rows: candidateRows(globals).slice(0, params.at(-1)) };
    });
    const result = await builder.build({ tokenBudget: 1 });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /AND workspace IS NULL/);
    assert.equal(result.anchorCount, 20);
    assert.equal(result._anchorSelection.reserveApplied, false);
    assert.equal(result._anchorSelection.candidates.global, 25);
  });

  it("flat/structured의 선택 anchor 집합과 순서가 모든 응답 표면에서 일치한다", async () => {
    const workspaceRows = Array.from(
      { length: 15 },
      (_, i) => anchor(`workspace-${i + 1}`, 0.95 - i * 0.02, "workspace-a")
    );
    const globalRows = Array.from(
      { length: 15 },
      (_, i) => anchor(`global-${i + 1}`, 0.99 - i * 0.02)
    );
    const query = async sql => ({
      rows: candidateRows(/AND workspace IS NULL/.test(sql) ? globalRows : workspaceRows)
    });

    const flat = await makeBuilder(query).build({ workspace: "workspace-a", tokenBudget: 1 });
    const structured = await makeBuilder(query).build({ workspace: "workspace-a", structured: true, tokenBudget: 1 });
    const flatAnchorIds = flat.fragments.slice(0, flat.anchorCount).map(fragment => fragment.id);
    const structuredAnchorIds = structured.anchors.permanent.map(fragment => fragment.id);
    const rankedAnchorIds = structured.rankedInjection.items
      .filter(item => item.anchor)
      .map(item => item.id);

    assert.deepEqual(flatAnchorIds, structuredAnchorIds);
    assert.deepEqual(structuredAnchorIds, rankedAnchorIds);
    assert.deepEqual(flat._anchorSelection, structured._anchorSelection);
    assert.equal(flat.anchorCount, 20, "작은 tokenBudget도 anchor 상한을 줄이지 않아야 한다");
    for (const fragment of flat.fragments.slice(0, flat.anchorCount)) {
      assert.match(flat.injectionText, new RegExp(fragment.content));
    }
  });
});
