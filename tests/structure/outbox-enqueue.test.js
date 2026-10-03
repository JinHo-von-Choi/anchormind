/**
 * outbox 기록 경로 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * outbox_events는 정해진 두 모듈만 쓴다. 생산자는 lib/outbox/Outbox.js의 enqueue(client, event)를
 * 트랜잭션 연결로 부른다. 소스를 정적으로 읽어 세 가지를 본다.
 *
 *   1. outbox_events에 INSERT하는 SQL 문자열은 lib/outbox/Outbox.js에만 있다.
 *   2. outbox_events를 UPDATE, DELETE하는 SQL 문자열은 lib/outbox/OutboxStore.js에만 있다.
 *   3. lib, scripts, bin에서 enqueue를 부르는 곳은 첫 인자로 연결 변수(식별자) 또는 `<식별자>.client`를
 *      넘기고, 식별자 이름이 풀(pool)을 가리키지 않는다. 풀 호출식(getPrimaryPool() 등), this 속성,
 *      client가 아닌 속성 접근을 넘기면 위반이다.
 *      업무 변경 없는 독립 기록은 enqueueStandalone(pool, event)를 쓴다.
 *
 * 정적 검사가 놓치는 자동 커밋 연결은 enqueue의 실행 시 확인(트랜잭션 밖이면 0행, 오류)이 막는다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import path             from "node:path";

import { listSourceFiles, scanFile, scanSource } from "./_source-scan.js";

const OUTBOX_MODULE = "lib/outbox/Outbox.js";
const STORE_MODULE  = "lib/outbox/OutboxStore.js";
const SOURCES       = [...listSourceFiles("lib"), ...listSourceFiles("scripts"), ...listSourceFiles("bin")];
const SCANS         = new Map(SOURCES.map(file => [file, scanFile(file)]));

const WRITE_PATTERNS = Object.freeze({
  insert: /INSERT\s+INTO\s+(?:\$\{\}\.|agent_memory\.|"?agent_memory"?\.)?"?outbox_events"?/i,
  change: /(?:UPDATE|DELETE\s+FROM)\s+(?:\$\{\}\.|agent_memory\.|"?agent_memory"?\.)?"?outbox_events"?/i
});

/**
 * 파일의 import 경로가 lib/outbox/Outbox.js를 가리키는지 본다.
 *
 * @param {string} file   저장소 기준 상대 경로
 * @param {string} source import 경로
 * @returns {boolean}
 */
function pointsToOutbox(file, source) {
  if (typeof source !== "string" || !source.startsWith(".")) return false;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), source)) === OUTBOX_MODULE;
}

/**
 * 스캔 결과에서 enqueue를 부르는 callee 이름 집합을 만든다(지정자 이름, 별칭, 이름공간 접근).
 *
 * @param {string} file
 * @param {ReturnType<typeof scanSource>} scan
 * @returns {Set<string>}
 */
function enqueueCallees(file, scan) {
  const names = new Set();
  for (const spec of scan.importSpecs.filter(s => pointsToOutbox(file, s.source))) {
    if (spec.kind === "named" && spec.imported === "enqueue") names.add(spec.local);
    if (spec.kind === "namespace" && spec.local) names.add(`${spec.local}.enqueue`);
  }
  return names;
}

/**
 * 연결 인자로 받는 형태: 이름이 pool을 담지 않는 식별자, 또는 그런 식별자의 client 속성.
 *
 * @param {{ kind: string, name?: string, object?: string, property?: string }|undefined} arg
 * @returns {boolean}
 */
function isConnectionArgument(arg) {
  if (arg?.kind === "identifier") return !/pool/i.test(arg.name);
  if (arg?.kind === "member")     return arg.property === "client" && !/pool/i.test(arg.object);
  return false;
}

/**
 * 위반 메시지용 인자 표기.
 *
 * @param {{ kind: string, name?: string, object?: string, property?: string }|undefined} arg
 * @returns {string}
 */
function describeConnection(arg) {
  if (arg?.kind === "identifier") return arg.name;
  if (arg?.kind === "member")     return `${arg.object}.${arg.property}`;
  return "<식>";
}

/**
 * enqueue 호출의 첫 인자 위반 목록.
 *
 * @param {string} file
 * @param {ReturnType<typeof scanSource>} scan
 * @returns {string[]}
 */
export function enqueueArgumentViolations(file, scan) {
  const callees = enqueueCallees(file, scan);
  return scan.calls
    .filter(call => callees.has(call.callee))
    .filter(call => !isConnectionArgument(call.args[0]))
    .map(call => `${file}:${call.line} ${call.callee}(${describeConnection(call.args[0])}, ...)`);
}

/**
 * 패턴과 맞는 SQL 문자열이 있는 파일 목록.
 *
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function filesWithSql(pattern) {
  return SOURCES.filter(file => SCANS.get(file).strings.some(s => pattern.test(s.text)));
}

describe("outbox_events 쓰기 위치", () => {
  it("INSERT 문은 lib/outbox/Outbox.js에만 있다", () => {
    assert.deepEqual(filesWithSql(WRITE_PATTERNS.insert), [OUTBOX_MODULE]);
  });

  it("UPDATE와 DELETE 문은 lib/outbox/OutboxStore.js에만 있다", () => {
    assert.deepEqual(filesWithSql(WRITE_PATTERNS.change), [STORE_MODULE]);
  });
});

describe("enqueue 호출의 연결 인자", () => {
  it("lib, scripts, bin의 enqueue 호출은 풀이 아닌 연결 변수를 넘긴다", () => {
    const violations = SOURCES.flatMap(file => enqueueArgumentViolations(file, SCANS.get(file)));
    assert.deepEqual(violations, []);
  });

  it("검사는 풀 호출식, 풀 이름 변수, client가 아닌 속성, this 속성을 위반으로 찾고 연결 변수와 client 속성은 통과시킨다", () => {
    const file   = "lib/example/Producer.js";
    const source = `
      import { enqueue, enqueueStandalone } from "../outbox/Outbox.js";
      import * as Outbox from "../outbox/Outbox.js";
      import { enqueue as put } from "../outbox/Outbox.js";
      async function bad(pool, ctx) {
        await enqueue(getPrimaryPool(), {});
        await enqueue(pool, {});
        await Outbox.enqueue(ctx.pool, {});
        await put(primaryPool, {});
        await enqueue(this.client, {});
        await enqueue(poolCtx.client, {});
      }
      async function good(client, pool, ctx) {
        await enqueue(client, {});
        await Outbox.enqueue(txClient, {});
        await put(ctx.client, {});
        await enqueueStandalone(pool, {});
      }`;
    const found = enqueueArgumentViolations(file, scanSource(source));
    assert.equal(found.length, 6, found.join("\n"));
    assert.ok(found.every(v => /:(6|7|8|9|10|11) /.test(v)), found.join("\n"));
  });
});
