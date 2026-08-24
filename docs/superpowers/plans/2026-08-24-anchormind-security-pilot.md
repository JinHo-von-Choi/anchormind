# Anchormind Security Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 가짜 데이터와 loopback HTTP만 사용하여 인증 fail-closed, loopback bind, API key/workspace 격리, 유지보수·조회 scope, AutoReflect scope, 외부 네트워크 0을 독립 검증 가능한 세 슬라이스로 만든다.

**Architecture:** 인증·bind 경계는 순수한 resolveBindHost()와 실제 listener address 검증 seam으로 분리한다. 메모리 read/write/maintenance 경로는 { keyId, groupKeyIds, workspace } scope를 명시적으로 전달하고 SQL과 결과 projection 양쪽에서 같은 경계를 적용한다. 마지막 fake-data E2E는 loopback HTTP의 실제 MCP 진입점에서 도구를 호출하되 DB·Redis·LLM은 fixture로 대체하고 외부 네트워크 tripwire로 범위 밖 연결을 즉시 실패시킨다.

**Tech Stack:** Node.js 22 node:test, node:assert/strict, ES modules, node:test module mocks, Node HTTP server, PostgreSQL/Redis/LLM fake adapters.

## Global Constraints

- 사용자가 승인한 범위는 이 계획의 코드 구현, 로컬 테스트, 가짜 데이터 파일럿, 작업 branch의 로컬 commit까지다. 실제 데이터 접근, 외부 전송, 공개, push, PR, merge, 배포는 수행하지 않는다.
- 실제 데이터와 운영 자격 증명을 사용하지 않는다. 모든 row, API key, session activity, LLM 응답은 결정론적 fixture로 만든다.
- 외부 네트워크 연결은 0회여야 한다. 테스트가 자기 자신에게 보내는 127.0.0.1 loopback HTTP만 허용하고 PostgreSQL, Redis, Gemini, DNS, 일반 TCP/TLS, child process provider 호출은 금지한다.
- 새 보안 테스트는 기존 2472 pass, 7 fail, 7 cancelled 기준선과 별도 실행·보고한다. 기존 실패를 새 테스트의 성공 또는 실패로 합산하지 않는다.
- 각 슬라이스는 독립 실행 가능하고, failing test → 실패 확인 → 최소 구현 → 통과 확인 → 커밋 순서를 지킨다.
- 새 unit 테스트는 DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false 환경에서 실행하고 active handle을 남기지 않는다.
- 파일럿의 명시적 workspace 요청은 해당 key와 workspace가 모두 정확히 일치하는 fragment만 허용한다. NULL 전역 fragment, 다른 workspace, 다른 key는 반환·링크·통계·유지보수 후보에 포함하지 않는다.
- allowed_workspaces 불일치는 기존 warning 계약을 보존하되, warning이 read/link scope를 넓히거나 다른 tenant를 승인하는 우회로가 되지 않게 한다.
- 각 task의 로컬 commit은 승인 범위에 포함된다. 원격 push, PR, merge는 포함되지 않는다.

## File Map and Contracts

| Slice | Create | Modify | Responsibility |
|---|---|---|---|
| Auth + loopback + offline foundation | lib/http/bind.js, tests/unit/security-hardening-auth-bind.test.js, tests/unit/security-hardening-offline.test.js | lib/auth.js, server.js, lib/http-server.js | fail-closed runtime decision, loopback default, network tripwire/fake adapter contract |
| Key + workspace scope integrity | tests/fixtures/security-hardening-data.js, tests/unit/security-hardening-key-workspace.test.js, tests/unit/security-hardening-maintenance-scope.test.js, tests/unit/security-hardening-read-scope.test.js | ContradictionDetector.js, GraphLinker.js, LinkStore.js, MemoryConsolidator.js, FragmentReader.js, HistoryReconstructor.js, lib/tools/memory.js, MemoryReflector.js | one scope contract across read, write, link, dedup, contradiction, history and stats |
| Fake-data E2E | tests/fixtures/security-hardening-harness.js, tests/e2e/security-hardening-fake-data.test.js | AutoReflect.js, ReflectProcessor.js, lib/http-server.js, server.js | loopback MCP entry point, fake data lifecycle, AutoReflect propagation, no external network |

