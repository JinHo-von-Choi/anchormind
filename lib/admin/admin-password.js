/**
 * 관리자 비밀번호 정책과 scrypt 해시
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 해시 문자열: $scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt base64>$<hash base64> (덧붙임 없는 base64).
 * 비용 매개변수와 salt를 행마다 문자열에 담으므로 기본값을 올려도 저장된 행은 자기 값으로 검증되고,
 * 로그인 성공 뒤 needsRehash가 참이면 새 기본값으로 다시 해시한다. 기본값: N=2^15, r=8, p=1, salt 16바이트,
 * 출력 32바이트(node 내장 crypto.scrypt).
 *
 * scrypt는 비동기(libuv 작업 스레드)로 돌리고 프로세스 전체의 동시 실행 수를 HASH_CONCURRENCY로 제한한다.
 * 대기열(HASH_QUEUE_MAX)이 차면 HashBusyError로 바로 거절한다. 없는 계정의 로그인도 verifyAgainstDummy로
 * 같은 비용의 scrypt를 한 번 돌린다(응답 시간으로 계정 유무를 구분하지 못하게).
 */

import crypto     from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const SCRYPT_PARAMS       = Object.freeze({ ln: 15, r: 8, p: 1, saltLen: 16, keyLen: 32 });
export const HASH_CONCURRENCY    = 2;
export const HASH_QUEUE_MAX      = 32;

const MAX_MEM      = 256 * 1024 * 1024;
const HASH_PATTERN = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/** 해시 문자열 형식 오류 */
export class PasswordHashFormatError extends Error {
  constructor() {
    super("비밀번호 해시 문자열 형식이 아니다");
    this.name = "PasswordHashFormatError";
  }
}

/** 동시 해시 대기열이 찼다 */
export class HashBusyError extends Error {
  constructor() {
    super("비밀번호 해시 대기열이 찼다");
    this.name = "HashBusyError";
    this.code = "hash_busy";
  }
}

/**
 * 비밀번호 정책 검사. 길이는 코드 포인트 수로 센다.
 *
 * @param {unknown} password
 * @returns {{ ok: true }|{ ok: false, reason: "not_string"|"too_short"|"too_long"|"blank"|"control_char" }}
 */
export function checkPasswordPolicy(password) {
  if (typeof password !== "string") return { ok: false, reason: "not_string" };
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return { ok: false, reason: "too_short" };
  if (length > PASSWORD_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (password.trim() === "") return { ok: false, reason: "blank" };
  if (CONTROL_CHAR.test(password)) return { ok: false, reason: "control_char" };
  return { ok: true };
}

/**
 * 동시 실행 수와 대기열 길이를 제한하는 실행기.
 *
 * @param {{ concurrency: number, queueMax: number }} options
 * @returns {{ run: <T>(job: () => Promise<T>) => Promise<T> }}
 */
export function createHashLimiter({ concurrency, queueMax }) {
  let active  = 0;
  const queue = [];
  const next  = () => {
    if (active >= concurrency || queue.length === 0) return;
    const { job, resolve, reject } = queue.shift();
    active += 1;
    Promise.resolve()
      .then(job)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return {
    run(job) {
      if (active >= concurrency && queue.length >= queueMax) return Promise.reject(new HashBusyError());
      return new Promise((resolve, reject) => {
        queue.push({ job, resolve, reject });
        next();
      });
    }
  };
}

const limiter = createHashLimiter({ concurrency: HASH_CONCURRENCY, queueMax: HASH_QUEUE_MAX });

/**
 * scrypt 한 번(제한 실행기 안에서).
 *
 * @param {string} password
 * @param {Buffer} salt
 * @param {{ ln: number, r: number, p: number, keyLen: number }} params
 * @returns {Promise<Buffer>}
 */
function derive(password, salt, { ln, r, p, keyLen }) {
  return limiter.run(() => scryptAsync(password.normalize("NFC"), salt, keyLen, { N: 2 ** ln, r, p, maxmem: MAX_MEM }));
}

/**
 * 해시 문자열을 조각으로 나눈다.
 *
 * @param {unknown} stored
 * @returns {{ ln: number, r: number, p: number, salt: Buffer, hash: Buffer }}
 */
export function parsePasswordHash(stored) {
  const m = typeof stored === "string" ? HASH_PATTERN.exec(stored) : null;
  if (!m) throw new PasswordHashFormatError();
  const [ln, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const salt = Buffer.from(m[4], "base64");
  const hash = Buffer.from(m[5], "base64");
  if (ln < 10 || ln > 20 || r < 1 || r > 32 || p < 1 || p > 16 || salt.length < 16 || hash.length < 16) {
    throw new PasswordHashFormatError();
  }
  return { ln, r, p, salt, hash };
}

/**
 * 비밀번호를 해시 문자열로 만든다.
 *
 * @param {string} password
 * @param {{ params?: typeof SCRYPT_PARAMS, salt?: Buffer }} [options]
 * @returns {Promise<string>}
 */
export async function hashPassword(password, { params = SCRYPT_PARAMS, salt = crypto.randomBytes(params.saltLen) } = {}) {
  const hash = await derive(password, salt, params);
  const b64  = (buf) => buf.toString("base64").replace(/=+$/, "");
  return `$scrypt$ln=${params.ln},r=${params.r},p=${params.p}$${b64(salt)}$${b64(hash)}`;
}

/**
 * 비밀번호를 해시 문자열과 비교한다. 저장된 매개변수를 쓰고 상수 시간으로 비교한다.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const { ln, r, p, salt, hash } = parsePasswordHash(stored);
  const derived = await derive(String(password), salt, { ln, r, p, keyLen: hash.length });
  return crypto.timingSafeEqual(derived, hash);
}

/**
 * 저장된 해시가 현재 기본 매개변수와 다른지 본다.
 *
 * @param {string} stored
 * @returns {boolean}
 */
export function needsRehash(stored) {
  const { ln, r, p, salt, hash } = parsePasswordHash(stored);
  return ln !== SCRYPT_PARAMS.ln || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p
    || salt.length !== SCRYPT_PARAMS.saltLen || hash.length !== SCRYPT_PARAMS.keyLen;
}

let dummyHash = null;

/**
 * 없는 계정의 로그인에서 같은 비용의 검증을 한 번 돌린다. 항상 false다.
 *
 * @param {string} password
 * @returns {Promise<false>}
 */
export async function verifyAgainstDummy(password) {
  dummyHash ??= hashPassword(crypto.randomBytes(18).toString("base64"));
  await verifyPassword(String(password), await dummyHash);
  return false;
}
