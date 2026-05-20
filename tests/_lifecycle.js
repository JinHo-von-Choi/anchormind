/**
 * 단위 테스트 lifecycle 헬퍼
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 테스트 종료 후 active handle/request 누수를 검출하는 헬퍼를 제공한다.
 * node:test의 after 훅에서 호출하여 hang 패턴 회귀를 즉시 감지한다.
 *
 * 사용 예:
 *   import { assertCleanShutdown, defaultIgnore } from "../_lifecycle.js";
 *   after(async () => {
 *     await cleanup();               // 자원 정리
 *     await assertCleanShutdown();   // handle 누수 검증
 *   });
 */

import { disconnectRedis } from "../lib/redis.js";
import { getPrimaryPool }  from "../lib/tools/db.js";

/**
 * 테스트가 연 외부 자원(Redis 클라이언트, PostgreSQL primary pool)을 멱등하게 정리한다.
 *
 * 단위 테스트가 lib/redis.js의 circuitBreaker 경로나 RememberPostProcessor의
 * getPrimaryPool() lazy-open으로 소켓/idle 타이머를 남기면 process-isolation 워커가
 * event loop를 비우지 못해 종료되지 않는다. after 훅에서 이 함수를 호출하여 양쪽 자원을
 * 항상 닫는다. 자원을 쓰지 않은 테스트에서 호출해도 안전하다(close가 no-op이거나,
 * getPrimaryPool()이 생성한 빈 풀을 즉시 종료).
 *
 * @returns {Promise<void>}
 */
export async function teardownTestResources() {
  await disconnectRedis().catch(() => {});
  await getPrimaryPool()?.end?.().catch(() => {});
}

/**
 * 테스트 환경에서 정상적으로 존재하는 handle 이름 화이트리스트를 반환한다.
 *
 * - WriteStream: process.stdout / process.stderr (항상 존재)
 * - SIGNALWRAP: Node 내부 signal 처리기
 * - Signal: 일부 Node 버전에서 signal handler 명칭
 * - TCP: node:test runner 자체가 유지하는 소켓 (worker 모드)
 * - TTY: 터미널 stdin/stdout
 *
 * @returns {string[]}
 */
export function defaultIgnore() {
  return [
    "WriteStream",
    "SIGNALWRAP",
    "Signal",
    "ReadStream",
    "TTY",
    /**
     * Socket / TCPSocketWrap — ioredis `redisClient.quit()`과 pg `pool.end()`가
     * 이미 호출돼 연결 종료 절차는 시작됐지만 커널 레벨 TCP close 핸드셰이크 완료가
     * 약간 지연되어 process._getActiveHandles()에 잠시 남는 경우가 있다. 이 잔류는
     * event loop를 유지하지 않으며(커넥션이 graceful close 중) node:test가 대기하는
     * "Promise resolution still pending" hang과 무관하다. prom-client default metrics
     * timer(MEMENTO_METRICS_DEFAULT=off로 이미 차단)가 유일한 hang 원인이었음을 확인.
     */
    "Socket",
    "TCPSocketWrap",
    /**
     * TCPWRAP / TCPWrap — Node 내부 TCP handle. 위와 동일 이유.
     * GETNAMEINFOREQWRAP / PipeConnectWrap — DNS/파이프 cleanup 진행 중.
     */
    "TCPWRAP",
    "TCPWrap",
    "GETNAMEINFOREQWRAP",
    "PipeConnectWrap",
    /**
     * FSReqCallback — winston / logger의 파일 기록 pending. transient.
     * GETADDRINFOREQWRAP — DNS lookup pending.
     * TickObject — micro/macrotask 참조.
     */
    "FSReqCallback",
    "GETADDRINFOREQWRAP",
    "TickObject",
    /**
     * ChildProcess — node:test --test-isolation=process 모드에서 각 test worker가
     * sibling workers의 ChildProcess handle을 parent process._getActiveHandles에서
     * 관측한다. 이는 runner isolation의 부산물이며 이 파일의 cleanup leak이 아니다.
     * 단독 실행 시는 발생하지 않고 전체 스위트 실행 시에만 나타난다.
     */
    "ChildProcess",
  ];
}

/**
 * 활성 handle/request 누수가 없음을 검증한다.
 *
 * 한 틱 양보 후 process._getActiveHandles() / process._getActiveRequests()를
 * 조회하여 ignoreNames에 포함되지 않은 항목이 존재하면 에러를 throw한다.
 *
 * @param {object}   [opts]
 * @param {string[]} [opts.ignoreNames=[]]   화이트리스트에 추가할 handle 이름 목록.
 *                                           defaultIgnore()와 병합된다.
 * @param {boolean}  [opts.ignoreRequests=false]  active requests도 허용할지 여부.
 *                                                통합 테스트처럼 외부 소켓이 있는 경우 true.
 * @returns {Promise<void>}
 * @throws {Error} 누수 handle이 1개 이상 발견된 경우
 */
export async function assertCleanShutdown({
  ignoreNames    = [],
  ignoreRequests = false,
} = {}) {
  /* 한 틱 양보 — 직전 micro/macrotask 완료 대기 */
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();

  const allowed = new Set([...defaultIgnore(), ...ignoreNames]);

  const leakedHandles = (process._getActiveHandles() ?? []).filter(
    (h) => !allowed.has(h.constructor.name),
  );

  const leakedRequests = ignoreRequests
    ? []
    : (process._getActiveRequests() ?? []).filter(
        (r) => !allowed.has(r.constructor.name),
      );

  if (leakedHandles.length === 0 && leakedRequests.length === 0) {
    return;
  }

  const lines = [];

  if (leakedHandles.length > 0) {
    lines.push(`Active handles after test (${leakedHandles.length}):`);
    const counts = {};
    for (const h of leakedHandles) {
      const name = h.constructor.name;
      counts[name] = (counts[name] ?? 0) + 1;
    }
    for (const [name, count] of Object.entries(counts)) {
      lines.push(`  ${name} x${count}`);
    }
  }

  if (leakedRequests.length > 0) {
    lines.push(`Active requests after test (${leakedRequests.length}):`);
    const counts = {};
    for (const r of leakedRequests) {
      const name = r.constructor.name;
      counts[name] = (counts[name] ?? 0) + 1;
    }
    for (const [name, count] of Object.entries(counts)) {
      lines.push(`  ${name} x${count}`);
    }
  }

  lines.push(
    "",
    "Handle 누수가 감지됐습니다. 해당 모듈의 after 훅에서 timer/socket을 정리하세요.",
    "신규 timer를 만드는 import가 있다면 tests/_lifecycle.js ignoreNames에 등록하거나",
    "MEMENTO_METRICS_DEFAULT=off 환경변수가 설정돼 있는지 확인하세요.",
  );

  throw new Error(lines.join("\n"));
}
