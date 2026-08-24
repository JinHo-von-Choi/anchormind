# Task 2 report

## Status

Implemented and committed Task 2 reviewer fixes through round 5: API-key/workspace exact tuple
scope is fail-closed across the pilot's read, link, stats, feedback, reconstruction, event,
and mutation paths. Workspace-only legacy calls retain their prior non-strict behavior.

## Commit

- `d7601f4 fix: close round 5 scope ownership gaps`
- `552ef0c docs: record task 2 round 4 verification`
- `fc4a722 fix: close round 4 scope bypasses`
- `7a4fb3f docs: record task 2 round 3 verification`
- `f1d3057 fix: close round 3 exact tuple scope bypasses`
- `783f5eb docs: record round 2 test mock commit`
- `3badb4a test: complete round 2 embedding mock surface`
- `727ad5f fix: close task 2 exact tuple bypasses`
- `57ef206 fix: close exact tuple scope gaps across memory paths`
- `df08d27 fix: enforce key and workspace scope across memory paths`

## Tests

- TDD RED evidence (round 2): the initial 8 exact-bypass tests had **7 failures** (temporal
  strict forwarding, graph strict SQL, context anchor/learning scope, linked preview,
  feedback/reconsolidation, linker update scope, contradiction workspace projection); after
  minimal fixes and runtime fixture coverage they passed.
- Focused round-2 suites (static + runtime): **16 passed, 0 failed**.
- Related characterization/security suite: **106 passed, 0 failed**.
- Full unit command: **2513 passed, 7 failed, 7 cancelled, 2 skipped** (2529 total); the failures are
  existing parallel Node module-mock linkage failures/cancellations in consolidator,
  workspace-stats, resources, and search-scope tests, outside this change.
- `node --check` on modified JavaScript files and `git diff --check`: passed.

## Concerns

- The standalone upstream `tests/unit/memory-stats-workspaces.test.js` remains blocked by its pre-existing Node module-mock linkage error (`../../tools/db.js` does not provide `queryWithAgentVector`); it was not changed or masked.
- The full-suite baseline remains non-clean for the same pre-existing mock-linkage cluster; the focused and related suites for this task are green.
- The runtime tests use only synthetic rows/fixtures and mocked DB clients; no real DB, Redis, LLM, network, or external effect was used.
- No real database, Redis, LLM, network, external send, push, PR, merge, or deployment was used.

## Round 3 reviewer-fix

- RED evidence: the new six static bypass checks initially reported **4 failures** (post-processing
  scope propagation, temporal/conflict scope, auto-case-id/update scope, and touch/assertion scope).
- Minimal fixes: HotCache now has an exact tuple final defense; remember post-processing, linked/proactive
  recall, temporal/conflict auto-links, supersede/TTL/assertion/touch/case-id mutations, and case candidates
  carry explicit `{keyId, workspace, strictScope}`. Hostile fake rows are filtered again at runtime.
- Focused round-3 + prior security suites: **35 passed, 0 failed**.
- Related characterization/security suite including linkedTo ownership: **121 passed, 0 failed**.
- Full unit command: **2524 passed, 7 failed, 7 cancelled, 2 skipped** (2540 total), matching the
  pre-existing 7-failure/7-cancellation baseline after adding 11 round-3 tests.
- `node --check` for all modified JavaScript and `git diff --check`: passed.
- Round-3 tests use synthetic rows and mocked DB clients only; no real DB/Redis/LLM/network or external effect.

## Round 4 reviewer-fix

- RED evidence: five new static boundary checks failed before implementation (caseMode/CaseRecall,
  `search_traces`, stats legacy branching, case-event scope propagation, and symbolic polarity/ClaimStore scope).
- Minimal fixes: CaseRecall now forwards and enforces exact key/workspace scope for fragments and case events;
  `search_traces` uses exact tuple SQL plus final row filtering; workspace-only stats retain the legacy
  workspace/NULL behavior while API-key stats set `strictScope`; CaseEventStore writes/reads and
  `preceded_by` ownership carry the tuple; ConflictResolver passes the detector options object and ClaimStore
  rechecks both fragment endpoints.
- Focused round-4 plus prior security/ownership suites: **116 passed, 0 failed**.
- Full unit command: **2535 passed, 7 failed, 7 cancelled, 2 skipped** (2551 total), preserving the
  existing 7-failure/7-cancellation baseline after adding 11 round-4 tests.
- `node --check` for all modified JavaScript and `git diff --check`: passed.
- Round-4 tests use synthetic rows and mocked DB clients only; no real DB/Redis/LLM/network or external effect.

## Round 5 reviewer-fix

- RED evidence: the new static boundary suite had **4 failures** and the runtime suite had
  **5 failures** before implementation. The failures exposed the non-atomic case-event
  `strictScope` omission, linked-preview scope omission, timeline-outside links, append tuple
  mismatch, and fragment-only evidence ownership.
- Minimal fixes: both non-atomic `MemoryRememberer` case-event calls now pass workspace and strict
  scope; linked preview applies scalar key + workspace exact filtering; HistoryReconstructor requires
  both link endpoints to be in the scoped timeline for strict and legacy workspace paths and rejects
  hostile adapter rows; `CaseEventStore.append()` rejects authenticated/payload tuple mismatches;
  strict `addEvidence()` verifies both the evidence fragment and event source fragment ownership.
  Adjacent `CaseEventStore` mutation methods were audited; strict `addEdge()` already checked both
  endpoints and global `deleteExpired()` remains an unscoped maintenance operation.
- Round-5 RED→GREEN suites: **10 passed, 0 failed** (5 static + 5 runtime).
- Focused security-hardening glob after round 5: **73 passed, 0 failed, 0 cancelled**.
- Related characterization/security command: **88 passed, 0 failed, 2 cancelled**; the two
  cancellations are the pre-existing `memory-stats-workspaces` module-mock linkage issue.
- Full `npm test`: **2545 passed, 7 failed, 7 cancelled, 2 skipped** (2561 total). Round-4
  baseline was **2535 passed, 7 failed, 7 cancelled, 2 skipped** (2551 total), so the only
  count increase is the 10 new round-5 tests; the existing failure/cancellation cluster is unchanged.
- `node --check` for all round-5 JavaScript and `git diff --check`: passed.
- Round-5 tests use only synthetic hostile rows and mocked DB clients; no real DB, Redis, LLM,
  network, external send, push, PR, merge, or deployment was used.
