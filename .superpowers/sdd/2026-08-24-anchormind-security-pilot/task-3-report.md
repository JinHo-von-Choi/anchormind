# Task 3 report — fake-data E2E and AutoReflect scope

## Status

Implemented locally on the security-hardening worktree. No real data, external
network, external database, Redis, LLM provider, push, PR, merge, or deploy was
used.

## TDD evidence

### RED

Command:

```text
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
node --test --test-concurrency=1 tests/e2e/security-hardening-fake-data.test.js
```

Result: 3 failed, 1 passed, 0 cancelled, 0 skipped. The contract-only harness
returned no loopback URL/result and the AutoReflect fixture returned null. The
round-1 RED additions also covered production-route scope spoofing and the
missing external transport/child-process tripwire.

### GREEN

Focused E2E command: same command as above.

Result: 8 passed, 0 failed, 0 cancelled, 0 skipped.

Additional targeted regression command:

```text
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test \
  tests/unit/reflect-processor-extended.test.js tests/unit/auto-reflect.test.js
```

Result: 35 passed, 0 failed, 0 cancelled, 0 skipped.

Complete new security suite plus Task 3 E2E:

```text
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test "tests/unit/security-hardening-*.test.js" \
  tests/e2e/security-hardening-fake-data.test.js
```

Result: 82 passed, 0 failed, 0 cancelled, 0 skipped.

Related production-path regression command:

```text
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test \
  tests/unit/session-linker-consolidate-groups.test.js \
  tests/unit/reflect-processor-extended.test.js tests/unit/auto-reflect.test.js \
  tests/unit/mcp-handler-batch-json.test.js tests/unit/mcp-protocol-reanchor-integration.test.js
```

Result: 52 passed, 0 failed, 0 cancelled, 0 skipped.

Existing-file baseline comparison (security-hardening files excluded):

```text
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test <all existing unit test files>
```

Result: 2472 passed, 7 failed, 7 cancelled, 2 skipped. This matches the
recorded baseline; the known pre-existing mock-linkage failures remain and no
new regression was observed.

Static checks:

- `npx eslint` on all changed Task 3 source/test files: 0 errors; the existing
  unused `preserveRedis` parameter warning in `sessions.js:508` remains.
- `git diff --check`: clean.

## Implementation

- `createSecurityPilotHarness()` now invokes the production `handleMcpPost`
  route with injectable fake authentication/dispatch adapters. It no longer
  owns an HTTP handler or tool dispatcher and exercises an actual loopback
  `POST /mcp` session initialize plus `tools/call`.
- Authenticated scope is immutable: `_keyId`, `_groupKeyIds`, and workspace
  claims supplied in the body are rejected on mismatch before injection; the
  fake client cannot select the key-b token.
- The tripwire allows only loopback fetch/http/https/net/tls calls, rejects
  external DNS and all child-process creation, restores every patched API, and
  fixes `ENABLE_SPREADING_ACTIVATION=false` for the pilot.
- Session activity records carry key/group/workspace metadata and scoped reads
  fail closed. Scoped AutoReflect mismatch performs no LLM call, reflect/write,
  or `markReflected` mutation.
- `autoReflect(sessionId, agentId, scope)` validates activity metadata, passes
  `_keyId`, `_groupKeyIds`, and `workspace` into reflect, and filters generated
  output to the requested workspace/key.
- `ReflectProcessor` and `SessionLinker` pass exact key/group/workspace scope
  into session consolidation and auto-link filtering, then carry metadata
  through generated fragments and episode creation.
- `server.js` supplies the resolved loopback host to the HTTP server factory.

## Concerns / limits

- This task intentionally uses a deterministic fake adapter. It proves the
  loopback HTTP boundary and scope contract, not production PostgreSQL/Redis or
  Gemini availability; the dedicated PostgreSQL pilot is Task 4.
- The existing baseline failures are unchanged and are not hidden by the new
  security suite.

## Reviewer fix round 2

RED additions and observed failures:

- AutoReflect returned `count: 2` while workspace filtering retained one
  fragment.
- `node:dns/promises` was not covered by the tripwire.
- A harness could not safely run start → close → start → close because the
  closed flag prevented the second restore.
