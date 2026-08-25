# Test Mocking Compatibility Design

## Goal

Restore the full unit-test suite by updating only stale Node.js module-mocking declarations in the eight unchanged test files that fail at module instantiation.

## Evidence and scope

- `HEAD=ddb45f7` has 7 top-level failures (and 5 cancelled children) in `npm test`.
- The same failure cluster reproduces at base commit `ab45989`; the affected test files are unchanged by the security-hardening branch.
- The real exports exist at both commits. The failure is caused by legacy relative mock specifiers and `exports` objects not matching Node's current `mock.module()` contract.
- The existing `e609c75` fix is the repository pattern: resolve each module with `new URL(relativePath, import.meta.url).href` and provide `namedExports`.

## Design

Update only test-side mock setup in the affected files. Each mocked module gets a file-local absolute URL constant and uses `namedExports` with the same stub values already present. No production source, dependency, runtime configuration, database, Docker state, or security behavior changes.

The affected mock families are:

- `ConsolidatorGC` and its dependencies in `consolidator-metrics.test.js`.
- `MEMORY_CONFIG` and dependencies in the five consolidator split tests.
- `SessionActivityTracker` and database stubs in `resources-active-session.test.js`.
- `queryWithAgentVector` in `search-scope-type-topic.test.js`.

## Verification

1. Run each affected test file individually and confirm the prior module-instantiation errors are gone.
2. Run the complete `npm test` suite and require zero failures, zero cancellations caused by these import errors, and exit code 0.
3. Run `npm run lint` and `git diff --check`.
4. Confirm only the eight test files plus this design/plan record changed; do not push, create a PR, merge, deploy, or alter runtime state.
