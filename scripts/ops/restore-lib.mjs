/**
 * 복구 훈련 순수 함수
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * restore-verify.mjs가 쓰는 판정을 모았다. 복구 대상 서버 검사는 DB 동시성 시험의
 * 실행 허용 조건(tests/db-concurrency/_guard.js)과 같은 규칙이다. 시험 디렉터리는
 * 배포 꾸러미에 들어가지 않으므로 같은 규칙을 이 모듈에 두고, 두 구현이 같은 판정을
 * 내리는지는 단위 시험이 확인한다. 데이터베이스에는 접속하지 않는다.
 */

import crypto from "node:crypto";

export const TEST_PORT     = 35433;
export const TEST_USER     = "memento";
export const TEST_PASSWORD = "memento_test";
export const LOCAL_HOSTS   = Object.freeze(["localhost", "127.0.0.1", "::1"]);

/** 복구 대상 데이터베이스 이름 접두사와 형식. 이 형식이 아니면 만들지도 지우지도 않는다. */
export const RESTORE_DB_PREFIX  = "dbl_";
export const RESTORE_DB_PATTERN = /^dbl_\d+_[0-9a-f]{8}$/;

/** 원본과 복구본 양쪽에 있어야 하는 표. */
export const REQUIRED_TABLES = Object.freeze(["fragments", "fragment_links", "fragment_versions", "api_keys"]);

/** 복구 대상 거부. 메시지에는 거부한 대상만 담고 비밀번호는 담지 않는다. */
export class RestoreRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = "RestoreRefusedError";
  }
}

/** 복구 훈련 입력이나 중간 산출물의 형식 오류. */
export class RestoreVerifyError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RestoreVerifyError";
  }
}

/**
 * 환경변수에서 복구 대상 서버 정보를 읽는다. 비어 있으면 시험 컨테이너 값이 기본이다.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{host: string, port: number, user: string, password: string}}
 */
export function resolveRestoreServer(env) {
  return {
    host    : (env.POSTGRES_HOST || "localhost").trim(),
    port    : Number(env.POSTGRES_PORT || TEST_PORT),
    user    : env.POSTGRES_USER || TEST_USER,
    password: env.POSTGRES_PASSWORD || TEST_PASSWORD
  };
}

/**
 * 서버가 일회용 시험 서버인지 확인한다. 아니면 거부 대상을 담아 던진다. 허용 서버는
 * 로컬 호스트의 시험 포트이고, 사용자와 비밀번호는 시험 컨테이너 값이어야 한다.
 * DB_LANE_SERVER_ALLOW=<host:port> 는 호스트와 포트만 정확히 한 곳 더 연다.
 *
 * @param {{host: string, port: number, user: string, password: string}} server
 * @param {Record<string, string|undefined>} [env]
 * @returns {void}
 */
export function assertRestoreTarget(server, env = {}) {
  const allow      = (env.DB_LANE_SERVER_ALLOW || "").trim();
  const hostPort   = `${server.host}:${server.port}`;
  const allowedHit = allow !== "" && allow === hostPort;

  if (!allowedHit) {
    if (!LOCAL_HOSTS.includes(server.host)) {
      throw new RestoreRefusedError(
        `복구 거부: 호스트 "${server.host}" 는 로컬이 아니다 (허용: ${LOCAL_HOSTS.join(", ")}). ` +
        `일회용 서버라면 DB_LANE_SERVER_ALLOW=${hostPort} 로 명시한다.`
      );
    }
    if (server.port !== TEST_PORT) {
      throw new RestoreRefusedError(
        `복구 거부: 포트 ${server.port} 는 시험 포트 ${TEST_PORT} 가 아니다. ` +
        `일회용 서버라면 DB_LANE_SERVER_ALLOW=${hostPort} 로 명시한다.`
      );
    }
  }
  if (server.user !== TEST_USER) {
    throw new RestoreRefusedError(`복구 거부: 사용자 "${server.user}" 는 시험 컨테이너 사용자 "${TEST_USER}" 가 아니다.`);
  }
  if (server.password !== TEST_PASSWORD) {
    throw new RestoreRefusedError(`복구 거부: 비밀번호가 시험 컨테이너 값과 다르다 (사용자 "${server.user}").`);
  }
}

/**
 * 만들거나 지우려는 데이터베이스 이름이 복구 훈련 형식인지 확인한다.
 *
 * @param {string} name
 * @returns {string} 같은 이름
 */
export function assertRestoreDatabaseName(name) {
  if (!RESTORE_DB_PATTERN.test(String(name))) {
    throw new RestoreRefusedError(`복구 거부: 데이터베이스 "${name}" 는 ${RESTORE_DB_PREFIX}<pid>_<hex8> 형식이 아니다.`);
  }
  return name;
}

/**
 * 이번 복구의 데이터베이스 이름을 만든다.
 *
 * @param {number} [pid=process.pid]
 * @param {string} [suffix] 소문자 16진수 8자리. 생략하면 무작위.
 * @returns {string}
 */
