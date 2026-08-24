import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { exactScopeClause } from "../../lib/memory/keyScope.js";
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
    assert.match(files.linkStore, /f\.workspace\s*=\s*\$/);
    assert.match(files.linkStore, /f\.key_id\s*=\s*\$/);
  });
});
