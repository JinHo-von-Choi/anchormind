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
returned no loopback URL/result and the AutoReflect fixture returned null.

### GREEN

Focused E2E command: same command as above.

Result: 4 passed, 0 failed, 0 cancelled, 0 skipped.

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

Result: 77 passed, 0 failed, 0 cancelled, 0 skipped.

Existing-file baseline comparison (security-hardening files excluded):

```text
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
node --experimental-test-module-mocks --test <all existing unit test files>
```

Result: 2472 passed, 7 failed, 7 cancelled, 2 skipped. This matches the
recorded baseline; the known pre-existing mock-linkage failures remain and no
new regression was observed.

Static checks:

- `npx eslint` on all Task 3 source/test files: no errors or warnings.
- `git diff --check`: clean.

## Implementation

- `createSecurityPilotHarness()` binds the same injectable HTTP factory to an
  ephemeral `127.0.0.1` listener and exercises an actual `POST /mcp` request.
- Bearer/API-key authentication is checked before fake tool dispatch; fixture
  dispatch uses exact `(key_id, workspace)` matching and excludes the NULL
  global row, foreign key, and foreign workspace.
- The harness tripwire allows only loopback fetches, records/rejects external
  destinations, and fixes `ENABLE_SPREADING_ACTIVATION=false` for the pilot.
- `autoReflect(sessionId, agentId, scope)` validates activity metadata, passes
  `_keyId`, `_groupKeyIds`, and `workspace` into reflect, and filters generated
  output to the requested workspace/key.
- `ReflectProcessor` filters consolidated session groups by requested
  workspace and carries key/group/workspace metadata through generated
  fragments and episode creation.
- `server.js` supplies the resolved loopback host to the HTTP server factory.

## Concerns / limits

- This task intentionally uses a deterministic fake adapter. It proves the
  loopback HTTP boundary and scope contract, not production PostgreSQL/Redis or
  Gemini availability; the dedicated PostgreSQL pilot is Task 4.
- The existing baseline failures are unchanged and are not hidden by the new
  security suite.

## Commit

`155c285 test: verify scoped fake-data MCP flow offline`
