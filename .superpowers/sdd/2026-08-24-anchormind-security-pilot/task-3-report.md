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

Result: 81 passed, 0 failed, 0 cancelled, 0 skipped.

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

- `npx eslint` on all changed Task 3 source/test files: no errors or warnings.
  The existing `ACCESS_KEY` unused-import warning in `mcp-handler.js` remains
  outside this round's change.
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

## Commit

The implementation commit is the parent of the report-update commit at this
file's final handoff (`git show HEAD^`). The report intentionally does not
hardcode a pre-amend hash.
