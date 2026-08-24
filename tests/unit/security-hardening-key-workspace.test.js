import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { exactScopeClause } from "../../lib/memory/keyScope.js";
import { MemoryManager } from "../../lib/memory/MemoryManager.js";
import { MemoryRecaller } from "../../lib/memory/processors/MemoryRecaller.js";
import { LinkStore } from "../../lib/memory/link/LinkStore.js";
import { scopeA } from "../fixtures/security-hardening-data.js";

const files = {
  contradiction: readFileSync(new URL("../../lib/memory/link/ContradictionDetector.js", import.meta.url), "utf8"),
  linker: readFileSync(new URL("../../lib/memory/link/GraphLinker.js", import.meta.url), "utf8"),
  linkStore: readFileSync(new URL("../../lib/memory/link/LinkStore.js", import.meta.url), "utf8")
};

describe("pilot exact key/workspace scope", () => {
  test("scope helper binds exact key and workspace and never expands group/global rows", () => {
    const params = [];
    const clause = exactScopeClause(params, "f", scopeA);
    assert.match(clause, /f\.key_id\s*=\s*\$1/);
    assert.match(clause, /f\.workspace\s*=\s*\$2/);
    assert.doesNotMatch(clause, /ANY|IS NULL|IS NOT DISTINCT FROM/);
    assert.deepEqual(params, ["key-a", "ws-a"]);
  });

  test("partial or array scope is denied instead of degrading to a broader query", () => {
    const partialParams = [];
    const arrayParams = [];
    assert.match(exactScopeClause(partialParams, "f", { keyId: "key-a" }), /FALSE|1\\s*=\\s*0/);
    assert.match(exactScopeClause(arrayParams, "f", { keyId: ["key-a", "key-b"], workspace: "ws-a" }), /FALSE|1\\s*=\\s*0/);
    assert.deepEqual(partialParams, []);
    assert.deepEqual(arrayParams, []);
  });

  test("MemoryManager.stats forwards the exact request scope to the reflector", async () => {
    const seen = [];
    const scope = { keyId: "key-a", workspace: "ws-a" };
    const result = await MemoryManager.prototype.stats.call({
      reflector: { stats: async value => { seen.push(value); return { ok: true }; } }
    }, scope);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(seen, [scope]);
  });

  test("normal recall sends a scalar exact scope and strict flag to search", async () => {
    let query;
    const recaller = new MemoryRecaller({
      search: { search: async value => { query = value; return { fragments: [], count: 0 }; } },
      store: { getLinkedFragments: async () => [] }
    });
    await recaller.recall({
      keywords: ["pilot"],
      _keyId: "key-a",
      _groupKeyIds: ["key-a", "key-b"],
      workspace: "ws-a",
      includeLinks: false
    });
    assert.equal(query.keyId, "key-a");
    assert.equal(query.workspace, "ws-a");
    assert.equal(query.strictScope, true);
  });

  test("contradiction candidate SQL and resolve writes contain workspace scope", () => {
    assert.match(files.contradiction, /exactScopeClause\([^\n]+"c"/);
    assert.match(files.contradiction, /exactScopeClause\([^\n]+"f"/);
    assert.match(files.contradiction, /resolveContradiction\([^)]*scope/);
  });

  test("graph dedup and candidate SQL carry workspace scope", () => {
    assert.match(files.linker, /exactScopeClause[\s\S]*dedup/);
    assert.match(files.linker, /exactScopeClause[\s\S]*cand/);
    assert.match(files.linker, /linkFragment\([^)]*workspace/);
  });

  test("linked rows constrain both directions to exact key/workspace", () => {
    assert.match(files.linkStore, /strictScope/);
    assert.match(files.linkStore, /exactScopeClause/);
    assert.match(files.linkStore, /source/);
    assert.match(files.linkStore, /workspace/);
  });

  test("LinkStore linked SQL binds exact scope on both source and target endpoints", () => {
    const { sql, params } = new LinkStore()._buildLinkedFragmentsSql({
      fromIds: ["frag-a"],
      safeRelationType: null,
      keyId: "key-a",
      workspace: "ws-a",
      includePeerAgents: true,
      strictScope: true
    });
    assert.match(sql, /source\.key_id/);
    assert.match(sql, /source\.workspace/);
    assert.match(sql, /f\.key_id/);
    assert.match(sql, /f\.workspace/);
    assert.deepEqual(params, [["frag-a"], "key-a", "ws-a", "key-a", "ws-a"]);
  });
});