export function newRestoreDatabaseName(pid = process.pid, suffix = undefined) {
  const hex = suffix ?? crypto.randomBytes(4).toString("hex");
  return assertRestoreDatabaseName(`${RESTORE_DB_PREFIX}${pid}_${hex}`);
}

/**
 * 행 수 질의 결과 또는 백업 매니페스트를 해석하고 형식을 검사한다.
 *
 * @param {string} text JSON 문자열. 질의 결과 객체이거나 {counts: 질의 결과} 형식
 * @returns {{tables: Record<string, number>, schemaMigrationsMax: string|null, hnsw: {total: number, valid: number}}}
 */
export function parseDrillCounts(text) {
  let value;
  try {
    value = JSON.parse(String(text));
  } catch (err) {
    throw new RestoreVerifyError("행 수 목록이 JSON이 아니다", { cause: err });
  }
  const body = value && typeof value === "object" && value.counts ? value.counts : value;

  if (!body || typeof body !== "object" || !body.tables || typeof body.tables !== "object") {
    throw new RestoreVerifyError("행 수 목록에 tables 항목이 없다");
  }
  for (const [name, count] of Object.entries(body.tables)) {
    if (!Number.isInteger(count) || count < 0) {
      throw new RestoreVerifyError(`표 ${name} 의 행 수가 0 이상의 정수가 아니다`);
    }
  }
  const hnsw = body.hnsw;
  if (!hnsw || !Number.isInteger(hnsw.total) || !Number.isInteger(hnsw.valid) || hnsw.total < 0 || hnsw.valid < 0) {
    throw new RestoreVerifyError("행 수 목록에 hnsw 항목이 없거나 형식이 틀리다");
  }
  const migrations = body.schemaMigrationsMax ?? null;
  if (migrations !== null && typeof migrations !== "string") {
    throw new RestoreVerifyError("schemaMigrationsMax 가 문자열이 아니다");
  }
  return { tables: body.tables, schemaMigrationsMax: migrations, hnsw: { total: hnsw.total, valid: hnsw.valid } };
}

/**
 * 원본과 복구본의 행 수, schema_migrations 최댓값, HNSW 색인을 대조한다. 보고에는
 * 표 이름과 숫자와 파일 이름만 담긴다. 표 합집합에 대해 O(t).
 *
 * @param {ReturnType<typeof parseDrillCounts>} source
 * @param {ReturnType<typeof parseDrillCounts>} restored
 * @returns {{
 *   ok: boolean,
 *   tables: {name: string, source: number|null, restored: number|null, equal: boolean}[],
 *   missingRequired: string[],
 *   schemaMigrations: {source: string|null, restored: string|null, equal: boolean},
 *   hnsw: {source: {total: number, valid: number}, restored: {total: number, valid: number}, equal: boolean, allValid: boolean}
 * }}
 */
export function compareDrillCounts(source, restored) {
  const names  = [...new Set([...Object.keys(source.tables), ...Object.keys(restored.tables)])].sort();
  const tables = names.map((name) => {
    const src = Object.hasOwn(source.tables, name) ? source.tables[name] : null;
    const dst = Object.hasOwn(restored.tables, name) ? restored.tables[name] : null;
    return { name, source: src, restored: dst, equal: src !== null && src === dst };
  });

  const missingRequired = REQUIRED_TABLES.filter(name => !Object.hasOwn(source.tables, name) || !Object.hasOwn(restored.tables, name));

  const schemaMigrations = {
    source  : source.schemaMigrationsMax,
    restored: restored.schemaMigrationsMax,
    equal   : source.schemaMigrationsMax === restored.schemaMigrationsMax
  };

  const hnsw = {
    source  : source.hnsw,
    restored: restored.hnsw,
    equal   : source.hnsw.total === restored.hnsw.total,
    allValid: restored.hnsw.valid === restored.hnsw.total
  };

  const ok = tables.every(t => t.equal) && missingRequired.length === 0 && schemaMigrations.equal && hnsw.equal && hnsw.allValid;
  return { ok, tables, missingRequired, schemaMigrations, hnsw };
}

/**
 * sha256sum 형식 파일에서 대상 파일 이름의 해시를 꺼낸다.
 *
 * @param {string} text 체크섬 파일 내용
 * @param {string} fileName 덤프 파일 이름(디렉터리 없음)
 * @returns {string} 소문자 16진수 64자리
 */
export function parseChecksumFile(text, fileName) {
  for (const line of String(text).split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === fileName) return match[1];
  }
  throw new RestoreVerifyError(`체크섬 파일에 ${fileName} 의 해시가 없거나 형식이 틀리다`);
}

/**
 * pg_restore의 표준 오류에서 행 내용이 실릴 수 있는 줄(CONTEXT, DETAIL, Command was)을
 * 빼고, 남은 줄을 줄마다 200자로 자른다. 보고에는 이 결과만 싣는다.
 *
 * @param {string} stderr
 * @returns {string[]}
 */
export function sanitizePgErrors(stderr) {
  return String(stderr)
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "" && !/^(CONTEXT|DETAIL|HINT|Command was):?/i.test(line))
    .map(line => (line.length > 200 ? `${line.slice(0, 200)}...` : line));
}
