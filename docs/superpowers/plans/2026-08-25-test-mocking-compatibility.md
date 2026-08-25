# Test Mocking Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the complete unit-test suite by modernizing stale Node.js module mocks without changing production behavior.

**Architecture:** Keep all changes inside the affected unit-test setup. Resolve mocked modules to absolute `import.meta.url` URLs and expose named stubs through `namedExports`, matching the repository pattern introduced in `e609c75`.

**Tech Stack:** Node.js built-in test runner, ES modules, `node:test` module mocking, npm scripts.

## Global Constraints

- Modify only the affected test mock declarations and this plan/spec documentation.
- Preserve every existing stub implementation and assertion; change only module identity and export-shape compatibility.
- Do not modify production source, dependencies, runtime configuration, database, Docker state, or security behavior.
- Do not push, create a PR, merge, deploy, or send external messages.
- Full `npm test`, `npm run lint`, and `git diff --check` must be run after implementation.

---

### Task 1: Modernize stale unit-test module mocks

**Files:**
- Modify: `tests/unit/consolidator-metrics.test.js`
- Modify: `tests/unit/consolidator-split-anchor-guard.test.js`
- Modify: `tests/unit/consolidator-split-child-keywords.test.js`
- Modify: `tests/unit/consolidator-split-child-quality.test.js`
- Modify: `tests/unit/consolidator-split-partial-yield.test.js`
- Modify: `tests/unit/consolidator-split-subject-guard.test.js`
- Modify: `tests/unit/resources-active-session.test.js`
- Modify: `tests/unit/search-scope-type-topic.test.js`
- Test: the eight files above, then the complete npm suite

**Interfaces:**
- Consumes: existing test stubs and current production named exports.
- Produces: module mocks that Node resolves and injects before the tested modules import.

- [x] **Step 1: Write the failing test**

Use the existing failing tests as the regression specification. Do not add production behavior or weaken assertions. The current baseline failure is the module-instantiation error for `ConsolidatorGC`, `MEMORY_CONFIG`, `SessionActivityTracker`, or `queryWithAgentVector`.

- [x] **Step 2: Run the affected tests to verify the baseline failure**

Run:

```bash
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false node --experimental-test-module-mocks --test tests/unit/consolidator-metrics.test.js tests/unit/consolidator-split-anchor-guard.test.js tests/unit/consolidator-split-child-keywords.test.js tests/unit/consolidator-split-child-quality.test.js tests/unit/consolidator-split-partial-yield.test.js tests/unit/consolidator-split-subject-guard.test.js tests/unit/resources-active-session.test.js tests/unit/search-scope-type-topic.test.js
```

Expected: the legacy module-mocking errors occur before the affected assertions run.

- [x] **Step 3: Apply the minimal test-only compatibility change**

For every `mock.module("../../...", { exports: { ... } })` in the eight files:

```js
const moduleUrl = new URL("../../lib/example.js", import.meta.url).href;

mock.module(moduleUrl, {
  namedExports: {
    existingStub
  }
});
```

Use one URL constant per mocked module, preserve the existing stub names and bodies verbatim, and use the exact relative path already used by that test. For mocked default exports, preserve the repository's current default-export shape instead of inventing a new one.

- [x] **Step 4: Run the focused tests to verify the fix**

Run the same explicit eight-file Node test-runner command from Step 2. Result: 31 tests passed, 0 failed, 0 cancelled, and 0 skipped; no module-instantiation error remains.

- [x] **Step 5: Run repository verification**

Run:

```bash
npm test
npm run lint
git diff --check
```

Result: `npm test` exited 0 with 2643 passed, 0 failed, 0 cancelled, and 2 pre-existing skipped tests; lint exited 0 with 128 existing warnings and 0 errors; `git diff --check` emitted no output.

- [x] **Step 6: Commit the bounded change**

```bash
git add tests/unit/consolidator-metrics.test.js tests/unit/consolidator-split-anchor-guard.test.js tests/unit/consolidator-split-child-keywords.test.js tests/unit/consolidator-split-child-quality.test.js tests/unit/consolidator-split-partial-yield.test.js tests/unit/consolidator-split-subject-guard.test.js tests/unit/resources-active-session.test.js tests/unit/search-scope-type-topic.test.js docs/superpowers/specs/2026-08-25-test-mocking-compatibility-design.md docs/superpowers/plans/2026-08-25-test-mocking-compatibility.md
git commit -m "test: modernize stale module mocks"
```

Implementation commit: `db88aea`.
