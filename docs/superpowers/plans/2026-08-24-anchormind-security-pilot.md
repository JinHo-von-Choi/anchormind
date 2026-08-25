# Anchormind Security Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 세 개의 가짜-data 논리 슬라이스와 별도 격리된 PostgreSQL+pgvector 로컬 파일럿으로 인증 fail-closed, loopback bind, API key/workspace 격리, 유지보수·조회 scope, AutoReflect scope, Node/application 프로세스의 non-loopback outbound attempts 0건을 독립 검증한다. PostgreSQL 컨테이너 패킷 egress는 이 tripwire로 방화벽 관찰하지 않으며, 단일 PostgreSQL service/container·loopback-only published port·외부 provider 설정 부재를 함께 확인한다.

**Architecture:** 인증·bind 경계는 순수한 resolveBindHost()와 실제 listener address 검증 seam으로 분리한다. 메모리 read/write/maintenance 경로는 { keyId, groupKeyIds, workspace } scope를 명시적으로 전달하고 SQL과 결과 projection 양쪽에서 같은 경계를 적용한다. fake-data E2E는 DB·Redis·LLM을 fixture로 대체하고, 마지막 로컬 DB 파일럿만 별도 PostgreSQL+pgvector 컨테이너의 실제 SQL readback을 사용한다.

**Tech Stack:** Node.js 22 node:test, node:assert/strict, ES modules, node:test module mocks, Node HTTP server, PostgreSQL/Redis/LLM fake adapters.

## Global Constraints

### Canonical security-pilot runtime contract

The pilot has one supported automation contract: `MEMENTO_SECURITY_PILOT_AUTOMATION=off`.
There is no supported alias such as `MEMENTO_PILOT_MODE` or a pilot-specific
`MEMENTO_*_ENABLED` variable. Those aliases do not activate the pilot and must not
be used as substitutes for the canonical names below. Startup validation fails closed
when any required name is missing or has an unsafe value:

```text
ENABLE_SPREADING_ACTIVATION=false
ENABLE_RECONSOLIDATION=false
MEMENTO_AUTO_REFLECT=false
MEMENTO_GRAPH_LINK=false
MEMENTO_CONSOLIDATE=false
MEMENTO_GC=false
MEMENTO_CONSOLIDATE_SPLIT_LONG=false
MEMENTO_CONSOLIDATE_DETECT_CONTRADICT=false
MEMENTO_CONSOLIDATE_COMPRESS_OLD=false
```

The validator also requires a non-empty `MEMENTO_ACCESS_KEY`, authentication enabled
(`MEMENTO_AUTH_DISABLED` is not `true`), an exactly resolved `127.0.0.1` bind, and a
complete absolute local embedding snapshot. It rejects external model/API/LLM URLs
before listener, scheduler, or model side effects are created. This is the authoritative
pilot contract; generic product flags such as `MEMENTO_CASE_BACKPROP_ENABLED` remain
separate features and are not pilot aliases.

