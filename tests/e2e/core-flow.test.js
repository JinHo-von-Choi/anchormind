/**
 * E2E Test - 핵심 경로 (remember → recall → amend → forget)
 *
 * 작성자: 최진호
 * 작성일: 2026-03-29
 *
 * MemoryManager를 통한 CRUD 전체 흐름 검증.
 * node:test 내장 모듈 사용, ES Modules.
 *
 * 실행: DATABASE_URL 또는 POSTGRES_* 환경변수 필요 (docker-compose.test.yml 35433 포트)
 *   POSTGRES_HOST=localhost POSTGRES_PORT=35433 POSTGRES_DB=memento_test \
 *   POSTGRES_USER=memento POSTGRES_PASSWORD=memento_test \
 *   node --test tests/e2e/core-flow.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import net    from "node:net";
import crypto from "node:crypto";
import pg     from "pg";

/**
 * DB 접속 가능 여부를 TCP 소켓으로 사전 검사한다.
 * 환경변수가 없거나 연결 불가 시 테스트를 스킵한다.
 */
async function canConnectToDb() {
  const host = process.env.POSTGRES_HOST || process.env.DB_HOST;
  const port = Number(process.env.POSTGRES_PORT || process.env.DB_PORT || 5432);
  if (!host) return false;
  try {
    return new Promise((resolve) => {
      const socket = net.createConnection(
        { host, port, timeout: 2000 },
        () => { socket.destroy(); resolve(true); }
      );
      socket.on("error", () => resolve(false));
      socket.on("timeout", () => { socket.destroy(); resolve(false); });
    });
  } catch { return false; }
}

const SCHEMA  = "agent_memory";
const AGENT   = `e2e-test-${crypto.randomUUID().slice(0, 8)}`;

let pool;
let mm;
let dbAvailable = false;

before(async () => {
  dbAvailable = await canConnectToDb();
  if (!dbAvailable) {
    console.warn("[e2e/core-flow] DB unreachable, skipping integration tests");
    return;
  }

  pool = new pg.Pool({
    host    : process.env.POSTGRES_HOST || process.env.DB_HOST,
    port    : Number(process.env.POSTGRES_PORT || process.env.DB_PORT || 5432),
    database: process.env.POSTGRES_DB   || process.env.DB_NAME,
    user    : process.env.POSTGRES_USER || process.env.DB_USER,
    password: process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD,
  });

  /** 스키마 + 마이그레이션 실행 (idempotent) */
  const { readFileSync } = await import("node:fs");
  const { join }         = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { dirname }      = await import("node:path");

  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = dirname(__filename);
  const schemaDir     = join(__dirname, "../../lib/memory");
  const migrationsDir = join(__dirname, "../../lib/memory/migrations");

  const sqlFiles = [
    "memory-schema.sql",
    "migration-001-temporal.sql",
    "migration-002-decay.sql",
    "migration-003-api-keys.sql",
    "migration-004-key-isolation.sql",
    "migration-005-gc-columns.sql",
    "migration-006-superseded-by-constraint.sql",
    "migration-007-link-weight.sql",
    "migration-008-morpheme-dict.sql",
    "migration-009-co-retrieved.sql",
    "migration-010-ema-activation.sql",
    "migration-011-key-groups.sql",
    "migration-012-quality-verified.sql",
    "migration-013-search-events.sql",
    "migration-014-ttl-short.sql",
    "migration-015-created-at-index.sql",
    "migration-016-agent-topic-index.sql",
    "migration-017-episodic.sql",
  ];

  for (const file of sqlFiles) {
    try {
      const dir = file.startsWith("migration-") ? migrationsDir : schemaDir;
      const sql = readFileSync(join(dir, file), "utf-8");
      await pool.query(sql);
    } catch (err) {
      /** 이미 적용된 마이그레이션은 무시 */
      if (!err.message.includes("already exists") && !err.message.includes("duplicate key")) {
        console.warn(`[e2e/core-flow] migration ${file}: ${err.message}`);
      }
    }
  }

  /** MemoryManager 인스턴스 생성 */
  const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
  mm = MemoryManager.getInstance();
});

