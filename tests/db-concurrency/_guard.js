/**
 * DB 동시성 시험의 실행 허용 조건
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 이 시험은 데이터베이스를 만들고 지운다. 그래서 대상 서버와 데이터베이스 이름을
 * 연결을 열기 전에 검사한다. DB 없이 돌 수 있도록 pg를 불러오지 않는다.
 *
 * 허용 서버: 로컬 호스트, 시험 컨테이너 포트(35433), 사용자 memento, 비밀번호
 * memento_test. 포트와 호스트는 DB_LANE_SERVER_ALLOW=<host:port> 로 정확히 한 곳만
 * 더 열 수 있다. 사용자와 비밀번호는 열 수 없다.
 */

import crypto from "node:crypto";

/** 시험이 만드는 데이터베이스 이름 접두사. 이 접두사가 아닌 DB는 지우지 않는다. */
export const LANE_DB_PREFIX  = "dbl_";
export const LANE_DB_PATTERN = /^dbl_\d+_[0-9a-f]{8}$/;

export const TEST_PORT     = 35433;
export const TEST_USER     = "memento";
export const TEST_PASSWORD = "memento_test";
export const LOCAL_HOSTS   = Object.freeze(["localhost", "127.0.0.1", "::1"]);

/** 허용 조건 위반. 메시지에는 거부한 대상만 담고 비밀번호는 담지 않는다. */
export class LaneRefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = "LaneRefusalError";
  }
}

/**
 * 환경변수에서 시험이 붙을 서버 정보를 한 곳에서 읽는다. 비어 있으면 시험
 * 컨테이너의 값이 기본이다. 이후 모든 접속(관리 연결, 마이그레이션, 앱 풀)은
 * 이 값에서 파생한다.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{host: string, port: number, user: string, password: string}}
 */
export function resolveLaneServer(env) {
  return {
    host    : (env.POSTGRES_HOST     || "localhost").trim(),
    port    : Number(env.POSTGRES_PORT || TEST_PORT),
    user    : env.POSTGRES_USER     || TEST_USER,
    password: env.POSTGRES_PASSWORD || TEST_PASSWORD
  };
}

/**
 * 서버가 시험용 일회용 서버인지 확인한다. 아니면 거부 대상을 담아 던진다.
 *
 * @param {{host: string, port: number, user: string, password: string}} server
 * @param {Record<string, string|undefined>} [env]
 * @returns {void}
 */
export function assertLaneServer(server, env = {}) {
  const allow      = (env.DB_LANE_SERVER_ALLOW || "").trim();
  const hostPort   = `${server.host}:${server.port}`;
  const allowedHit = allow !== "" && allow === hostPort;

  if (!allowedHit) {
    if (!LOCAL_HOSTS.includes(server.host)) {
      throw new LaneRefusalError(
        `DB 동시성 시험 거부: 호스트 "${server.host}" 는 로컬이 아니다 (허용: ${LOCAL_HOSTS.join(", ")}). ` +
        `일회용 서버라면 DB_LANE_SERVER_ALLOW=${hostPort} 로 명시한다.`
      );
    }
    if (server.port !== TEST_PORT) {
      throw new LaneRefusalError(
        `DB 동시성 시험 거부: 포트 ${server.port} 는 시험 포트 ${TEST_PORT} 가 아니다. ` +
        `일회용 서버라면 DB_LANE_SERVER_ALLOW=${hostPort} 로 명시한다.`
      );
    }
  }
  if (server.user !== TEST_USER) {
    throw new LaneRefusalError(
      `DB 동시성 시험 거부: 사용자 "${server.user}" 는 시험 컨테이너 사용자 "${TEST_USER}" 가 아니다.`
    );
  }
  if (server.password !== TEST_PASSWORD) {
    throw new LaneRefusalError(
      `DB 동시성 시험 거부: 비밀번호가 시험 컨테이너 값과 다르다 (사용자 "${server.user}").`
    );
  }
}

/**
 * 만들거나 지우려는 데이터베이스 이름이 이 시험의 형식인지 확인한다.
 *
 * @param {string} name
 * @returns {string} 같은 이름
 */
export function assertLaneDatabaseName(name) {
  if (!LANE_DB_PATTERN.test(String(name))) {
    throw new LaneRefusalError(
      `DB 동시성 시험 거부: 데이터베이스 "${name}" 는 ${LANE_DB_PREFIX}<pid>_<hex8> 형식이 아니다.`
    );
  }
  return name;
}

/**
 * 이번 실행의 데이터베이스 이름을 만든다.
 *
 * @param {number} [pid=process.pid]
 * @param {string} [suffix] 소문자 16진수 8자리. 생략하면 무작위.
 * @returns {string}
 */
export function newLaneDatabaseName(pid = process.pid, suffix = undefined) {
  const hex = suffix ?? crypto.randomBytes(4).toString("hex");
  return assertLaneDatabaseName(`${LANE_DB_PREFIX}${pid}_${hex}`);
}