- Session close/idle-expiry paths could invoke AutoReflect without an immutable
  key/group/workspace tuple, and partial SessionLinker scope could fall through
  to an unrestricted path.

Focused GREEN command:

```text
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test --test-concurrency=1 \
  tests/unit/session-scope-autoreflect.test.js tests/unit/session-linker-scope.test.js \
  tests/e2e/security-hardening-fake-data.test.js
```

Result: 13 passed, 0 failed, 0 cancelled, 0 skipped. The new tests cover
close/idle-expiry/expired cleanup with a cross-workspace fixture, no reflect
call for missing workspace, filtered fragment count, promise DNS blocking, and
tripwire restoration across two complete harness lifecycles.

Complete security suite plus Task 3 E2E after the fix:

```text
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test --test-concurrency=1 \
  $(rg --files tests/unit | rg 'security-hardening-.*\\.test\\.js$' | sort) \
  tests/e2e/security-hardening-fake-data.test.js
```

Result: 82 passed, 0 failed, 0 cancelled, 0 skipped.

Existing baseline comparison excluded all `security-hardening-*.test.js`
files and the two new Task 3 scope regression files, so it compares the same
pre-task file set:

Result: 2488 tests — 2472 passed, 7 failed, 7 cancelled, 2 skipped. This is
the recorded baseline; the known mock-linkage/module-isolation failures remain.

Static checks after the fix:

- `npx eslint` on all changed source/test files: 0 errors; one pre-existing
  warning remains at `lib/sessions.js:508` for the unused `preserveRedis`
  parameter in the legacy close function.
- `git diff --check`: clean.

The implementation and regression tests are stored in local commit
`c50670580ceb8f9b051a2ef26386d192f3f064e2` (`fix: close Task 3 scope review gaps`).
The report update is a separate follow-up documentation commit; at final
handoff, the report-update commit is repository `HEAD` and the implementation
commit is `HEAD^`.

## Reviewer fix round 3

RED command:

```text
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test --test-concurrency=1 \
  tests/unit/session-scope-autoreflect.test.js \
  tests/e2e/security-hardening-fake-data.test.js
```

Result: 15 tests — 13 passed, 2 failed, 0 cancelled, 0 skipped. The failures
were the missing master/legacy close, idle, expiry, segment, and legacy-SSE
reflect behavior. A separate RED assertion caught that an authenticated key
with fragment metadata missing its group scope must not use the legacy path.

Round 3 focused GREEN command:

```text
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test --test-concurrency=1 \
  tests/unit/session-scope-autoreflect.test.js tests/unit/session-linker-scope.test.js \
  tests/e2e/security-hardening-fake-data.test.js
```

Result: 16 passed, 0 failed, 0 cancelled, 0 skipped. It covers true master
streamable close/idle/expiry/segment paths, legacy SSE close, authenticated
partial scope denial, exact group metadata filtering, and every patched
transport function identity after two complete harness lifecycles.

Complete security suite plus E2E: 84 passed, 0 failed, 0 cancelled, 0 skipped.

Related production-path command: 71 tests — 70 passed, 1 failed. The single
failure is the pre-existing tenant-isolation test that supplies an
authenticated `keyId` while omitting all fragment key/workspace/group metadata;
Round 3 intentionally removes that legacy bypass per the accepted contract.

Existing baseline comparison (same pre-task files, excluding the two new Task
3 scope test files and security-hardening suite): 2488 tests — 2471 passed,
8 failed, 7 cancelled, 2 skipped. The one-count delta is the intentional
tenant-isolation contract change above; the remaining failures are the known
mock-linkage/module-isolation baseline failures.

Static checks: ESLint 0 errors with the existing `sessions.js:512`
`preserveRedis` unused-parameter warning; `git diff --check` clean.

Round 3 implementation commit:
`dd49c564e35a999c364441cf514719868a84c3a1` (`fix: preserve master reflect and enforce exact linker scope`).
The documentation update is a follow-up commit; at final handoff the report
commit is `HEAD` and this implementation commit is `HEAD^`.

## Commit

The implementation commit is the parent of the report-update commit at this
file's final handoff (`git show HEAD^`). The report intentionally does not
hardcode a pre-amend hash.