describe("핵심 경로 E2E (remember → recall → amend → forget)", () => {
  let factId;
  let episodeId;

  test("1. remember(type=fact) - 파편 생성 및 ID 반환", async () => {
    if (!dbAvailable) return;

    const result = await mm.remember({
      content   : "E2E 테스트용 사실 파편",
      topic     : "e2e-test",
      type      : "fact",
      keywords  : ["e2e-test", "core-flow"],
      importance: 0.8,
      agentId   : AGENT,
    });

    assert.ok(result.id, "파편 ID가 반환되어야 한다");
    assert.ok(typeof result.id === "string");
    factId = result.id;
  });

  test("2. remember(type=episode) - 에피소드 파편 생성", async () => {
    if (!dbAvailable) return;

    const result = await mm.remember({
      content        : "E2E 테스트 에피소드",
      topic          : "e2e-test",
      type           : "episode",
      keywords       : ["e2e-test", "episode"],
      importance     : 0.6,
      contextSummary : "E2E 테스트 맥락",
      agentId        : AGENT,
    });

    assert.ok(result.id, "에피소드 파편 ID가 반환되어야 한다");
    episodeId = result.id;
  });

  test("3. recall(keywords=[\"e2e-test\"]) - 두 파편 모두 반환", async () => {
    if (!dbAvailable) return;

    const result = await mm.recall({
      keywords   : ["e2e-test"],
      agentId    : AGENT,
      tokenBudget: 5000,
    });

    assert.ok(result.fragments, "fragments 배열이 존재해야 한다");

    const ids = result.fragments.map(f => f.id);
    assert.ok(ids.includes(factId), "fact 파편이 recall 결과에 포함되어야 한다");
    assert.ok(ids.includes(episodeId), "episode 파편이 recall 결과에 포함되어야 한다");
  });

  test("4. amend - fact 파편 내용 수정", async () => {
    if (!dbAvailable) return;

    const result = await mm.amend({
      id      : factId,
      content : "E2E 테스트용 사실 파편 (수정됨)",
      agentId : AGENT,
    });

    assert.ok(result.updated, "수정이 성공해야 한다");
    assert.ok(result.fragment, "수정된 파편 객체가 반환되어야 한다");
    assert.strictEqual(result.fragment.content, "E2E 테스트용 사실 파편 (수정됨)");
  });

  test("5. forget(topic=\"e2e-test\") - 토픽 기반 삭제", async () => {
    if (!dbAvailable) return;

    const result = await mm.forget({
      topic   : "e2e-test",
      agentId : AGENT,
      force   : true,
    });

    assert.ok(result.deleted >= 2, `최소 2개 파편이 삭제되어야 한다 (실제: ${result.deleted})`);
  });

  test("6. recall 재검증 - 삭제 후 빈 결과", async () => {
    if (!dbAvailable) return;

    const result = await mm.recall({
      keywords   : ["e2e-test"],
      agentId    : AGENT,
      tokenBudget: 5000,
    });

    const ids = result.fragments.map(f => f.id);
    assert.ok(!ids.includes(factId), "삭제된 fact 파편이 반환되면 안 된다");
    assert.ok(!ids.includes(episodeId), "삭제된 episode 파편이 반환되면 안 된다");
  });
});

after(async () => {
  if (!dbAvailable) return;

  /** 안전망: 테스트 agent_id에 속하는 모든 파편 삭제 */
  try {
    await pool.query(`SELECT set_config('app.current_agent_id', $1, false)`, [AGENT]);
    await pool.query(`DELETE FROM ${SCHEMA}.fragments WHERE agent_id = $1`, [AGENT]);
  } catch (err) {
    console.warn(`[e2e/core-flow] cleanup failed: ${err.message}`);
  }

  try { await pool.end(); } catch { /* ignore */ }
});
