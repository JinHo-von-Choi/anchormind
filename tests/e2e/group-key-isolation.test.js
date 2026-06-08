/**
 * E2E Test - 그룹 키 격리 회귀
 *
 * 작성자: 최진호
 * 작성일: 2026-06-09
 *
 * 동일 그룹의 다른 key_id로 저장된 파편을 graph_explore, search_traces,
 * reconstruct_history가 정상 반환하는지 검증한다.
 *
 * 실행:
 *   DOTENV_CONFIG_PATH=.env.test REDIS_ENABLED=false \
 *   node --test --test-concurrency=1 tests/e2e/group-key-isolation.test.js
 */

import { test, before, after } from "node:test";
import assert                  from "node:assert/strict";
import { MemoryManager }       from "../../lib/memory/MemoryManager.js";
import { getPrimaryPool }      from "../../lib/tools/db.js";
import { tool_searchTraces }   from "../../lib/tools/reconstruct.js";

const KEY_A = "00000000-0000-0000-0000-00000000aaaa";
const KEY_B = "00000000-0000-0000-0000-00000000bbbb";
const KEY_C = "00000000-0000-0000-0000-00000000cccc";
const TOPIC = "keyiso-test";

let mgr, recaller, dbOk = true;

before(async () => {
  mgr      = MemoryManager.getInstance();
  recaller = mgr.recaller;
  try {
    await getPrimaryPool().query("SELECT 1");
    /** fragments 테이블 존재 여부도 확인 */
    await getPrimaryPool().query("SELECT 1 FROM agent_memory.fragments LIMIT 1");
  } catch {
    dbOk = false;
    console.warn("[e2e/group-key-isolation] DB unreachable or schema missing — all tests skipped");
  }
});

after(async () => {
  if (!dbOk) return;
  try {
    await getPrimaryPool().query(
      "UPDATE agent_memory.fragments SET valid_to = now() WHERE topic = $1 OR key_id = ANY($2::text[])",
      [TOPIC, [KEY_A, KEY_B, KEY_C]]
    );
  } catch (err) {
    console.warn("[e2e/group-key-isolation] teardown 실패:", err.message);
  }
});

/**
 * KEY 하의 error 파편 + resolved_by 링크 1건 시드. { errId } 반환
 *
 * @param {string} key
 * @returns {Promise<{ errId: string }>}
 */
async function seedRcaChainUnderKey(key) {
  const err = await mgr.remember({
    content     : "테스트 RCA 에러: 그룹 키 격리 검증용 원인 파편",
    topic       : TOPIC,
    type        : "error",
    importance  : 0.6,
    _keyId      : key,
    _groupKeyIds: [key]
  });
  const fix = await mgr.remember({
    content     : "테스트 RCA 해결: 그룹 키 격리 검증용 해결 파편",
    topic       : TOPIC,
    type        : "procedure",
    importance  : 0.6,
    _keyId      : key,
    _groupKeyIds: [key]
  });
  await mgr.link({
    fromId      : err.id,
    toId        : fix.id,
    relationType: "resolved_by",
    _keyId      : key,
    _groupKeyIds: [key]
  });
  return { errId: err.id };
}

/**
 * KEY 하의 case_id 부여 파편 1건 시드. { caseId } 반환
 *
 * @param {string} key
 * @returns {Promise<{ caseId: string }>}
 */
async function seedTraceUnderKey(key) {
  const caseId = "feat-keyiso-2026-06-09";
  await mgr.remember({
    content     : "테스트 트레이스: 그룹 키 case_id 조회 검증용 파편",
    topic       : TOPIC,
    type        : "fact",
    importance  : 0.6,
    caseId,
    _keyId      : key,
    _groupKeyIds: [key]
  });
  return { caseId };
}

/** ==================== 주요 케이스 ==================== */

test("graph_explore: 그룹 내 다른 key_id 파편의 RCA 체인 반환", async () => {
  if (!dbOk) return;
  const { errId } = await seedRcaChainUnderKey(KEY_B);
  const res = await recaller.graphExplore({
    startId     : errId,
    _keyId      : KEY_A,
    _groupKeyIds: [KEY_A, KEY_B]
  });
  assert.equal(res.error, undefined, `graphExplore 오류: ${res.error}`);
  assert.ok(res.count >= 1, "RCA 노드가 1개 이상이어야 한다");
});

test("search_traces: case_id로 그룹 내 다른 key_id 파편 조회", async () => {
  if (!dbOk) return;
  const { caseId } = await seedTraceUnderKey(KEY_B);
  const res = await tool_searchTraces({
    caseId,
    _keyId      : KEY_A,
    _groupKeyIds: [KEY_A, KEY_B]
  });
  assert.equal(res.success, true, `search_traces 실패: ${res.error}`);
  assert.ok(res.count >= 1, "case_id로 그룹 파편이 조회되어야 한다");
});

test("reconstruct_history: caseId로 그룹 내 다른 key_id 파편 타임라인 복원", async () => {
  if (!dbOk) return;
  const { caseId } = await seedTraceUnderKey(KEY_B);
  const res = await mgr.reconstructHistory({
    caseId,
    _keyId      : KEY_A,
    _groupKeyIds: [KEY_A, KEY_B]
  });
  assert.ok(res.ordered_timeline.length >= 1, "타임라인이 복원되어야 한다");
});

/** ==================== 누락 회귀 케이스 ==================== */

test("graph_explore: groupKeyIds 생략 시 자기 key_id 파편만 정상 반환", async () => {
  if (!dbOk) return;
  const { errId } = await seedRcaChainUnderKey(KEY_A);
  const res = await recaller.graphExplore({
    startId: errId,
    _keyId : KEY_A
  });
  assert.equal(res.error, undefined, `graphExplore 오류: ${res.error}`);
  assert.ok(res.count >= 1, "자기 키 파편이 조회되어야 한다");
});

test("search_traces: keyId null이면 전체 접근(빈 키 절)", async () => {
  if (!dbOk) return;
  const { caseId } = await seedTraceUnderKey(KEY_B);
  const res = await tool_searchTraces({
    caseId,
    _keyId: null
  });
  assert.equal(res.success, true, `search_traces 실패: ${res.error}`);
  assert.ok(res.count >= 1, "master(null) 키는 전체 파편을 조회해야 한다");
});

test("graph_explore: 그룹 외 key_id는 타 그룹 파편 조회 불가", async () => {
  if (!dbOk) return;
  const { errId } = await seedRcaChainUnderKey(KEY_B);
  const res = await recaller.graphExplore({
    startId     : errId,
    _keyId      : KEY_C,
    _groupKeyIds: [KEY_C]
  });
  assert.ok(
    res.error !== undefined || res.count === 0,
    "그룹 외 키가 파편을 보면 격리 누설"
  );
});
