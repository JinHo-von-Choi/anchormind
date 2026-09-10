import { it, mock } from "node:test";
import assert from "node:assert/strict";

const warnings = [];
const calls = [];
let sourceRows = [];
mock.module("../../lib/logger.js", {
  defaultExport: { warn: message => warnings.push(message) },
  namedExports: { logWarn: message => warnings.push(message) }
});
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({}),
    withTransaction: async (_pool, fn) => fn({ query: async (sql, params) => {
      calls.push({ sql, params });
      if (/COALESCE\(MAX/.test(sql)) return { rows: [{ next_seq: 0 }] };
      if (/SELECT agent_id, workspace/.test(sql)) return { rows: sourceRows };
      return { rows: [{ event_id: "event-a", sequence_no: 0 }] };
    } })
  }
});
mock.module("../../lib/memory/signals/CaseRewardBackprop.js", {
  namedExports: { getBackprop: () => ({ backprop: async () => {} }) }
});
const { CaseEventStore } = await import("../../lib/memory/CaseEventStore.js");

for (const source of [undefined, "private-fragment-id"]) {
  it(`warns without exposing input when source is ${source ? "unavailable" : "absent"}`, async () => {
    calls.length = 0;
    warnings.length = 0;
    sourceRows = [];
    await new CaseEventStore().append({
      case_id: "private-case", event_type: "error_observed", summary: "private-summary",
      source_fragment_id: source, key_id: "private-key"
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /snapshot unavailable/);
    assert.doesNotMatch(warnings[0], /private-/);
    const insert = calls.find(q => /INSERT INTO/.test(q.sql));
    assert.deepEqual(insert.params.slice(-2), [null, null]);
    if (source) {
      const lookup = calls.find(q => /SELECT agent_id/.test(q.sql));
      assert.deepEqual(lookup.params, [source, "private-key"]);
      assert.match(lookup.sql, /key_id IS NOT DISTINCT FROM \$2/);
    }
  });
}

it("a resolved global source has an explicit agent scope and emits no warning", async () => {
  warnings.length = 0;
  sourceRows = [{ agent_id: "default", workspace: null }];
  await new CaseEventStore().append({
    case_id: "case-a", event_type: "error_observed", source_fragment_id: "fragment-a"
  });
  assert.deepEqual(warnings, []);
});