The exact shared scope shape is:

    {
      keyId: "key-a",
      groupKeyIds: ["key-a"],
      workspace: "ws-a"
    }

The exact interfaces produced by the plan are:

    // lib/http/bind.js
    export function resolveBindHost(env = process.env) { /* returns string */ }

    // lib/http-server.js
    export function createHttpServer({ requestHandler, host = "127.0.0.1" }) { /* returns http.Server */ }

    MemoryConsolidator.prototype.getStats(scope = {})
    MemoryReflector.prototype.stats(scope = {})
    ContradictionDetector.prototype.detectContradictions(scope = {})
    GraphLinker.prototype.linkFragment(fragmentId, agentId = "default", keyId = null, groupKeyIds = [], workspace = null)
    SessionActivityTracker.getActivity(sessionId, scope = {})
    autoReflect(sessionId, agentId = "default", scope = {})

Each optional scope argument preserves master/backward-compatible calls by treating omitted keyId and workspace as unrestricted master scope; API-key calls must always pass the authenticated scope.

---

### Task 1: Auth, loopback bind, and offline test foundation

**Files:**

- Create: lib/http/bind.js
- Create: tests/unit/security-hardening-auth-bind.test.js
- Create: tests/unit/security-hardening-offline.test.js
- Modify: lib/auth.js:108-111
- Modify: server.js:296
- Modify: lib/http-server.js (extract the injectable HTTP server factory used by server.js)

**Interfaces:**

- Consumes: existing buildAuthDecision(accessKey, authDisabled, bearerToken) and current HTTP request handler.
- Produces: resolveBindHost(env), createHttpServer({ requestHandler, host }), runtime validateAuthentication() fail-closed behavior, and a reusable tripwire helper.
- Security rule: empty MEMENTO_ACCESS_KEY is rejected unless MEMENTO_AUTH_DISABLED=true; default bind host is 127.0.0.1.

- [ ] **Step 1: Write the failing test**

Add these cases to security-hardening-auth-bind.test.js:

    test("runtime authentication rejects an empty ACCESS_KEY without explicit AUTH_DISABLED", async () => {
      const result = await runAuthChild({
        MEMENTO_ACCESS_KEY: "",
        MEMENTO_AUTH_DISABLED: undefined,
        request: { headers: {}, socket: { encrypted: false } },
        message: { method: "tools/call" }
      });
      assert.equal(result.valid, false);
      assert.equal(result.error, "access_key_required");
    });

    test("AUTH_DISABLED is an explicit opt-in only", async () => {
      const result = await runAuthChild({
        MEMENTO_ACCESS_KEY: "",
        MEMENTO_AUTH_DISABLED: "true",
        request: { headers: {}, socket: { encrypted: false } },
        message: { method: "tools/call" }
      });
      assert.equal(result.valid, true);
      assert.equal(result.keyId, null);
    });

    test("default listener address is IPv4 loopback", async () => {
      const host = resolveBindHost({});
      const server = createHttpServer({
        requestHandler: (_req, res) => res.end("ok"),
        host
      });
      await listenOnEphemeralPort(server, host);
      assert.equal(server.address().address, "127.0.0.1");
      await closeServer(server);
    });

The child helper runs a separate Node process with REDIS_ENABLED=false, CACHE_ENABLED=false, no database variables, and serializes only the authentication result. It must not send a request to a real service.

- [ ] **Step 2: Run tests to verify they fail**

Run:

    DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
    node --experimental-test-module-mocks --test \
      tests/unit/security-hardening-auth-bind.test.js

Expected failure evidence before implementation:

- The empty-key runtime test fails because validateAuthentication() currently returns valid true from lib/auth.js:109-111.
- The listener address test fails because server.listen(PORT) in server.js:296 has no host argument and the default is not constrained to loopback.

A test process hang, real TCP connection, or cancelled test is not an expected failure; stop and repair the test fixture.

- [ ] **Step 3: Write the minimal implementation**

Implement only the two required boundaries:

    // lib/http/bind.js
    export function resolveBindHost(env = process.env) {
      const configured = String(env.MEMENTO_BIND_HOST || "").trim();
      return configured || "127.0.0.1";
    }

