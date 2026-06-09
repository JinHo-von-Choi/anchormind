/**
 * Unit tests: split candidate query excludes split-origin + meta topics.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSplitCandidateQuery } from "../../lib/memory/ConsolidatorGC.js";

describe("buildSplitCandidateQuery", () => {
  it("excludes split-origin fragments", () => {
    const { sql } = buildSplitCandidateQuery(["session_reflect"]);
    assert.match(sql, /source\s+IS\s+NULL\s+OR\s+source\s+NOT\s+LIKE\s+'split:%'/i);
  });

  it("excludes fragments within the failure backoff window", () => {
    const { sql } = buildSplitCandidateQuery([]);
    assert.match(sql, /split_attempt_failed_at\s+IS\s+NULL/i);
    assert.match(sql, /make_interval\(hours\s*=>\s*\$3\)/i);
  });

  it("excludes configured meta topics via the \\$4 parameter", () => {
    const { sql, params } = buildSplitCandidateQuery(["session_reflect", "consolidation"]);
    assert.match(sql, /topic\s*<>\s*ALL\(\$4::text\[\]\)/i);
    assert.deepEqual(params.metaTopics, ["session_reflect", "consolidation"]);
  });

  it("omits the topic guard when no meta topics are configured", () => {
    const { sql } = buildSplitCandidateQuery([]);
    assert.doesNotMatch(sql, /topic\s*<>\s*ALL/i);
  });
});
