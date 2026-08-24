import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const reader = readFileSync(new URL("../../lib/memory/read/FragmentReader.js", import.meta.url), "utf8");
const reconstructor = readFileSync(new URL("../../lib/memory/read/HistoryReconstructor.js", import.meta.url), "utf8");

test("unauthorized history exits before versions or superseded chain queries", () => {
  assert.match(reader, /if\s*\(!current\)[\s\S]{0,220}versions\s*:\s*\[\]/);
  assert.match(reader, /exactScopeClause[\s\S]*fragment_versions/);
  assert.match(reader, /exactScopeClause[\s\S]*fragment_links/);
});

test("reconstruct history scopes timeline and link reads", () => {
  assert.match(reconstructor, /exactScopeClause/);
  assert.match(reconstructor, /_fetchLinks\(fragmentIds,?\s*scope/);
  assert.match(reconstructor, /exactScopeClause\(params,\s*"f"[\s\S]*workspace/);
});