Change validateAuthentication() so the empty-key branch delegates to the fail-closed decision and returns valid false with error access_key_required unless AUTH_DISABLED is explicitly true. Change server wiring to call server.listen(PORT, resolveBindHost()). Move only the HTTP server construction needed for createHttpServer({ requestHandler, host }); do not change route semantics or add a network dependency.

Add security-hardening-offline.test.js with networkTripwire wrappers for globalThis.fetch, net.connect, tls.connect, http.request, https.request, child_process.spawn, and child_process.execFile. Each wrapper throws EXTERNAL_NETWORK_FORBIDDEN. The test adapter supplies fake DB/Redis/LLM functions and exports assertNoExternalNetworkCalls().

- [ ] **Step 4: Run tests to verify they pass**

Run:

    DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
    node --experimental-test-module-mocks --test \
      tests/unit/security-hardening-auth-bind.test.js \
      tests/unit/security-hardening-offline.test.js

Expected result: all tests pass, fail 0, cancelled 0, skipped 0, zero tripwire calls, every ephemeral server closed, and assertCleanShutdown() passes.

- [ ] **Step 5: Commit**

    git add lib/auth.js lib/http/bind.js lib/http-server.js server.js \
      tests/unit/security-hardening-auth-bind.test.js \
      tests/unit/security-hardening-offline.test.js
    git commit -m "test: harden auth loopback and offline boundaries"

This local commit is executed after the task's focused checks pass; it is never pushed automatically.

### Task 2: API key and workspace scope integrity

**Files:**

- Create: tests/fixtures/security-hardening-data.js
- Create: tests/unit/security-hardening-key-workspace.test.js
- Create: tests/unit/security-hardening-maintenance-scope.test.js
- Create: tests/unit/security-hardening-read-scope.test.js
- Modify: lib/memory/link/ContradictionDetector.js:74-150
- Modify: lib/memory/link/GraphLinker.js:38-107
- Modify: lib/memory/link/LinkStore.js:190-315
- Modify: lib/memory/consolidate/MemoryConsolidator.js:490-540,795-857
- Modify: lib/memory/read/FragmentReader.js:161-187
- Modify: lib/memory/read/HistoryReconstructor.js:50-210
- Modify: lib/tools/memory.js:695-733
- Modify: lib/memory/processors/MemoryReflector.js:79-101

**Interfaces:**

- Consumes: Task 1 fake adapters and shared scope { keyId, groupKeyIds, workspace }.
- Produces: scope-aware contradiction, dedup, link, stats, fragment history, and reconstruct-history paths.
- SQL rule: 파일럿의 selected workspace는 exact workspace만 허용하고 selected key는 exact key만 허용한다. NULL global row와 group을 통한 범위 확장은 금지한다.

- [ ] **Step 1: Write the failing test**

Create security-hardening-data.js with deterministic rows:

    export const fixture = {
      keys: [
        { id: "key-a", allowed_workspaces: ["ws-a"] },
        { id: "key-b", allowed_workspaces: ["ws-a"] }
      ],
      fragments: [
        { id: "a-a", key_id: "key-a", workspace: "ws-a", topic: "pilot", case_id: "case-a", session_id: "s-a", content: "A workspace A" },
        { id: "a-b", key_id: "key-a", workspace: "ws-b", topic: "pilot", case_id: "case-a", session_id: "s-a", content: "A workspace B" },
        { id: "b-a", key_id: "key-b", workspace: "ws-a", topic: "pilot", case_id: "case-a", session_id: "s-b", content: "B workspace A" },
        { id: "global", key_id: null, workspace: null, topic: "pilot", case_id: "case-a", session_id: "s-global", content: "Global pilot must remain hidden" }
      ],
      links: [
        { from_id: "a-a", to_id: "a-b", relation_type: "related" },
        { from_id: "a-a", to_id: "global", relation_type: "related" }
      ]
    };

    export const scopeA = {
      keyId: "key-a",
      groupKeyIds: ["key-a"],
      workspace: "ws-a"
    };