- 사용자가 승인한 범위는 이 계획의 코드 구현, 로컬 테스트, 가짜 데이터 파일럿, 작업 branch의 로컬 commit까지다. 실제 데이터 접근, 외부 전송, 공개, push, PR, merge, 배포는 수행하지 않는다.
- 실제 데이터와 운영 자격 증명을 사용하지 않는다. 모든 row, API key, session activity, LLM 응답은 결정론적 fixture로 만든다.
- Task 1~3의 Node/application 프로세스는 127.0.0.1 loopback HTTP만 허용하고 non-loopback outbound attempts는 0건이어야 한다. PostgreSQL, Redis, Gemini, DNS, 일반 TCP/TLS, child process provider 호출은 금지한다. PostgreSQL 컨테이너 패킷은 이 tripwire 관찰 범위가 아니다.
- Task 4만 예외적으로 전용 PostgreSQL+pgvector 컨테이너의 127.0.0.1 전용 published port에 연결한다. Task 4도 Redis·Gemini·외부 HTTP·외부 DNS·비 loopback TCP/TLS는 금지한다. 전용 bridge는 host port forwarding을 위해 `Internal=false`로 유지하고, Node/application outbound-attempts tripwire만 앱의 egress 증거로 사용한다. PostgreSQL 컨테이너 패킷은 이 증거에서 not observed(관찰되지 않음)이며 Docker-level firewall을 주장하지 않는다.
- Task 4는 기존 dev/test DB, container, named volume, schema 상태, port를 읽거나 변경하지 않는다. 전용 compose 파일·DB 이름·volume 이름·port만 사용한다.
- Task 4 fixture는 synthetic data뿐이다. EMBEDDING_PROVIDER=transformers와 사전 존재하는 local cache만 사용하며, 모델 cache가 없으면 다운로드하지 않고 BLOCKED 상태(exit 3)로 중단한다.
- Task 4에서는 auto reflect, automatic graph link, scheduled consolidation, FragmentGC, NLI/LLM preload를 off로 고정한다. 테스트가 명시적으로 호출하는 scope·link·history 경로만 실행한다.
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
| Fake-data E2E | tests/fixtures/security-hardening-harness.js, tests/e2e/security-hardening-fake-data.test.js | AutoReflect.js, ReflectProcessor.js, lib/http-server.js, server.js | loopback MCP entry point, fake data lifecycle, AutoReflect propagation, Node/application outbound-attempt tripwire |
| Dedicated local DB pilot | docker-compose.security-pilot.yml, .env.security-pilot.example, tests/fixtures/security-pilot.ndjson, scripts/run-security-pilot.sh, tests/integration/security-pilot.test.js | none | isolated PostgreSQL+pgvector readback with synthetic data, local transformers cache, and egress/automation gates |

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
- Produces: resolveBindHost(env), createHttpServer({ requestHandler, host }), runtime validateAuthentication() fail-closed behavior, and createNetworkTripwire({ allowedHosts }) returning { externalNetworkAttempts, restore, assertNoExternalNetworkCalls }.
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

