# Task 2 report

## Status

Implemented and committed the reviewer follow-up: API-key/workspace exact tuple scope is
now fail-closed across the pilot's read, link, feedback, statistics, and mutation paths.

## Commit

- `df08d27 fix: enforce key and workspace scope across memory paths`
- follow-up commit at current `HEAD`: `fix: close exact tuple scope gaps across memory paths`

## Tests

- TDD RED evidence: the new actual-entrypoint checks initially failed for partial/array scope,
  `MemoryManager.stats` propagation, scalar recall scope, and linked-preview endpoint scope;
  after the minimal fixes they passed.
- Focused security-hardening suite: **14 passed, 0 failed**.
- Related characterization suite (auth, fragment isolation, linkstore isolation, history, consolidator, graph linker, contradiction detector): **93 passed, 0 failed**.
- Full unit command: **2497 passed, 7 failed, 7 cancelled, 2 skipped**; the failures are
  existing parallel Node module-mock linkage failures/cancellations in consolidator,
  workspace-stats, resources, and search-scope tests, outside this change.
- `node --check` on all modified JavaScript files and `git diff --check`: passed.

## Concerns

- The standalone upstream `tests/unit/memory-stats-workspaces.test.js` remains blocked by its pre-existing Node module-mock linkage error (`../../tools/db.js` does not provide `queryWithAgentVector`); it was not changed or masked.
- The full-suite baseline remains non-clean for the same pre-existing mock-linkage cluster; the focused and related suites for this task are green.
- No real database, Redis, LLM, network, external send, push, PR, merge, or deployment was used.
