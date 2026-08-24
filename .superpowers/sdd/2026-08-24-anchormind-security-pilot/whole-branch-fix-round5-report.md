# Whole-branch fix round 5 report

## Scope

- Canonical pilot contract is documented as `MEMENTO_SECURITY_PILOT_AUTOMATION=off`.
- Pilot aliases such as `MEMENTO_PILOT_MODE` and pilot-specific `MEMENTO_*_ENABLED`
  names are documented as unsupported; they do not substitute for canonical flags.
- The design plan lists the exact mutation/maintenance flags that must be explicitly
  `false`, plus the existing startup requirements for access key, authentication,
  loopback bind, and a complete local embedding snapshot.
- `docs/features.md` now names `ENABLE_RECONSOLIDATION`, matching the implementation.
- `FragmentWriter.deleteExpired()` returns `0` before any database call when pilot
  automation is off. `FragmentStore.deleteExpired()` therefore inherits the same
  low-level fail-closed boundary.
- Non-pilot behavior remains the legacy database path.

## TDD evidence

The new direct `FragmentStore.deleteExpired()` test was run before the production
change and failed because the mocked `queryWithAgentVector` was reached. The source
guard assertion also failed because `FragmentWriter` had no pilot guard. After the
minimal import and early return were added, the pilot no-DB test, source assertion,
and non-pilot legacy-path test all passed.

## Verification

- Focused security suite (`security-*.test.js` and `whole-branch-fix-*.test.js`):
  `105 passed, 0 failed, 0 cancelled, 0 skipped`.
- Full `npm test`: `2609 total, 2593 passed, 7 failed, 7 cancelled, 2 skipped`.
  The seven failures and seven cancellations are the same pre-existing baseline
  failures (consolidator mock/export fixtures, MemoryConsolidator workspace stats,
  resources-active-session, and search-scope-type-topic); no new full-suite failure
  was introduced.
- ESLint on changed JavaScript files: passed.
- `node --check` on changed JavaScript files: passed.
- `git diff --check`: passed.

No external service, database, model download, listener, push, PR, merge, or deploy
was performed.
