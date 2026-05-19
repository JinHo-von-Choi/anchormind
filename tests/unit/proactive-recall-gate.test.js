/**
 * ProactiveRecall gate 통합 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-05-19
 *
 * mode/workspace/caseIdPolicy 조합 8가지 시나리오 검증.
 * DB 없이 mock store로 동작한다.
 */

import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";

import { disconnectRedis } from "../../lib/redis.js";

after(async () => { await disconnectRedis().catch(() => {}); });

/* ──────────────────────────────────────────────────────────────
   mock 의존성
────────────────────────────────────────────────────────────── */

function makeMockStore(overrides = {}) {
  return {
    createLink      : mock.fn(async () => undefined),
    searchByKeywords: mock.fn(async () => []),
    ...overrides,
  };
}

function makeMockSearch(candidates = []) {
  return {
    search: mock.fn(async () => ({ fragments: candidates }))
  };
}

function makeMockDeps({ candidates = [], storeOverrides = {} } = {}) {
  return {
    store           : makeMockStore(storeOverrides),
    search          : makeMockSearch(candidates),
    conflictResolver: {
      checkAssertionConsistency: mock.fn(async () => ({ assertionStatus: "observed" })),
    },
    temporalLinker  : {
      linkTemporalNeighbors: mock.fn(async () => undefined),
    },
    morphemeIndex   : {
      tokenize              : mock.fn(async () => []),
      getOrRegisterEmbeddings: mock.fn(async () => undefined),
    },
  };
}

/* RememberPostProcessor 로드 */
const { RememberPostProcessor } = await import("../../lib/memory/RememberPostProcessor.js");
const { MEMORY_CONFIG }         = await import("../../config/memory.js");

/** run 후 fire-and-forget Promise 대기 헬퍼 */
async function runAndWait(processor, fragment, ctx) {
  await processor.run(fragment, ctx);
  if (processor._proactiveRecallPromise) {
    await processor._proactiveRecallPromise;
  }
}

/** 키워드 50% 오버랩을 보장하는 candidate 파편 생성 */
function makeCandidate(overrides = {}) {
  return {
    id      : overrides.id      ?? "cand-1",
    content : "cpu 사용률 높음 성능 문제",
    keywords: ["cpu", "성능"],
    workspace_id: overrides.workspace_id ?? null,
    case_id     : overrides.case_id      ?? null,
    session_id  : overrides.session_id   ?? null,
    created_at  : overrides.created_at   ?? new Date().toISOString(),
    ...overrides,
  };
}

/** 원본 파편 생성 */
function makeSource(overrides = {}) {
  return {
    id      : overrides.id ?? "src-1",
    content : "cpu 성능 저하 분석",
    type    : "error",
    keywords: ["cpu", "성능"],
    workspace_id: overrides.workspace_id ?? null,
    case_id     : overrides.case_id      ?? null,
    session_id  : overrides.session_id   ?? null,
    created_at  : overrides.created_at   ?? new Date().toISOString(),
    ...overrides,
  };
}

/* ──────────────────────────────────────────────────────────────
   원본 config 백업 및 복원 헬퍼
────────────────────────────────────────────────────────────── */

/** MEMORY_CONFIG.proactiveRecall 을 일시적으로 재정의한다 */
function withMode(mode, extra = {}) {
  const orig = { ...MEMORY_CONFIG.proactiveRecall };
  Object.assign(MEMORY_CONFIG.proactiveRecall, { mode, ...extra });
  return () => { Object.assign(MEMORY_CONFIG.proactiveRecall, orig); };
}

/* ──────────────────────────────────────────────────────────────
   시나리오 1: mode="off" — 자동 링크 0건
────────────────────────────────────────────────────────────── */
describe("ProactiveRecall gate — mode=off", () => {
  it("mode=off이면 related 링크를 생성하지 않는다", async () => {
    const restore = withMode("off");
    try {
      const candidate = makeCandidate();
      const deps      = makeMockDeps({ candidates: [candidate] });
      const processor = new RememberPostProcessor(deps);

      await runAndWait(processor, makeSource(), { agentId: "agent", keyId: null });

      assert.equal(deps.store.createLink.mock.calls.length, 0,
        "mode=off일 때 createLink가 호출되면 안 된다");
    } finally {
      restore();
    }
  });
});

