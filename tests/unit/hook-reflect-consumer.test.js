/**
 * 훅 회고 outbox 소비자 시험(stub 의존성)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * payload 검사, 키 재확인, 멱등 선점(같은 세션과 이벤트는 한 번만 reflect), 실패 시 선점 해제,
 * reflect 인자(서사, workspace, 키 범위), 처리기 등록을 본다.
 */

import { describe, it, afterEach } from "node:test";
import assert                      from "node:assert/strict";

import {
  createHookReflectHandler, registerHookReflectConsumer, validateHookReflectPayload, buildHookReflectArgs,
  HOOK_REFLECT_IDEMPOTENCY_TOOL
} from "../../lib/hooks/hook-reflect-consumer.js";
import { OutboxPermanentError, getOutboxHandler, _resetOutboxHandlers } from "../../lib/outbox/OutboxHandlers.js";
import { HOOK_REFLECT_TOPIC, HOOK_PAYLOAD_VERSION, hookIdempotencyKey } from "../../lib/hooks/hook-contract.js";

const SID = "0b8f6c4e-1d2a-4c51-9a77-3f1e2d4c5b6a";

/** outbox 이벤트 하나 */
function outboxEvent(id, overrides = {}) {
  const payload = {
    v: HOOK_PAYLOAD_VERSION, client: "codex", event: "SessionEnd", sessionId: SID, keyId: "key-1", workspace: "proj",
    summary: "배포 스크립트의 경로 오류를 고치고 시험을 통과시켰다", ...overrides
  };
  return {
    id, topic: HOOK_REFLECT_TOPIC, attempts: 1, payload,
    aggregateId: hookIdempotencyKey({ keyId: payload.keyId, client: payload.client, sessionId: payload.sessionId, event: payload.event })
  };
}

/** idempotency_records 선점 계약을 따르는 메모리 저장소 */
function memoryClaims() {
  const rows = new Map();
  const id   = (a) => `${a.keyId ?? ""}|${a.tool}|${a.idempotencyKey}`;
  return {
    rows,
    claim   : async (a) => {
      const row = rows.get(id(a));
      if (!row) { rows.set(id(a), { state: "claimed", token: a.token }); return "claimed"; }
      return row.state === "done" ? "done" : "busy";
    },
    complete: async (a) => {
      const row = rows.get(id(a));
      if (row?.state !== "claimed" || row.token !== a.token) return false;
      rows.set(id(a), { state: "done", ...a.summary });
      return true;
    },
    release : async (a) => {
      const row = rows.get(id(a));
      if (row?.state === "claimed" && row.token === a.token) { rows.delete(id(a)); return true; }
      return false;
    }
  };
}

function makeDeps(overrides = {}) {
  const claims  = memoryClaims();
  const reflects = [];
  let   n       = 0;
  const deps    = {
    validateKey: async (keyId) => ({ valid: true, keyId, groupKeyIds: [keyId], permissions: ["read", "write"], defaultWorkspace: "dflt" }),
    claim      : claims.claim,
    complete   : claims.complete,
    release    : claims.release,
    reflect    : async (args) => { reflects.push(args); return { count: 1 }; },
    token      : () => `tok-${++n}`,
    ...overrides
  };
  return { deps, claims, reflects };
}

const run = (handler, event) => handler(event, { signal: new AbortController().signal });

afterEach(() => _resetOutboxHandlers());

describe("validateHookReflectPayload", () => {
  it("형식이 맞지 않는 payload는 재시도 없는 오류다", () => {
    const base = outboxEvent(1).payload;
    for (const change of [{ v: 2 }, { client: "cursor" }, { event: "SessionStart" }, { sessionId: "a b" }, { keyId: 3 },
      { workspace: 5 }, { summary: "" }, { summary: "x".repeat(1001) }, { summary: 3 }]) {
      assert.throws(() => validateHookReflectPayload({ ...base, ...change }), OutboxPermanentError, JSON.stringify(change).slice(0, 40));
    }
    assert.throws(() => validateHookReflectPayload(null), OutboxPermanentError);
  });
});

