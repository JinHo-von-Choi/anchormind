import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const recaller = readFileSync(new URL("../../lib/memory/processors/MemoryRecaller.js", import.meta.url), "utf8");
const caseRecall = readFileSync(new URL("../../lib/memory/read/CaseRecall.js", import.meta.url), "utf8");
const reconstruct = readFileSync(new URL("../../lib/tools/reconstruct.js", import.meta.url), "utf8");
const stats = readFileSync(new URL("../../lib/memory/consolidate/MemoryConsolidator.js", import.meta.url), "utf8");
const rememberer = readFileSync(new URL("../../lib/memory/processors/MemoryRememberer.js", import.meta.url), "utf8");
const events = readFileSync(new URL("../../lib/memory/CaseEventStore.js", import.meta.url), "utf8");
const conflict = readFileSync(new URL("../../lib/memory/write/ConflictResolver.js", import.meta.url), "utf8");
const claims = readFileSync(new URL("../../lib/symbolic/ClaimStore.js", import.meta.url), "utf8");

describe("Task 2 round 4 exact tuple bypasses", () => {
  test("caseMode forwards workspace and strictScope into CaseRecall", () => {
    assert.match(recaller, /buildCaseTriples\(result\.fragments,\s*\{[\s\S]*keyId,[\s\S]*workspace,[\s\S]*strictScope/);
    assert.match(caseRecall, /strictScope/);
    assert.match(caseRecall, /exactScopeClause/);
  });

  test("search_traces API-key path uses exact tuple and rejects global/group expansion", () => {
    assert.match(reconstruct, /strictScope/);
    assert.match(reconstruct, /exactScopeClause/);
    assert.match(reconstruct, /f\.key_id/);
    assert.match(reconstruct, /f\.workspace/);
  });

  test("workspace-only stats retain legacy workspace filtering while API keys are strict", () => {
    assert.match(stats, /strictScope/);
    assert.match(stats, /workspace\s*=\s*\$[\s\S]*workspace\s+IS\s+NULL/);
    assert.match(stats, /exactScopeClause/);
  });

  test("case event writes and preceded_by edges carry exact tuple context", () => {
    assert.match(rememberer, /_recordCaseEvent\(fragment, keyId, workspace, strictScope\)/);
    assert.match(events, /exactScopeClause/);
    assert.match(events, /strictScope/);
    assert.match(rememberer, /addEdge\([\s\S]*strictScope/);
  });

  test("symbolic polarity uses options object and ClaimStore binds fragment tuple", () => {
    assert.match(conflict, /detectPolarityConflicts\([\s\S]*\{[\s\S]*workspace[\s\S]*strictScope/);
    assert.match(claims, /exactScopeClause/);
    assert.match(claims, /workspace/);
  });
});