/* ──────────────────────────────────────────────────────────────
   시나리오 2: mode="auto" + 동일 workspace + 동일 caseId + 50% 매치 → 1건
────────────────────────────────────────────────────────────── */
describe("ProactiveRecall gate — mode=auto, 동일 workspace+caseId", () => {
  it("50% 이상 오버랩 + 동일 workspace + 동일 caseId이면 링크 1건 생성", async () => {
    const restore = withMode("auto", {
      requireSameWorkspace: true,
      caseIdPolicy        : "strict-or-adjacent",
    });
    try {
      const wsId      = "ws-abc";
      const caseId    = "debug-cpu-2026-05-19";
      const candidate = makeCandidate({ workspace_id: wsId, case_id: caseId });
      const source    = makeSource({ workspace_id: wsId, case_id: caseId });
      const deps      = makeMockDeps({ candidates: [candidate] });
      const processor = new RememberPostProcessor(deps);

      await runAndWait(processor, source, { agentId: "agent", keyId: null });

      const linkCall = deps.store.createLink.mock.calls.find(c =>
        c.arguments[0] === "src-1" && c.arguments[1] === "cand-1"
      );
      assert.ok(linkCall, "동일 workspace+caseId일 때 링크가 생성되어야 한다");
      assert.equal(linkCall.arguments[2], "related");
    } finally {
      restore();
    }
  });
});

/* ──────────────────────────────────────────────────────────────
   시나리오 3: mode="auto" + 다른 workspace → 0건
────────────────────────────────────────────────────────────── */
describe("ProactiveRecall gate — mode=auto, workspace 불일치", () => {
  it("requireSameWorkspace=true일 때 다른 workspace이면 링크 0건", async () => {
    const restore = withMode("auto", {
      requireSameWorkspace: true,
      caseIdPolicy        : "loose",
    });
    try {
      const candidate = makeCandidate({ workspace_id: "ws-other" });
      const source    = makeSource({ workspace_id: "ws-mine" });
      const deps      = makeMockDeps({ candidates: [candidate] });
      const processor = new RememberPostProcessor(deps);

      await runAndWait(processor, source, { agentId: "agent", keyId: null });

      assert.equal(deps.store.createLink.mock.calls.length, 0,
        "다른 workspace 파편과 자동 링크가 생성되면 안 된다");
    } finally {
      restore();
    }
  });
});

/* ──────────────────────────────────────────────────────────────
   시나리오 4: mode="auto" + 다른 caseId (둘 다 있음) → 0건
────────────────────────────────────────────────────────────── */
describe("ProactiveRecall gate — mode=auto, caseId 불일치(both-required)", () => {
  it("양쪽 모두 caseId 있고 서로 다르면 링크 0건", async () => {
    const restore = withMode("auto", {
      requireSameWorkspace: false,
      caseIdPolicy        : "strict-or-adjacent",
    });
    try {
      const candidate = makeCandidate({ case_id: "debug-other-2026-05-19" });
      const source    = makeSource({ case_id: "debug-cpu-2026-05-19" });
      const deps      = makeMockDeps({ candidates: [candidate] });
      const processor = new RememberPostProcessor(deps);

      await runAndWait(processor, source, { agentId: "agent", keyId: null });

      assert.equal(deps.store.createLink.mock.calls.length, 0,
        "caseId가 둘 다 있고 서로 다르면 링크가 생성되면 안 된다");
    } finally {
      restore();
    }
  });
});

/* ──────────────────────────────────────────────────────────────
   시나리오 5: mode="auto" + strict-or-adjacent + 한쪽 caseId null + sessionId 동일 → 1건
────────────────────────────────────────────────────────────── */
describe("ProactiveRecall gate — strict-or-adjacent, null caseId + 동일 sessionId", () => {
  it("한쪽 caseId null + sessionId 동일이면 strict-or-adjacent에서 통과", async () => {
    const restore = withMode("auto", {
      requireSameWorkspace: false,
      caseIdPolicy        : "strict-or-adjacent",
    });
    try {
      const sessId    = "sess-xyz";
      const candidate = makeCandidate({ case_id: null, session_id: sessId });
      const source    = makeSource({ case_id: "debug-cpu-2026-05-19", session_id: sessId });
      const deps      = makeMockDeps({ candidates: [candidate] });
      const processor = new RememberPostProcessor(deps);

      await runAndWait(processor, source, { agentId: "agent", keyId: null });

      const linkCall = deps.store.createLink.mock.calls.find(c =>
        c.arguments[0] === "src-1" && c.arguments[1] === "cand-1"
      );
      assert.ok(linkCall, "동일 sessionId이면 strict-or-adjacent에서 통과해야 한다");
    } finally {
      restore();
    }
  });
});

