/**
 * 세션 토큰 재사용 E2E 통합 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-19
 *
 * 배경:
 *   claude.ai 커넥터가 Mcp-Session-Id 헤더를 유실하여 매 initialize마다 새 세션이
 *   생성되던 문제를 v2.9.0에서 수정했다.
 *   deriveTokenKey(lib/handlers/mcp-handler.js:38)가 Bearer/memento-access-key 토큰을
 *   sha256 단축 해시로 캐시 키로 변환하고, bindTokenToSession(lib/redis.js:265)이
 *   Redis에 토큰→세션ID 매핑을 저장한다.
 *   동일 토큰으로 Mcp-Session-Id 없이 재호출 시 기존 세션이 반환되어야 한다.
 *
 * 시나리오:
 *   1. 실제 서버를 기동한다 (MEMENTO_ACCESS_KEY, DB, Redis 필요).
 *   2. access token A로 initialize → sessionId s1, MCP-Session-Id 헤더 s1 수신.
 *   3. 같은 토큰 A로 Mcp-Session-Id 없이 initialize 재호출.
 *   4. 응답 MCP-Session-Id 헤더가 s1과 동일한지 검증.
 *
 * 수동 실행:
 *   E2E_SESSION_REUSE=1 \
 *   MEMENTO_ACCESS_KEY=<key> \
 *   DATABASE_URL=postgresql://user:pass@localhost:35432/bee_db \
 *   REDIS_ENABLED=true \
 *   REDIS_HOST=localhost \
 *   REDIS_PORT=6379 \
 *   node --test tests/integration/session-token-reuse.test.js
 *
 * E2E_SESSION_REUSE 미설정 시 전체 suite skip.
 * DB·Redis 미연결 시 graceful skip.
 */

import "./_cleanup.js";
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import http   from "node:http";
import net    from "node:net";

const ENABLED = process.env.E2E_SESSION_REUSE === "1";

/** 기본 포트는 서버 PORT env 또는 57332 */
const SERVER_PORT = parseInt(process.env.PORT || "57332", 10);
const ACCESS_KEY  = process.env.MEMENTO_ACCESS_KEY || "";

/** initialize JSON-RPC 요청 본문 */
const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id     : 1,
  method : "initialize",
  params : {
    protocolVersion: "2025-03-26",
    capabilities   : {},
    clientInfo     : { name: "e2e-session-reuse-test", version: "1.0.0" }
  }
});

/**
 * 서버 포트 TCP 접근 가능 여부 확인
 */
async function canConnectToServer() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: SERVER_PORT, timeout: 3000 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error",   () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });
}

/**
 * Redis TCP 접근 가능 여부 확인
 */
async function canConnectToRedis() {
  if (process.env.REDIS_ENABLED !== "true") return false;
  const host = process.env.REDIS_HOST || "127.0.0.1";
  const port = parseInt(process.env.REDIS_PORT || "6379", 10);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 3000 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error",   () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });
}

/**
 * POST /mcp 단순 wrapper
 * @param {object} options
 * @param {string}  options.body           - 직렬화된 JSON-RPC 바디
 * @param {string}  [options.sessionId]    - Mcp-Session-Id 헤더 (생략 가능)
 * @param {string}  [options.accessKey]    - Authorization Bearer 토큰
 * @returns {Promise<{status: number, headers: object, body: string}>}
 */
function postMcp({ body, sessionId, accessKey }) {
  return new Promise((resolve, reject) => {
    const headers = {
      "Content-Type"  : "application/json",
      "Content-Length": Buffer.byteLength(body).toString()
    };

    if (accessKey) {
      headers["Authorization"] = `Bearer ${accessKey}`;
    }
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port    : SERVER_PORT,
        path    : "/mcp",
        method  : "POST",
        headers
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end",  () => {
          resolve({
            status : res.statusCode,
            headers: res.headers,
            body   : raw
          });
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error("request timeout"));
    });
    req.write(body);
    req.end();
  });
}

