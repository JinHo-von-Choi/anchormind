/**
 * 요청 수신 상한과 질의 시간 상한 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-29
 *
 * 요청 수신 상한이 0이면 느린 연결이 커넥션을 무기한 점유한다. 다만 이 값은
 * 본문을 다 받는 데 걸리는 시간만 제한하고 처리 시간은 제한하지 않는다.
 * 둘은 성질이 다른 방어이므로 각각 둔다.
 *
 * 질의 시간 상한은 사용자 요청 경로에만 건다. 통합과 정리 같은 유지보수 작업이
 * 중간에 끊기면 부분 적용 상태가 남기 때문이다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readFileSync }   from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

import { DEFAULT_DB_STATEMENT_TIMEOUT_MS } from "../../lib/config.js";

const HERE   = path.dirname(fileURLToPath(import.meta.url));
const ROOT   = path.resolve(HERE, "..", "..");
const SERVER = readFileSync(path.join(ROOT, "server.js"), "utf8");
const DB     = readFileSync(path.join(ROOT, "lib", "tools", "db.js"), "utf8");

describe("요청 수신 상한", () => {
  test("기본값이 유한하다", () => {
    const m = SERVER.match(/server\.requestTimeout\s*=\s*envInt\("REQUEST_TIMEOUT_MS",\s*(\d+)/);
    assert.ok(m, "requestTimeout 설정을 찾지 못했다");
    assert.ok(Number(m[1]) > 0, "requestTimeout 기본값이 0이면 수신이 무제한이다");
  });

  test("본문 상한을 받기에 충분한 값이다", () => {
    const m = SERVER.match(/server\.requestTimeout\s*=\s*envInt\("REQUEST_TIMEOUT_MS",\s*(\d+)/);
    assert.ok(Number(m[1]) >= 30000, "2MiB 본문 수신에 여유가 없다");
  });

  test("환경 변수로 덮어쓸 수 있다", () => {
    assert.match(SERVER, /envInt\("REQUEST_TIMEOUT_MS"/);
  });
});

describe("질의 시간 상한", () => {
  test("사용자 경로에 상한을 건다", () => {
    assert.match(DB, /SET LOCAL statement_timeout/);
  });

  test("유지보수 에이전트는 상한에서 제외한다", () => {
    const block = DB.slice(DB.indexOf("const stmtTimeout"));
    const guard = DB.slice(DB.indexOf('if (safeAgent !== "system"'), DB.indexOf("const stmtTimeout"));
    assert.match(guard, /safeAgent !== "system"/);
    assert.match(guard, /safeAgent !== "admin"/);
    assert.ok(block.length > 0);
  });

  test("실측 기반 기본값이 회상 최대 소요보다 크다", () => {
    /** recall 최대 소요는 임베딩 콜드스타트 포함 약 5초다. */
    assert.ok(DEFAULT_DB_STATEMENT_TIMEOUT_MS >= 15000, `기본값 ${DEFAULT_DB_STATEMENT_TIMEOUT_MS}ms가 정상 요청을 끊을 수 있다`);
  });

  test("질의 시간 상한 기본값은 설정 모듈의 상수 하나를 읽는다", () => {
    const CONFIG = readFileSync(path.join(ROOT, "lib", "config.js"), "utf8");
    assert.match(DB, /envInt\("DB_STATEMENT_TIMEOUT_MS",\s*DEFAULT_DB_STATEMENT_TIMEOUT_MS/);
    assert.match(CONFIG, /envInt\("DB_STATEMENT_TIMEOUT_MS",\s*DEFAULT_DB_STATEMENT_TIMEOUT_MS/);
    assert.doesNotMatch(DB, /DB_STATEMENT_TIMEOUT_MS",\s*\d/);
    assert.doesNotMatch(CONFIG, /DB_STATEMENT_TIMEOUT_MS",\s*\d/);
  });

  test("0을 주면 상한을 걸지 않는다", () => {
    const block = DB.slice(DB.indexOf("const stmtTimeout"));
    assert.match(block.slice(0, 300), /stmtTimeout > 0/);
  });
});