describe("buildHookReflectArgs", () => {
  it("요약 후보로 1000자 이하 서사를 만들고 키 범위와 workspace를 싣는다", () => {
    const payload = validateHookReflectPayload(outboxEvent(1, { summary: "단어 ".repeat(250).trim() }).payload);
    const args    = buildHookReflectArgs(payload, { keyId: "key-1", groupKeyIds: ["key-1"], defaultWorkspace: "dflt" });
    assert.ok(args.narrative_summary.startsWith("Codex SessionEnd 세션 기록: "));
    assert.ok(args.narrative_summary.length <= 1000);
    assert.equal(args.workspace, "proj");
    assert.equal(args._keyId, "key-1");
    assert.equal(args._defaultWorkspace, "dflt");
    assert.equal(args.sessionId, `codex:${SID}`);
    assert.equal(args.summary, undefined);
  });

  it("workspace가 없으면 인자에 넣지 않아 키 기본 workspace를 쓴다", () => {
    const payload = validateHookReflectPayload(outboxEvent(1, { workspace: null }).payload);
    assert.equal("workspace" in buildHookReflectArgs(payload, { keyId: "key-1" }), false);
  });
});

describe("hook.reflect 처리기", () => {
  it("같은 세션과 이벤트의 두 이벤트는 reflect를 한 번만 부른다", async () => {
    const { deps, reflects, claims } = makeDeps();
    const handler = createHookReflectHandler(deps);
    await run(handler, outboxEvent(10));
    await run(handler, outboxEvent(11));
    await run(handler, outboxEvent(10));
    assert.equal(reflects.length, 1);
    const [row] = [...claims.rows.values()];
    assert.equal(row.state, "done");
    assert.equal(row.count, 1);
    assert.ok([...claims.rows.keys()][0].includes(`|${HOOK_REFLECT_IDEMPOTENCY_TOOL}|`));
  });

  it("이벤트가 다르면 각각 reflect한다", async () => {
    const { deps, reflects } = makeDeps();
    const handler = createHookReflectHandler(deps);
    await run(handler, outboxEvent(1, { event: "Stop" }));
    await run(handler, outboxEvent(2, { event: "SessionEnd" }));
    await run(handler, outboxEvent(3, { keyId: "key-2" }));
    assert.equal(reflects.length, 3);
  });

  it("reflect가 실패하면 선점을 풀고 오류를 던져 다음 전달이 다시 수행한다", async () => {
    let fail = true;
    const { deps, reflects, claims } = makeDeps({
      reflect: async (args) => { if (fail) throw new Error("db down"); reflects.push(args); return { count: 2 }; }
    });
    const handler = createHookReflectHandler(deps);
    await assert.rejects(run(handler, outboxEvent(5)), /db down/);
    assert.equal(claims.rows.size, 0);
    fail = false;
    await run(handler, outboxEvent(5));
    assert.equal(reflects.length, 1);
  });

  it("다른 전달이 선점 중이면 재시도 가능한 오류다", async () => {
    const { deps } = makeDeps({ claim: async () => "busy" });
    await assert.rejects(run(createHookReflectHandler(deps), outboxEvent(1)), (err) => !(err instanceof OutboxPermanentError));
  });

  it("비활성 키와 write 권한이 없는 키는 재시도 없는 오류이고 reflect하지 않는다", async () => {
    for (const key of [{ valid: false, reason: "inactive" }, { valid: false }, { valid: true, keyId: "key-1", permissions: ["read"] }]) {
      const { deps, reflects } = makeDeps({ validateKey: async () => key });
      await assert.rejects(run(createHookReflectHandler(deps), outboxEvent(1)), OutboxPermanentError);
      assert.equal(reflects.length, 0);
    }
  });

  it("키 저장소 장애는 재시도 가능한 오류다", async () => {
    const { deps } = makeDeps({ validateKey: async () => ({ valid: false, reason: "store_unavailable" }) });
    await assert.rejects(run(createHookReflectHandler(deps), outboxEvent(1)), (err) => !(err instanceof OutboxPermanentError));
  });

  it("마스터 키 이벤트는 키를 조회하지 않고 수행한다", async () => {
    let looked = 0;
    const { deps, reflects } = makeDeps({ validateKey: async () => { looked++; return { valid: false }; } });
    await run(createHookReflectHandler(deps), outboxEvent(1, { keyId: null }));
    assert.equal(looked, 0);
    assert.equal(reflects[0]._keyId, null);
  });

  it("중단된 signal이면 reflect하지 않고 선점을 푼다", async () => {
    const { deps, reflects, claims } = makeDeps();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createHookReflectHandler(deps)(outboxEvent(1), { signal: controller.signal }));
    assert.equal(reflects.length, 0);
    assert.equal(claims.rows.size, 0);
  });
});

describe("registerHookReflectConsumer", () => {
  it("hook.reflect topic에 처리기를 등록하고 해제 함수를 돌려준다", () => {
    const unregister = registerHookReflectConsumer(makeDeps().deps);
    assert.equal(typeof getOutboxHandler(HOOK_REFLECT_TOPIC).handler, "function");
    unregister();
    assert.equal(getOutboxHandler(HOOK_REFLECT_TOPIC), null);
  });
});