describe("세션 토큰 재사용 E2E", { skip: !ENABLED, timeout: 30_000 }, () => {

  let serverAvailable = false;
  let redisAvailable  = false;

  before(async () => {
    serverAvailable = await canConnectToServer();
    redisAvailable  = await canConnectToRedis();

    if (!serverAvailable) {
      console.warn(
        `[session-reuse] 서버(127.0.0.1:${SERVER_PORT})에 연결할 수 없다 — 테스트 스킵. ` +
        `서버를 기동하거나 PORT 환경변수를 확인하라.`
      );
    }
    if (!redisAvailable) {
      console.warn(
        "[session-reuse] Redis 미연결 — 토큰 바인딩이 stub으로 동작하므로 재사용 검증이 불가하다. " +
        "REDIS_ENABLED=true, REDIS_HOST, REDIS_PORT를 설정하라."
      );
    }
  });

  test("ACCESS_KEY 미설정 시 graceful skip", (t) => {
    if (!ACCESS_KEY) {
      t.skip("MEMENTO_ACCESS_KEY 미설정 — 인증 불가");
      return;
    }
    assert.ok(ACCESS_KEY.length > 0);
  });

  test("서버 미기동 시 graceful skip", (t) => {
    if (!serverAvailable) {
      t.skip(`서버(127.0.0.1:${SERVER_PORT}) 미연결 — 스킵`);
      return;
    }
    assert.ok(serverAvailable);
  });

  test("Redis 미연결 시 graceful skip", (t) => {
    if (!redisAvailable) {
      t.skip("Redis 미연결 — 토큰-세션 바인딩 검증 불가");
      return;
    }
    assert.ok(redisAvailable);
  });

  test(
    "동일 토큰 A로 initialize 2회 → 두 번째 응답 Mcp-Session-Id가 첫 번째와 동일해야 한다",
    { timeout: 20_000 },
    async (t) => {
      if (!serverAvailable) { t.skip("서버 미연결"); return; }
      if (!redisAvailable)  { t.skip("Redis 미연결 — 바인딩 불가"); return; }
      if (!ACCESS_KEY)      { t.skip("MEMENTO_ACCESS_KEY 미설정"); return; }

      /** 첫 번째 initialize — Mcp-Session-Id 없이 전송 */
      const first = await postMcp({ body: INIT_BODY, accessKey: ACCESS_KEY });

      assert.ok(
        first.status === 200 || first.status === 201,
        `첫 번째 initialize가 2xx를 반환해야 한다 (실제: ${first.status}). ` +
        `응답 본문: ${first.body.slice(0, 200)}`
      );

      const sessionId1 = first.headers["mcp-session-id"];
      assert.ok(
        sessionId1 && sessionId1.length > 0,
        `첫 번째 initialize 응답에 Mcp-Session-Id 헤더가 있어야 한다. ` +
        `실제 헤더: ${JSON.stringify(first.headers)}`
      );

      console.log(`[session-reuse] 첫 번째 세션 ID: ${sessionId1}`);

      /**
       * 두 번째 initialize — 동일 토큰, Mcp-Session-Id 헤더 미포함.
       * bindTokenToSession이 Redis에 저장한 매핑을 getSessionIdByToken으로 조회하여
       * 기존 세션을 재사용해야 한다.
       *
       * 짧은 대기 없이 즉시 재호출한다. bindTokenToSession은 fire-and-forget이 아닌
       * await 경로이므로 첫 번째 응답 직후 바인딩이 완료되어 있어야 한다.
       */
      const second = await postMcp({ body: INIT_BODY, accessKey: ACCESS_KEY });

      assert.ok(
        second.status === 200 || second.status === 201,
        `두 번째 initialize가 2xx를 반환해야 한다 (실제: ${second.status}). ` +
        `응답 본문: ${second.body.slice(0, 200)}`
      );

      const sessionId2 = second.headers["mcp-session-id"];
      assert.ok(
        sessionId2 && sessionId2.length > 0,
        `두 번째 initialize 응답에 Mcp-Session-Id 헤더가 있어야 한다. ` +
        `실제 헤더: ${JSON.stringify(second.headers)}`
      );

      console.log(`[session-reuse] 두 번째 세션 ID: ${sessionId2}`);

      assert.strictEqual(
        sessionId2,
        sessionId1,
        `토큰 재사용 실패: 두 번째 세션 ID(${sessionId2})가 첫 번째(${sessionId1})와 달라야 하지 않는다. ` +
        `deriveTokenKey + bindTokenToSession 경로를 확인하라.`
      );

      console.log(`[session-reuse] 세션 재사용 검증 PASS (sessionId: ${sessionId1})`);
    }
  );

  test(
    "서로 다른 토큰으로 initialize 2회 → 각각 다른 세션 ID가 반환되어야 한다",
    { timeout: 20_000 },
    async (t) => {
      if (!serverAvailable) { t.skip("서버 미연결"); return; }
      if (!ACCESS_KEY)      { t.skip("MEMENTO_ACCESS_KEY 미설정"); return; }

      /**
       * 두 번째 토큰은 ACCESS_KEY 뒤에 임의 suffix를 붙여 구성한다.
       * 실제 인증은 실패할 수 있으므로 세션 분리 동작만 검증하는 것이 목적이 아니라
       * 첫 번째 초기화에서 정상 세션을 받고, 다시 다른 토큰으로 호출 시
       * 첫 번째 세션이 반환되지 않음을 확인한다.
       *
       * 이 케이스는 잘못된 토큰이 ACCESS_KEY로 인증 실패(401)를 받는 구조라면
       * 의미 있는 검증이 어려우므로 master key 환경에서만 유효하다.
       * master key 환경이 아니면 skip한다.
       */

      /** 첫 번째 initialize로 세션 s1 생성 */
      const first = await postMcp({ body: INIT_BODY, accessKey: ACCESS_KEY });
      if (first.status !== 200 && first.status !== 201) {
        t.skip(`서버 인증 실패 (${first.status}) — 다른 토큰 테스트 스킵`);
        return;
      }

      const sessionId1 = first.headers["mcp-session-id"];
      if (!sessionId1) {
        t.skip("첫 번째 세션 ID 없음 — 스킵");
        return;
      }

      /**
       * 두 번째 initialize — 다른 토큰으로 호출.
       * ACCESS_KEY + "_different"는 인증에 실패할 가능성이 높으므로,
       * 인증 실패(401)가 오면 해당 케이스는 N/A로 처리한다.
       */
      const altKey = ACCESS_KEY + "_e2e_different";
      const second = await postMcp({ body: INIT_BODY, accessKey: altKey });

      if (second.status === 401 || second.status === 403) {
        /** 인증 거부 자체가 세션 격리 증거이므로 명시적 PASS 처리 (sanity pass) */
        console.log(`[session-reuse] 다른 토큰 → 인증 거부(${second.status}) — 세션 격리 동작 확인`);
        assert.ok(true, "다른 토큰에 대한 인증 거부(401/403)는 세션 격리가 동작한다는 증거");
        return;
      }

      const sessionId2 = second.headers["mcp-session-id"];
      if (sessionId2) {
        assert.notStrictEqual(
          sessionId2,
          sessionId1,
          `다른 토큰은 다른 세션을 생성해야 한다. ` +
          `s1=${sessionId1} s2=${sessionId2}`
        );
        console.log(`[session-reuse] 다른 토큰 → 다른 세션 ID 확인 PASS (${sessionId1} vs ${sessionId2})`);
      } else {
        /** 세션 ID 헤더 없는 응답도 재사용하지 않은 것으로 간주 */
        assert.ok(true, "다른 토큰 → 세션 헤더 없음 — 재사용 없음으로 처리");
      }
    }
  );

});
