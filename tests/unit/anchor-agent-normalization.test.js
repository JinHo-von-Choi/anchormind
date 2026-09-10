import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const queries = [];
let failVersionNormalization = false;
let lockedFragment = null;
const client = {
  query: async (sql, params = []) => {
    queries.push({ sql, params });
    if (/FOR UPDATE/.test(sql)) return { rows: lockedFragment ? [lockedFragment] : [] };
    if (failVersionNormalization && /UPDATE agent_memory\.fragment_versions/.test(sql)) {
      throw new Error("synthetic history update failure");
    }
    if (/UPDATE agent_memory\.fragments/.test(sql)) {
      return { rows: [{ id: "anchor-a", agent_id: "default", is_anchor: true }] };
    }
    return { rows: [] };
  },
  release: () => {}
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({ connect: async () => client }),
    queryWithAgentVector: async (_agentId, sql, params) => {
      queries.push({ sql, params });
      return { rows: [] };
    }
  }
});

const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");
const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
const { amendDefinition } = await import("../../lib/tools/memory-schemas.js");

describe("anchor agent scope normalization", () => {
  it("an amendment waiting behind normalization archives the newly committed shared scope", async () => {
    queries.length = 0;
    const stale = {
      id: "anchor-a", content: "old", agent_id: "agent-a", key_id: "key-a",
      workspace: "project-a", importance: 0.5, keywords: [], type: "fact"
    };
    lockedFragment = { ...stale, content: "committed content", agent_id: "default" };
    await new FragmentWriter().update(stale.id, { importance: 0.7 }, "agent-a", "key-a", stale);
    const lockIndex = queries.findIndex(q => /FOR UPDATE/.test(q.sql));
    const archiveIndex = queries.findIndex(q => /INSERT INTO agent_memory\.fragment_versions/.test(q.sql));
    assert.ok(lockIndex >= 0 && archiveIndex > lockIndex);
    assert.equal(queries[archiveIndex].params[1], "committed content");
    assert.equal(queries[archiveIndex].params.at(-2), "default");
    assert.equal(queries[archiveIndex].params.at(-1), "project-a");
  });

  it("normalization rejects scope changed after approval before creating any version", async () => {
    queries.length = 0;
    const stale = { id: "anchor-a", agent_id: "agent-a", key_id: "key-a", workspace: "project-a" };
    lockedFragment = { ...stale, workspace: "project-b" };
    await assert.rejects(new FragmentWriter().update(
      stale.id, { agent_id: "default" }, "agent-a", null, stale,
      { normalizeVersionAgentToDefault: true }
    ), /scope changed/);
    assert.ok(queries.some(q => q.sql === "ROLLBACK"));
    assert.equal(queries.some(q => /INSERT INTO|UPDATE agent_memory/.test(q.sql)), false);
  });

  it("a disappeared row returns null after locking without archiving", async () => {
    queries.length = 0;
    lockedFragment = null;
    assert.equal(await new FragmentWriter().update(
      "anchor-a", { importance: 0.7 }, "agent-a", null,
      { id: "anchor-a", agent_id: "agent-a", key_id: null }
    ), null);
    assert.ok(queries.some(q => q.sql === "ROLLBACK"));
    assert.equal(queries.some(q => /INSERT INTO/.test(q.sql)), false);
  });

  it("writer fallback lookup checks the caller agent and owner key before archiving", async () => {
    queries.length = 0;
    const result = await new FragmentWriter().update(
      "foreign-fragment", { content: "replacement" }, "agent-a", "key-a"
    );
    assert.equal(result, null);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /agent_id = \$2 OR agent_id = 'default'/);
    assert.match(queries[0].sql, /key_id = \$3/);
    assert.deepEqual(queries[0].params, ["foreign-fragment", "agent-a", "key-a"]);
  });

  it("approved normalization changes version scope atomically without changing workspace or content", async () => {
    queries.length = 0;
    const existing = {
      id: "anchor-a", content: "synthetic", type: "fact", keywords: [],
      agent_id: "agent-a", workspace: "project-a", key_id: "key-a"
    };
    lockedFragment = existing;
    await new FragmentWriter().update(
      existing.id, { agent_id: "default" }, "agent-a", null, existing,
      { amendedBy: "system:anchor-scope", normalizeVersionAgentToDefault: true }
    );
    const versionIndex = queries.findIndex(q => /UPDATE agent_memory\.fragment_versions/.test(q.sql));
    const fragmentIndex = queries.findIndex(q => /UPDATE agent_memory\.fragments\b/.test(q.sql));
    const commitIndex = queries.findIndex(q => q.sql === "COMMIT");
    assert.ok(fragmentIndex < versionIndex && versionIndex < commitIndex);
    assert.deepEqual(queries[versionIndex].params, ["anchor-a"]);
    assert.match(queries[versionIndex].sql, /WHERE fragment_id = \$1\s*$/);
    assert.doesNotMatch(queries[versionIndex].sql, /SET[^]*workspace|SET[^]*content|SET[^]*key_id/);

    queries.length = 0;
    failVersionNormalization = true;
    try {
      await assert.rejects(new FragmentWriter().update(
        existing.id, { agent_id: "default" }, "agent-a", null, existing,
        { normalizeVersionAgentToDefault: true }
      ), /synthetic history update failure/);
    } finally {
      failVersionNormalization = false;
    }
    assert.ok(queries.some(q => /UPDATE agent_memory\.fragments\b/.test(q.sql)));
    assert.ok(queries.some(q => q.sql === "ROLLBACK"));
    assert.equal(queries.some(q => q.sql === "COMMIT"), false);
  });

  it("automatic events use the persisted fragment key for snapshots and event links", async () => {
    const seen = [];
    const rememberer = new MemoryRememberer({ caseEventStore: {
      append: async event => { seen.push(event); return { event_id: "event-a" }; },
      addEvidence: async () => {},
      getByCase: async (_id, scope) => { seen.push(scope); return []; }
    } });
    await rememberer._recordCaseEvent({
      id: "fragment-a", case_id: "case-a", type: "error", content: "synthetic",
      key_id: null, agent_id: "default", workspace: "project-a"
    }, "caller-key");
    assert.equal(seen[0].key_id, null);
    assert.equal(seen[1].keyId, null);
    assert.equal(seen[0].source_fragment_id, "fragment-a");
  });

  it("public amend schema에 agent scope 변경 필드를 노출하지 않는다", () => {
    assert.equal(amendDefinition.inputSchema.properties.newAgentId, undefined);
  });
  it("agent 변경 전 상태를 version history에 남기고 같은 트랜잭션에서 default로 변경한다", async () => {
    queries.length = 0;
    const writer = new FragmentWriter();
    const existing = {
      id: "anchor-a", content: "synthetic shared rule", topic: "synthetic-topic",
      keywords: ["synthetic"], type: "procedure", importance: 0.9,
      agent_id: "agent-a", is_anchor: true, key_id: null
    };
    lockedFragment = existing;

    const result = await writer.update(
      existing.id, { agent_id: "default" }, "agent-a", null, existing,
      { amendedBy: "system:anchor-scope" }
    );

    const archive = queries.find(call => /INSERT INTO agent_memory\.fragment_versions/.test(call.sql));
    const update = queries.find(call => /UPDATE agent_memory\.fragments/.test(call.sql));
    assert.ok(archive);
    assert.match(archive.sql, /agent_id/);
    assert.equal(archive.params[6], "system:anchor-scope");
    assert.equal(archive.params.at(-2), "agent-a");
    assert.equal(archive.params.at(-1), null);
    assert.ok(update);
    assert.match(update.sql, /agent_id = \$2/);
    assert.equal(update.params[1], "default");
    assert.equal(result.agent_id, "default");
  });

  it("agent scope가 없는 fragment를 default history로 합성하지 않는다", async () => {
    const writer = new FragmentWriter();
    const missingScope = {
      id: "anchor-missing", content: "synthetic", topic: "synthetic-topic",
      keywords: [], type: "fact", importance: 0.5, key_id: null
    };
    await assert.rejects(
      writer.archiveVersion(missingScope, "system"),
      /agent scope is required/
    );
    await assert.rejects(
      writer.update(missingScope.id, { content: "changed" }, "default", null, missingScope),
      /agent scope is required/
    );
  });
});

