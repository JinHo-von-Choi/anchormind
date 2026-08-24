# Task 2 report

## Status

Implemented and committed Task 2 reviewer fix round 2: API-key/workspace exact tuple scope is
now fail-closed across the pilot's temporal/graph/context reads, linked preview, feedback,
reconsolidation, contradiction, linker, and forget/amend mutation paths. Workspace-only
legacy calls retain their prior non-strict behavior.

## Commit

- `df08d27 fix: enforce key and workspace scope across memory paths`
- follow-up commit at current `HEAD`: `fix: close exact tuple scope gaps across memory paths`
- `727ad5f fix: close task 2 exact tuple bypasses`
- `3badb4a test: complete round 2 embedding mock surface`

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