Add these test cases:

    test("key-a/ws-a recall returns only the exact scoped fragment", async () => {
      const result = await recallWithFakeStore(fixture, scopeA);
      assert.deepEqual(result.fragments.map((row) => row.id).sort(), ["a-a"]);
    });

    test("same key but another workspace is excluded from contradiction and dedup", async () => {
      const result = await runMaintenanceWithFakeStore({
        newer: Object.assign({}, fixture.fragments[0], { embedding: [1, 0], created_at: "2026-08-24T02:00:00Z" }),
        candidate: Object.assign({}, fixture.fragments[1], { embedding: [1, 0], created_at: "2026-08-24T01:00:00Z" })
      }, scopeA);
      assert.equal(result.contradictionLinks, 0);
      assert.equal(result.softDeleted, 0);
      assert.equal(result.externalLlmCalls, 0);
    });

    test("memory stats are scoped to exact key-a/ws-a", async () => {
      const result = await memoryStatsWithFakePool({
        _keyId: "key-a",
        _groupKeyIds: ["key-a"],
        workspace: "ws-a"
      });
      assert.equal(result.stats.total, 1);
      assert.equal(result.stats.workspaces.distribution.null_count, 0);
      assert.equal(result.stats.workspaces.distribution.top[0].workspace, "ws-a");
    });

    test("unauthorized fragment history returns no versions or superseded chain", async () => {
      const result = await fragmentHistoryWithFakeReader("a-b", scopeA);
      assert.equal(result.success, false);
      assert.equal(result.error, "Fragment not found or no permission");
    });

Test doubles record SQL text and bound parameters. A row returned by a fake query despite a missing scope predicate is a failure; do not filter the row only after the production method returns it.

- [ ] **Step 2: Run tests to verify they fail**

Run:

    DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
    node --experimental-test-module-mocks --test \
      tests/unit/security-hardening-key-workspace.test.js \
      tests/unit/security-hardening-maintenance-scope.test.js \
      tests/unit/security-hardening-read-scope.test.js

Expected failure evidence before implementation:

- Contradiction candidate SQL has key matching but no workspace predicate.
- GraphLinker dedup and link candidate SQL has key matching but no workspace predicate.
- tool_memoryStats() calls mgr.stats() without scope and getStats() aggregates all fragments.
- FragmentReader.getHistory() queries fragment_versions and fragment_links by fragment ID without key/workspace constraints, so unauthorized history rows can be returned.

The duplicate merge test must remain green if it already passes; a regression in its (key_id, workspace, content_hash) grouping is a stop condition, not a baseline failure.

- [ ] **Step 3: Write the minimal implementation**

Apply scope propagation without changing unrelated ranking or retention behavior:

1. Add workspace to ContradictionDetector candidate queries and pass scope through resolveContradiction; reject candidate pairs whose normalized key_id and workspace differ before any LLM or write call.
2. Add optional workspace to GraphLinker linkFragment() and both dedup and candidate SQL predicates. A cross-workspace similarity must not soft-delete, touch, supersede, or link.
3. Keep LinkStore workspace predicates in both directions of getLinkedFragments() and apply key and workspace predicates to joined fragment rows.
4. Preserve _mergeDuplicates() grouping by key_id, workspace, content_hash and add workspace predicates to every follow-up mutation.
5. Change MemoryConsolidator.getStats(scope = {}), MemoryReflector.stats(scope = {}), and tool_memoryStats(args) so key/group/workspace scope reaches every aggregate and evaluation query that exposes fragment/session data.
6. Extend FragmentReader.getHistory(fragmentId, agentId, keyId, groupKeyIds, opts) so current, versions, and superseded chain share key/group/workspace authorization. If current is unauthorized, return no versions or chain.
7. Extend HistoryReconstructor.reconstruct() and case-event/link reads with the same scope. Never build a causal chain from a row not present in the scoped timeline.

Use a strict pilot scope predicate (`key_id = $n AND workspace = $m`); bind values and never interpolate fixture values into SQL. Legacy non-pilot behavior is not widened or silently changed by this slice.

- [ ] **Step 4: Run tests to verify they pass**

Run the focused suite:

    DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
    node --experimental-test-module-mocks --test \
      tests/unit/security-hardening-key-workspace.test.js \
      tests/unit/security-hardening-maintenance-scope.test.js \
      tests/unit/security-hardening-read-scope.test.js