describe("anchor normalization cache ordering", () => {
  const existing = {
    id: "anchor-b", content: "synthetic private rule", topic: "synthetic-topic",
    keywords: ["synthetic"], type: "procedure", importance: 0.9,
    agent_id: "agent-b", is_anchor: true, key_id: "key-b"
  };

  it("명시적인 전체 파편 이관 모드에서는 non-anchor도 정규화한다", async () => {
    const nonAnchor = { ...existing, id: "fragment-legacy", is_anchor: false };
    let updated = false;
    const rememberer = new MemoryRememberer({
      store: {
        getById: async () => nonAnchor,
        update: async () => {
          updated = true;
          return { ...nonAnchor, agent_id: "default" };
        }
      },
      index: { deindex: async () => {}, index: async () => {} }
    });
    const result = await rememberer.normalizeFragmentAgentToDefault(
      nonAnchor.id, "agent-b", { anchorsOnly: false }
    );
    assert.equal(updated, true);
    assert.equal(result.updated, true);
  });

  it("named workspace를 inventory scope 그대로 getById에 전달한다", async () => {
    const scoped = { ...existing, id: "anchor-workspace", workspace: "project-a" };
    let readOptions;
    const rememberer = new MemoryRememberer({
      store: {
        getById: async (...args) => {
          readOptions = args.at(-1);
          return scoped;
        },
        update: async () => ({ ...scoped, agent_id: "default" })
      },
      index: { deindex: async () => {}, index: async () => {} }
    });

    const result = await rememberer.normalizeFragmentAgentToDefault(
      scoped.id, scoped.agent_id, { workspace: scoped.workspace }
    );

    assert.equal(result.updated, true);
    assert.deepEqual(readOptions, {
      includePeerAgents: false,
      workspace: "project-a",
      allWorkspaces: false
    });
  });

  it("inventory 이후 workspace가 바뀐 파편은 정규화하지 않는다", async () => {
    const moved = { ...existing, workspace: null };
    let updated = false;
    const rememberer = new MemoryRememberer({
      store: {
        getById: async () => moved,
        update: async () => { updated = true; }
      },
      index: { deindex: async () => {}, index: async () => {} }
    });

    const result = await rememberer.normalizeFragmentAgentToDefault(
      moved.id, moved.agent_id, { workspace: "project-a" }
    );

    assert.equal(result.updated, false);
    assert.equal(updated, false);
    assert.match(result.error, /expected agent scope/);
  });

  it("old private cache를 제거한 뒤 DB를 갱신하고 shared cache를 등록한다", async () => {
    const order = [];
    const rememberer = new MemoryRememberer({
      store: {
        getById: async () => existing,
        update: async (...args) => {
          order.push(["update", args.at(-1)]);
          return { ...existing, agent_id: "default" };
        }
      },
      index: {
        deindex: async (...args) => order.push(["deindex", args.at(-1)]),
        index: async (...args) => order.push(["index", args.at(-1)])
      }
    });
    const result = await rememberer.normalizeAnchorAgentToDefault(existing.id, "agent-b");
    assert.equal(result.updated, true);
    assert.deepEqual(order.map(item => item[0]), ["deindex", "update", "index"]);
    assert.deepEqual(order[0][1], { strict: true });
    assert.deepEqual(order[1][1], {
      amendedBy: "system:anchor-scope", normalizeVersionAgentToDefault: true
    });
    assert.deepEqual(order[2][1], { strict: true });
  });

  it("deindex 실패 시 DB update를 시작하지 않는다", async () => {
    let updated = false;
    const rememberer = new MemoryRememberer({
      store: {
        getById: async () => existing,
        update: async () => { updated = true; }
      },
      index: {
        deindex: async () => { throw new Error("synthetic cache failure"); }
      }
    });
    const result = await rememberer.normalizeAnchorAgentToDefault(existing.id, "agent-b");
    assert.equal(result.updated, false);
    assert.equal(updated, false);
    assert.match(result.error, /cache consistency failed/);
  });

  it("DB update 실패 시 old private cache를 strict 복원한다", async () => {
    const order = [];
    const rememberer = new MemoryRememberer({
      store: {
        getById: async () => existing,
        update: async () => {
          order.push("update");
          throw new Error("synthetic database failure");
        }
      },
      index: {
        deindex: async () => order.push("deindex"),
        index: async (fragment, _sessionId, _keyId, opts) => {
          order.push(`restore:${fragment.agent_id}:${opts.strict}`);
        }
      }
    });
    await assert.rejects(
      rememberer.normalizeAnchorAgentToDefault(existing.id, "agent-b"),
      /synthetic database failure/
    );
    assert.deepEqual(order, ["deindex", "update", "restore:agent-b:true"]);
  });

  it("shared cache 등록 실패는 DB 변경 완료 상태를 명시한다", async () => {
    let indexCalls = 0;
    const rememberer = new MemoryRememberer({
      store: {
        getById: async () => existing,
        update: async () => ({ ...existing, agent_id: "default" })
      },
      index: {
        deindex: async () => {},
        index: async () => {
          indexCalls++;
          throw new Error("synthetic cache failure");
        }
      }
    });
    const result = await rememberer.normalizeAnchorAgentToDefault(existing.id, "agent-b");
    assert.equal(indexCalls, 1);
    assert.equal(result.updated, true);
    assert.equal(result.databaseUpdated, true);
    assert.equal(result.cacheConsistent, false);
    assert.match(result.cacheWarning, /cache consistency failed/);
  });

  it("DB update가 결과 없이 끝나도 old private cache를 strict 복원한다", async () => {
    const order = [];
    const rememberer = new MemoryRememberer({
      store: {
        getById: async () => existing,
        update: async () => {
          order.push("update");
          return null;
        }
      },
      index: {
        deindex: async () => order.push("deindex"),
        index: async (fragment, _sessionId, _keyId, opts) => {
          order.push(`restore:${fragment.agent_id}:${opts.strict}`);
        }
      }
    });
    const result = await rememberer.normalizeAnchorAgentToDefault(existing.id, "agent-b");
    assert.equal(result.updated, false);
    assert.deepEqual(order, ["deindex", "update", "restore:agent-b:true"]);
  });
});