Add security-hardening-offline.test.js with createNetworkTripwire({ allowedHosts }) wrappers for globalThis.fetch, net.connect, tls.connect, http.request, https.request, child_process.spawn, and child_process.execFile. Each non-allowlisted wrapper throws EXTERNAL_NETWORK_FORBIDDEN and appends to externalNetworkAttempts. The test adapter supplies fake DB/Redis/LLM functions and exports assertNoExternalNetworkCalls().

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

    test("fake-data E2E records zero Node/application non-loopback outbound attempts", async () => {
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

Expected result: loopback MCP, scoped recall/stats/history, AutoReflect, contradiction/dedup/link guards, and authentication pass; Node/application non-loopback outbound-attempt count is zero; no test is skipped or cancelled. PostgreSQL container packets are not observed by this tripwire.

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

### Task 4: Dedicated PostgreSQL+pgvector local fake-data pilot

**Files:**

- Create: docker-compose.security-pilot.yml
- Create: .env.security-pilot.example
- Create: tests/fixtures/security-pilot.ndjson
- Create: scripts/run-security-pilot.sh
- Create: tests/integration/security-pilot.test.js
- Modify: none

**Interfaces:**

- Consumes: Task 1–3 scope-aware code and the existing migration runner scripts/migrate.js.
- Produces: a separate PostgreSQL+pgvector database named memento_security_pilot, bound only to 127.0.0.1:35434, seeded only from tests/fixtures/security-pilot.ndjson, with SQL readback proving key/workspace isolation.
- Runtime contract: Redis, scheduler, AutoReflect, automatic GraphLinker, consolidation, FragmentGC, NLI preload, and external LLM providers are off. Only explicit test calls run.
- Model contract: EMBEDDING_PROVIDER=transformers and Xenova/multilingual-e5-small are accepted only when the local model cache already exists. Missing cache is BLOCKED with exit code 3; no download or fallback is attempted.

- [ ] **Step 1: Write the failing integration test and pilot fixture**

Create tests/fixtures/security-pilot.ndjson as synthetic JSON Lines. Use valid UUID-shaped IDs so foreign-key constraints are exercised, and use no real person, property, account, or production content:

    {"kind":"api_key","id":"00000000-0000-0000-0000-00000000aaaa","name":"security-pilot-a","allowed_workspaces":["pilot-ws-a"]}
    {"kind":"api_key","id":"00000000-0000-0000-0000-00000000bbbb","name":"security-pilot-b","allowed_workspaces":["pilot-ws-a"]}
    {"kind":"fragment","id":"10000000-0000-0000-0000-00000000aaaa","key_id":"00000000-0000-0000-0000-00000000aaaa","workspace":"pilot-ws-a","topic":"security-pilot-synthetic","content":"Synthetic key A workspace A fact","session_id":"pilot-session-a","case_id":"pilot-case-a","type":"fact"}
    {"kind":"fragment","id":"10000000-0000-0000-0000-00000000aaab","key_id":"00000000-0000-0000-0000-00000000aaaa","workspace":"pilot-ws-b","topic":"security-pilot-synthetic","content":"Synthetic key A workspace B fact","session_id":"pilot-session-a","case_id":"pilot-case-a","type":"fact"}
    {"kind":"fragment","id":"10000000-0000-0000-0000-00000000bbbb","key_id":"00000000-0000-0000-0000-00000000bbbb","workspace":"pilot-ws-a","topic":"security-pilot-synthetic","content":"Synthetic key B workspace A fact","session_id":"pilot-session-b","case_id":"pilot-case-a","type":"fact"}

The test file must contain these named cases:

    test("pilot database is the dedicated pgvector database", async () => {
      const database = await queryValue("SELECT current_database()");
      const vectorExtension = await queryValue("SELECT extname FROM pg_extension WHERE extname = 'vector'");
      assert.equal(database, "memento_security_pilot");
      assert.equal(vectorExtension, "vector");
    });

    test("NDJSON fixture readback contains exactly the synthetic key/workspace rows", async () => {
      const rows = await queryRows("SELECT key_id, workspace FROM agent_memory.fragments WHERE topic = $1 ORDER BY key_id, workspace", ["security-pilot-synthetic"]);
      assert.deepEqual(rows, [
        { key_id: "00000000-0000-0000-0000-00000000aaaa", workspace: "pilot-ws-a" },
        { key_id: "00000000-0000-0000-0000-00000000aaaa", workspace: "pilot-ws-b" },
        { key_id: "00000000-0000-0000-0000-00000000bbbb", workspace: "pilot-ws-a" }
      ]);
    });

    test("real PostgreSQL recall scope excludes the other key and workspace", async () => {
      const result = await recallWithScope({
        _keyId: "00000000-0000-0000-0000-00000000aaaa",
        _groupKeyIds: ["00000000-0000-0000-0000-00000000aaaa"],
        workspace: "pilot-ws-a",
        keywords: ["security-pilot-synthetic"]
      });
      assert.deepEqual(result.fragments.map((row) => row.id), ["10000000-0000-0000-0000-00000000aaaa"]);
    });

    test("real PostgreSQL history and stats stay within the requested scope", async () => {
      const history = await fragmentHistoryWithScope("10000000-0000-0000-0000-00000000aaab", {
        _keyId: "00000000-0000-0000-0000-00000000aaaa",
        _groupKeyIds: ["00000000-0000-0000-0000-00000000aaaa"],
        workspace: "pilot-ws-a"
      });
      assert.equal(history.success, false);
      const stats = await memoryStatsWithScope({
        _keyId: "00000000-0000-0000-0000-00000000aaaa",
        _groupKeyIds: ["00000000-0000-0000-0000-00000000aaaa"],
        workspace: "pilot-ws-a"
      });
      assert.equal(stats.stats.total, 1);
    });

    test("automation remains off and no link/consolidation/GC side effect occurs", async () => {
      assert.equal(process.env.MEMENTO_SECURITY_PILOT_AUTOMATION, "off");
      assert.equal(process.env.MEMENTO_AUTO_REFLECT, "false");
      assert.equal(process.env.MEMENTO_GRAPH_LINK, "false");
      assert.equal(process.env.MEMENTO_CONSOLIDATE, "false");
      assert.equal(process.env.MEMENTO_GC, "false");
      assert.equal(await queryValue("SELECT count(*) FROM agent_memory.fragment_links"), "0");
      assert.equal(await queryValue("SELECT count(*) FROM agent_memory.fragments WHERE topic = 'session_reflect'"), "0");
    });

    test("pilot Node/application non-loopback outbound attempts remain zero", async () => {
      assert.deepEqual(externalNetworkAttempts.filter((attempt) => !isLoopback(attempt.host)), []);
    });

Before constructing the pg Pool, install the Task 1 network tripwire with an allowlist containing only 127.0.0.1 and ::1. The integration test uses a pg Pool with host 127.0.0.1 and port 35434 only; any Node/application non-loopback outbound attempt throws and records externalNetworkAttempts. PostgreSQL container packets are not observed by this tripwire. It loads the NDJSON fixture with parameterized INSERT statements, performs all assertions, and removes only rows whose topic is security-pilot-synthetic in this dedicated database during teardown. It must fail rather than skip when the dedicated database is unavailable.

- [ ] **Step 2: Run the test to verify the precondition fails without external download or an existing pilot database**

Run:

    DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
    MEMENTO_SECURITY_PILOT_AUTOMATION=off \
    node --test --test-concurrency=1 tests/integration/security-pilot.test.js

Expected result before the compose runner exists: connection failure or an explicit BLOCKED result stating that memento_security_pilot at 127.0.0.1:35434 is unavailable. This is a precondition failure, not a pass. The command must not contact a different port, start docker-compose.test.yml, start docker-compose.dev.yml, or download a model.

- [ ] **Step 3: Write the minimal dedicated pilot files**

Create docker-compose.security-pilot.yml with only this service and its private volume/network:

    services:
      postgres-security-pilot:
        image: pgvector/pgvector:pg15
        container_name: anchormind-security-pilot-postgres
        environment:
          POSTGRES_DB: memento_security_pilot
          POSTGRES_USER: memento_pilot
          POSTGRES_PASSWORD: local_security_pilot_only
        ports:
          - "127.0.0.1:35434:5432"
        volumes:
          - security_pilot_pgdata:/var/lib/postgresql/data
        networks:
          - security_pilot_internal
        healthcheck:
          test: ["CMD-SHELL", "pg_isready -U memento_pilot -d memento_security_pilot"]
          interval: 2s
          timeout: 5s
          retries: 15

    networks:
      security_pilot_internal:
        name: anchormind_security_pilot_bridge

    volumes:
      security_pilot_pgdata:
        name: anchormind_security_pilot_pgdata

Create .env.security-pilot.example with only local synthetic settings:

    SECURITY_PILOT_COMPOSE_FILE=docker-compose.security-pilot.yml
    SECURITY_PILOT_ENV_FILE=.env.security-pilot.example
    SECURITY_PILOT_DB_HOST=127.0.0.1
    SECURITY_PILOT_DB_PORT=35434
    SECURITY_PILOT_DB_NAME=memento_security_pilot
    SECURITY_PILOT_DB_USER=memento_pilot
    SECURITY_PILOT_DB_PASSWORD=local_security_pilot_only
    DATABASE_URL=postgresql://memento_pilot:local_security_pilot_only@127.0.0.1:35434/memento_security_pilot
    EMBEDDING_PROVIDER=transformers
    EMBEDDING_MODEL=
    EMBEDDING_DIMENSIONS=384
    EMBEDDING_API_KEY=
    HF_HUB_OFFLINE=1
    TRANSFORMERS_OFFLINE=1
    SECURITY_PILOT_MODEL_CACHE=$HOME/.cache/huggingface/hub/models--Xenova--multilingual-e5-small
    MEMENTO_SECURITY_PILOT_AUTOMATION=off
    MEMENTO_AUTO_REFLECT=false
    MEMENTO_GRAPH_LINK=false
    MEMENTO_CONSOLIDATE=false
    MEMENTO_GC=false
    MEMENTO_CONSOLIDATE_SPLIT_LONG=false
    MEMENTO_CONSOLIDATE_DETECT_CONTRADICT=false
    MEMENTO_CONSOLIDATE_COMPRESS_OLD=false
    ENABLE_RECONSOLIDATION=false
    MCP_IDLE_REFLECT_HOURS=876000

Implement scripts/run-security-pilot.sh with these exact gates and order:

1. Set `set -euo pipefail`, resolve the repository root, and load only SECURITY_PILOT_ENV_FILE.
2. Verify docker and docker compose are available. Verify `docker image inspect pgvector/pgvector:pg15` succeeds; otherwise print `BLOCKED: pgvector image is not present locally; refusing external pull` and exit 3.
3. Select only snapshot candidates containing `config.json`, `tokenizer.json`, and either q8 ONNX filename (`onnx/model_quantized.onnx` or `onnx/model_q8.onnx`). Prefer a valid `refs/main` target; otherwise require exactly one valid candidate after stable sorting. Snapshot revision names are not time-ordered, so multiple valid candidates are `BLOCKED: ... ambiguous` and exit 3; no external download is attempted.
4. Verify no listener is using 35432 or 35433 and no existing compose project is selected. Do not call docker compose against either existing compose file.
5. Run `docker compose -f docker-compose.security-pilot.yml --env-file .env.security-pilot.example up -d --wait` and assert the service is healthy, the published binding is exactly 127.0.0.1:35434, the named volume is anchormind_security_pilot_pgdata, the only service is `postgres-security-pilot`, and the dedicated network is named `anchormind_security_pilot_bridge` with `Internal=false`. Read back the bridge attachment list and require exactly one container ID equal to `SERVICE_ID`. This bridge is required because Docker Desktop 4.72.0 does not publish a host port from an `internal: true` network.
6. Set DATABASE_URL from the pilot env and run `node scripts/migrate.js`. Run only the requested integration test with test concurrency 1. Do not start server.js, Redis, scheduler, worker, AutoReflect, GraphLinker, consolidation, FragmentGC, or NLI preload.
7. Perform authoritative readback with `psql` against DATABASE_URL: current_database() must be memento_security_pilot, vector must be installed, fixture count must be 3, and all key/workspace pairs must match the NDJSON file.
8. Confirm the integration tripwire reports zero Node/application non-loopback outbound attempts, the dedicated bridge reports `Internal=false` with exactly the canonical `SERVICE_ID` attached, and no address other than `127.0.0.1:35434` is published. This does not observe arbitrary PostgreSQL container packets or provide Docker-level firewall evidence.
9. On exit, run `docker compose -f docker-compose.security-pilot.yml --env-file .env.security-pilot.example down --remove-orphans` without `-v`; never touch any other volume or container. Preserve the dedicated synthetic volume for inspection.

- [ ] **Step 4: Run the dedicated pilot and verify real SQL readback**

Run exactly:

    bash scripts/run-security-pilot.sh

Expected result:

- Exit 0 only when migrations, fixture load, PostgreSQL+pgvector readback, real recall/history/stats scope assertions, automation-off assertions, and scoped Node/application outbound-attempt checks pass. PostgreSQL container packets are not observed by that tripwire.
- The script prints the dedicated database identity, vector extension, bound address, named volume, fixture count, and key/workspace pairs from the actual database.
- The model is loaded from the existing local transformers cache only. A missing cache produces BLOCKED/exit 3 and no download attempt.
- Existing dev/test compose projects, ports 35432/35433, and volumes are unchanged.

The runner resolves a validated local snapshot and exports its absolute path as both
`SECURITY_PILOT_MODEL_SNAPSHOT` and `EMBEDDING_MODEL`. After the script finishes, run the
integration test directly once more only if the dedicated container is intentionally left
running, using that same resolved absolute snapshot path:

    DOTENV_CONFIG_PATH=.env.security-pilot.example \
    DATABASE_URL=postgresql://memento_pilot:local_security_pilot_only@127.0.0.1:35434/memento_security_pilot \
    SECURITY_PILOT_MODEL_SNAPSHOT=/absolute/local/snapshot \
    EMBEDDING_PROVIDER=transformers EMBEDDING_MODEL=/absolute/local/snapshot \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    MEMENTO_SECURITY_PILOT_AUTOMATION=off MEMENTO_AUTO_REFLECT=false \
    MEMENTO_GRAPH_LINK=false MEMENTO_CONSOLIDATE=false MEMENTO_GC=false \
    node --test --test-concurrency=1 tests/integration/security-pilot.test.js

- [ ] **Step 5: Commit the local pilot artifacts**

    git add docker-compose.security-pilot.yml .env.security-pilot.example \
      tests/fixtures/security-pilot.ndjson scripts/run-security-pilot.sh \
      tests/integration/security-pilot.test.js
    git commit -m "test: add isolated postgres security pilot"

This commit is local to the approved work branch and is never pushed automatically.

## Verification and Stop Conditions

The pilot is accepted only when the three logic slices and the dedicated local database pilot pass their focused commands and the new security suite reports fail 0, cancelled 0, and skipped 0.

Stop immediately when any of these occurs:

- missing credentials produce a valid protected request;
- the actual default listener address is not 127.0.0.1;
- a key-b or wrong-workspace row appears in recall, history, reconstruction, stats, link, contradiction, dedup, or AutoReflect output;
- a cross-scope mutation occurs, including soft delete, importance update, link creation, or access-count update;
- a Node/application non-loopback outbound-attempt tripwire fires;
- a test uses real database/Redis/LLM data or leaves an active handle;
- a new security test is cancelled or skipped instead of passing.

No external publication, deployment, push, PR, merge, or real-data cleanup is part of this plan.