Expected result: all focused tests pass with no foreign IDs/content, no cross-workspace mutation, no unscoped aggregate SQL, and no cancelled tests.

Run related characterization tests separately:

    DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
    node --experimental-test-module-mocks --test \
      tests/unit/auth-fail-closed.test.js \
      tests/unit/fragment-isolation.test.js \
      tests/unit/linkstore-tenant-isolation.test.js \
      tests/unit/memory-stats-workspaces.test.js \
      tests/unit/fragment-history.test.js

Record any pre-existing failure separately. A new failure in an existing related test requires repair before this task passes.

- [ ] **Step 5: Commit**

    git add lib/memory/link/ContradictionDetector.js lib/memory/link/GraphLinker.js \
      lib/memory/link/LinkStore.js lib/memory/consolidate/MemoryConsolidator.js \
      lib/memory/read/FragmentReader.js lib/memory/read/HistoryReconstructor.js \
      lib/tools/memory.js lib/memory/processors/MemoryReflector.js \
      tests/fixtures/security-hardening-data.js \
      tests/unit/security-hardening-key-workspace.test.js \
      tests/unit/security-hardening-maintenance-scope.test.js \
      tests/unit/security-hardening-read-scope.test.js
    git commit -m "fix: enforce key and workspace scope across memory paths"

This local commit is executed after the task's focused checks pass; it is never pushed automatically.

### Task 3: Fake-data E2E and AutoReflect scope

**Files:**

- Create: tests/fixtures/security-hardening-harness.js
- Create: tests/e2e/security-hardening-fake-data.test.js
- Modify: lib/memory/processors/AutoReflect.js:38-102
- Modify: lib/memory/processors/ReflectProcessor.js:147-160,300-335,470-530
- Modify: lib/http-server.js
- Modify: server.js

**Interfaces:**

- Consumes: Task 1 createHttpServer({ requestHandler, host }), Task 2 fixture rows and scope-aware tools.
- Produces: createSecurityPilotHarness(fixture) with start(): Promise<{ baseUrl, close }> and callTool(name, args): Promise<object>; AutoReflect and ReflectProcessor preserve { keyId, groupKeyIds, workspace } for every generated fragment.
- E2E entry point: an actual loopback POST /mcp request with bearer/API-key authentication, not a direct call to an internal helper.

- [ ] **Step 1: Write the failing test**

Create the test-only harness contract:

    export function createSecurityPilotHarness(fixture) {
      return {
        async start() {},
        async callTool(name, args) {},
        async close() {}
      };
    }

The execution session replaces these bodies with the fake adapter and a real loopback base URL. Add these E2E cases:

    test("unauthenticated MCP request is rejected", async () => {
      const harness = createSecurityPilotHarness(fixture);
      const { baseUrl } = await harness.start();
      const response = await fetch(baseUrl + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "recall", arguments: {} }
        })
      });
      assert.equal(response.status, 401);
      await harness.close();
    });

    test("key-a/ws-a MCP flow cannot see key-b or ws-b", async () => {
      const harness = createSecurityPilotHarness(fixture);
      await harness.start();
      const result = await harness.callTool("recall", {
        _keyId: "key-a",
        _groupKeyIds: ["key-a"],
        workspace: "ws-a",
        keywords: ["pilot"]
      });
      assert.deepEqual(result.fragments.map((row) => row.id).sort(), ["a-a"]);
      await harness.close();
    });

    test("AutoReflect preserves key/workspace and excludes foreign session groups", async () => {
      const result = await runAutoReflectFixture({
        sessionId: "s-a",
        agentId: "agent-a",
        keyId: "key-a",
        groupKeyIds: ["key-a"],
        workspace: "ws-a"
      });
      assert.deepEqual(result.groups.map((group) => group.workspace), ["ws-a"]);
      assert.ok(result.fragments.every((row) => row.key_id === "key-a" && row.workspace === "ws-a"));
    });

    test("fake-data E2E performs zero external network calls", async () => {
      const harness = createSecurityPilotHarness(fixture);
      await harness.start();
      await harness.callTool("memory_stats", {
        _keyId: "key-a",
        _groupKeyIds: ["key-a"],
        workspace: "ws-a"
      });
      await harness.callTool("fragment_history", {
        id: "a-b",
        _keyId: "key-a",
        _groupKeyIds: ["key-a"],
        workspace: "ws-a"
      });
      assert.equal(networkTripwire.callsOutsideLoopback(), 0);
      await harness.close();
    });