/* ──────────────────────────────────────────────────────────────
   시나리오 6: mode="auto" + strict-or-adjacent + 한쪽 null + 다른 sessionId + 24h 초과 → 0건
────────────────────────────────────────────────────────────── */
describe("ProactiveRecall gate — strict-or-adjacent, 24h 초과 + 다른 sessionId", () => {
  it("한쪽 null + 다른 sessionId + 24h 초과이면 strict-or-adjacent에서 차단", async () => {
    const restore = withMode("auto", {
      requireSameWorkspace: false,
      caseIdPolicy        : "strict-or-adjacent",
      adjacencyWindowMs   : 24 * 3600 * 1000,
    });
    try {
      // candidate는 25시간 전에 생성됨
      const oldDate   = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
      const candidate = makeCandidate({
        case_id   : null,
        session_id: "sess-old",
        created_at: oldDate,
      });
      const source = makeSource({
        case_id   : "debug-cpu-2026-05-19",
        session_id: "sess-new",
        created_at: new Date().toISOString(),
      });
      const deps      = makeMockDeps({ candidates: [candidate] });
      const processor = new RememberPostProcessor(deps);

      await runAndWait(processor, source, { agentId: "agent", keyId: null });

      assert.equal(deps.store.createLink.mock.calls.length, 0,
        "24h 초과 + 다른 세션이면 strict-or-adjacent에서 차단되어야 한다");
    } finally {
      restore();
    }
  });
});

/* ──────────────────────────────────────────────────────────────
   시나리오 7: mode="auto" + caseIdPolicy="both-required" + 한쪽 null → 0건
────────────────────────────────────────────────────────────── */
describe("ProactiveRecall gate — both-required, 한쪽 caseId null", () => {
  it("both-required일 때 한쪽 caseId null이면 차단", async () => {
    const restore = withMode("auto", {
      requireSameWorkspace: false,
      caseIdPolicy        : "both-required",
    });
    try {
      const candidate = makeCandidate({ case_id: null });
      const source    = makeSource({ case_id: "debug-cpu-2026-05-19" });
      const deps      = makeMockDeps({ candidates: [candidate] });
      const processor = new RememberPostProcessor(deps);

      await runAndWait(processor, source, { agentId: "agent", keyId: null });

      assert.equal(deps.store.createLink.mock.calls.length, 0,
        "both-required일 때 한쪽 caseId null이면 링크가 생성되면 안 된다");
    } finally {
      restore();
    }
  });
});

/* ──────────────────────────────────────────────────────────────
   시나리오 8: mode="legacy" — workspace/case 무관, 50% 매치면 통과
────────────────────────────────────────────────────────────── */
describe("ProactiveRecall gate — mode=legacy", () => {
  it("mode=legacy이면 workspace와 caseId 불일치에도 링크를 생성한다", async () => {
    const restore = withMode("legacy", {
      requireSameWorkspace: true,   // legacy에서는 이 값을 무시해야 함
      caseIdPolicy        : "both-required",
    });
    try {
      const candidate = makeCandidate({
        workspace_id: "ws-other",
        case_id     : "debug-other-2026-05-19",
      });
      const source = makeSource({
        workspace_id: "ws-mine",
        case_id     : "debug-cpu-2026-05-19",
      });
      const deps      = makeMockDeps({ candidates: [candidate] });
      const processor = new RememberPostProcessor(deps);

      await runAndWait(processor, source, { agentId: "agent", keyId: null });

      const linkCall = deps.store.createLink.mock.calls.find(c =>
        c.arguments[0] === "src-1" && c.arguments[1] === "cand-1"
      );
      assert.ok(linkCall, "mode=legacy일 때 workspace/case 불일치에도 링크가 생성되어야 한다");
    } finally {
      restore();
    }
  });
});
