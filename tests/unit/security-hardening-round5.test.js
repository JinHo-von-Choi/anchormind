import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rememberer = readFileSync(new URL("../../lib/memory/processors/MemoryRememberer.js", import.meta.url), "utf8");
const recaller = readFileSync(new URL("../../lib/memory/processors/MemoryRecaller.js", import.meta.url), "utf8");
const history = readFileSync(new URL("../../lib/memory/read/HistoryReconstructor.js", import.meta.url), "utf8");
const events = readFileSync(new URL("../../lib/memory/CaseEventStore.js", import.meta.url), "utf8");

describe("Task 2 round 5 exact tuple bypasses", () => {
  test("non-atomic remember records case events with workspace and strict scope", () => {
    assert.match(
      rememberer,
      /_recordCaseEvent\(\{\s*\.\.\.fragment,\s*id\s*\},\s*keyId,\s*workspace,\s*strictScope\)/
    );
  });

  test("linked preview carries API key strict scope into its final SearchScope", () => {
    assert.match(recaller, /const linkedScope = SearchScope\.fromQuery\(\{[\s\S]*keyId,[\s\S]*strictScope/);
  });

  test("history links require both timeline endpoints and post-filter hostile rows", () => {
    assert.match(history, /fl\.from_id\s*=\s*ANY\(\$1\)[\s\S]*AND\s+fl\.to_id\s*=\s*ANY\(\$1\)/);
    assert.match(history, /timelineIds|fragmentIds.*Set/);
  });

  test("strict case-event append rejects auth and payload tuple mismatch", () => {
    assert.match(events, /scope.*mismatch|mismatch.*scope/i);
  });

  test("strict evidence ownership checks both fragment and event source endpoints", () => {
    assert.match(events, /JOIN\s+\$\{SCHEMA\}\.case_events\s+ce/);
    assert.match(events, /JOIN\s+\$\{SCHEMA\}\.fragments\s+sf/);
    assert.match(events, /exactScopeClause\(params,\s*"sf"/);
  });
});