The harness seeds key-a/ws-a, key-a/ws-b, key-b/ws-a, and a NULL global row from Task 2; the global row is a negative fixture and must never be returned. It provides deterministic session activity and a deterministic JSON LLM response. The network tripwire permits only the harness 127.0.0.1 listener and rejects all other destinations.

- [ ] **Step 2: Run tests to verify they fail**

Run:

    DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
    node --test --test-concurrency=1 tests/e2e/security-hardening-fake-data.test.js

Expected failure evidence before implementation:

- The current HTTP entry point has no injectable fake-data server factory.
- autoReflect() does not accept key/workspace scope and mgr.reflect() receives no key or workspace.
- A session group from ws-b can be included when the caller is scoped to ws-a.
- Any unexpected DB, Redis, LLM subprocess, or non-loopback HTTP attempt must fail with EXTERNAL_NETWORK_FORBIDDEN, never be silently skipped.

- [ ] **Step 3: Write the minimal implementation**

Implement the fake-data path without adding a production network client:

1. Make createHttpServer() accept the existing request handler and bind host so the harness uses the same HTTP boundary on an ephemeral loopback port.
2. Change autoReflect(sessionId, agentId, scope) to pass scope to SessionActivityTracker.getActivity(sessionId, scope), _reflectWithGemini(), and MemoryManager.reflect().
3. Require activity metadata to match requested key/workspace. A mismatch returns the existing skip result and invokes no LLM or write method.
4. Filter ReflectProcessor session groups by requested workspace and key/group scope before generating category or episode fragments. Every generated fragment and episode carries key, group, workspace, agent, and session metadata.
5. Wire the harness through the actual POST /mcp route and tool dispatch. Fake adapters implement only fixture methods; an unimplemented external adapter is a hard failure.

- [ ] **Step 4: Run tests to verify they pass**

Run fake-data E2E and the complete new security suite:

    DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
    node --test --test-concurrency=1 tests/e2e/security-hardening-fake-data.test.js

    DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
    node --experimental-test-module-mocks --test \
      "tests/unit/security-hardening-*.test.js"

Expected result: loopback MCP, scoped recall/stats/history, AutoReflect, contradiction/dedup/link guards, and authentication pass; external network count is zero; no test is skipped or cancelled.

Then run the existing baseline-only command:

    EXISTING_TEST_FILES="$(rg --files tests/unit | rg '\.test\.js$' | rg -v '/security-hardening-[^/]+\.test\.js$' | sort)"
    DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
    node --experimental-test-module-mocks --test $EXISTING_TEST_FILES

Compare only this existing-file result with the recorded baseline 2472 pass, 7 fail, 7 cancelled. A changed failure count is a regression; it is not hidden by the new security suite.

- [ ] **Step 5: Commit**

    git add lib/memory/processors/AutoReflect.js lib/memory/processors/ReflectProcessor.js \
      lib/http-server.js server.js tests/fixtures/security-hardening-harness.js \
      tests/e2e/security-hardening-fake-data.test.js
    git commit -m "test: verify scoped fake-data MCP flow offline"

This local commit is executed after the task's focused checks pass; it is never pushed automatically.

## Verification and Stop Conditions

The pilot is accepted only when all three slices pass their focused commands and the new security suite reports fail 0, cancelled 0, and skipped 0.

Stop immediately when any of these occurs:

- missing credentials produce a valid protected request;
- the actual default listener address is not 127.0.0.1;
- a key-b or wrong-workspace row appears in recall, history, reconstruction, stats, link, contradiction, dedup, or AutoReflect output;
- a cross-scope mutation occurs, including soft delete, importance update, link creation, or access-count update;
- a non-loopback network tripwire fires;
- a test uses real database/Redis/LLM data or leaves an active handle;
- a new security test is cancelled or skipped instead of passing.

No external publication, deployment, push, PR, merge, or real-data cleanup is part of this plan.
