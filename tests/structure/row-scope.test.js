/**
 * 파편 표 질의의 행 수준 보안 범위 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 *
 * agent_memory.fragments와 fragment_links의 격리 정책은 트랜잭션 설정(app.current_agent_id, app.current_key_ids)을
 * 읽는다. 설정을 걸지 않고 보낸 질의는 정책이 적용되는 접속에서 키 축을 받지 않는다. lib 아래에서 두 표를
 * 건드리는 질의를 보내는 함수마다 다음을 본다.
 *   1. 풀에 바로 질의하지 않는다. queryWithAgentVector(lib/tools/db.js)나 queryScoped(lib/tools/row-scope.js)로 보낸다.
 *   2. 트랜잭션 클라이언트로 질의하는 함수는 그 트랜잭션에 범위를 거는 지점이 SCOPED_TRANSACTIONS에 적혀 있다.
 *   3. 키 조건을 손으로 쓴 질의는 키 목록을 바인딩 배열에 적거나(키 격리 도우미, noteKeyScope), 정책이 전체 행을
 *      허용하는 주체(system, admin)로 실행한다.
 * 두 표를 건드리는 질의를 보내는 함수는 셋 중 하나다. SQL 문자열을 직접 가진 함수, 그런 SQL을 만들어 돌려주는
 * 함수(실행 호출이 없는 함수)를 부르는 함수, 다른 모듈의 대문자 SQL 상수를 질의 인자로 넘기는 함수.
 * 마지막 묶음은 규칙을 어긴 소스에서 위반이 잡히는지 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { listSourceFiles, scanFile, scanSource } from "./_source-scan.js";

/** 표 이름 상수(lib/memory/schema.js). 보간을 이 값으로 채워 읽는다. */
const TABLE_CONSTS = Object.freeze({
  T_FRAGMENTS     : "agent_memory.fragments",
  T_FRAGMENT_LINKS: "agent_memory.fragment_links"
});

/** 두 표를 읽거나 쓰는 SQL. 표 이름 앞의 스키마는 보간(${SCHEMA})이거나 리터럴이다. */
const FRAGMENT_TABLE_SQL = /(?:FROM|JOIN|UPDATE|INTO|USING)\s+(?:\$\{\}\.|agent_memory\.)?(?:fragments|fragment_links)\b/i;

/** 바인딩이나 보간 값과 비교하는 손으로 쓴 키 조건 */
const HAND_KEY_CONDITION = /\bkey_id\s*(?:=|<>|!=|IS\s+(?:NOT\s+)?DISTINCT\s+FROM)\s*(?:ANY\s*\(\s*)?\$/i;

/** 키 목록을 바인딩 배열에 적는 호출 */
const KEY_NOTE_CALL = /^(?:noteKeyScope|keyScope[A-Z]\w*|scopeClause|buildFragmentScope)$/;

/** 질의를 실행하는 호출. 이 가운데 하나도 부르지 않는 함수는 SQL을 만들어 돌려주는 함수로 본다. */
const EXECUTOR_CALL = /^(?:query|run|queryScoped|queryWithAgentVector|withTransaction)$/;

/** 다른 모듈로 내보내 질의 인자로 쓰는 SQL 상수의 이름 꼴 */
const SQL_CONST_NAME = /^[A-Z][A-Z0-9_]*$/;

/** 범위를 거는 실행기 자신은 검사하지 않는다 */
const SKIPPED_FILES = new Set(["lib/tools/db.js", "lib/tools/row-scope.js"]);

/**
 * 트랜잭션 클라이언트로 두 표를 건드리는 함수와, 그 트랜잭션에 범위를 거는 지점. 키는 "파일::함수"다.
 */
const SCOPED_TRANSACTIONS = Object.freeze({
  "lib/admin/ApiKeyStore.js::deleteApiKey"                         : "beginScoped로 admin 주체를 건다",
  "lib/admin/ReviewStore.js::applyDecision"                        : "decideReview가 트랜잭션을 열며 admin 주체를 건다",
  "lib/admin/ReviewStore.js::expireStaleReviews"                   : "applyRowScope로 system 주체를 건다",
  "lib/admin/WorkspaceAliasStore.js::mergeWorkspace"               : "beginScoped로 admin 주체를 건다",
  "lib/admin/admin-memory.js::handleConflictResolve"               : "beginScoped로 admin 주체를 건다",
  "lib/memory/CaseEventStore.js::append"                           : "applyRowScope로 이벤트를 남기는 키를 건다",
  "lib/memory/WorkingMemoryRows.js::deleteExpiredWorkingMemoryRows": "applyRowScope로 system 주체를 건다",
  "lib/memory/consolidate/ConsolidationRollback.js::undoChange"    : "rollbackCycle이 트랜잭션을 열며 system 주체를 건다",
  "lib/memory/consolidate/ConsolidationRollback.js::exists"        : "rollbackCycle이 트랜잭션을 열며 system 주체를 건다",
  "lib/memory/consolidate/SemanticDedup.js::mergeDedupPair"        : "트랜잭션 첫 문장에서 system 주체를 건다",
  "lib/memory/embedding/SegmentEmbeddingWorker.js::_persist"       : "트랜잭션 첫 문장에서 system 주체를 건다",
  "lib/memory/link/LinkStore.js::writeLinks"                       : "호출자의 에이전트를 건다. 링크 양 끝의 키 소유는 호출자가 확인한다",
  "lib/memory/link/LinkStore.js::restoreLink"                      : "가져오기(ImportRunner)가 트랜잭션을 열며 admin 주체를 건다",
  "lib/memory/link/ReconsolidationEngine.js::reconsolidate"        : "beginScoped로 system 주체를 건다",
  "lib/memory/write/BatchRememberProcessor.js::_insertChunk"       : "일괄 저장 트랜잭션이 호출자의 에이전트를 건다. 넣는 행의 key_id는 인증된 키로 고정한다",
  "lib/memory/write/FragmentWriter.js::update"                     : "호출자의 에이전트와 applyRowScope로 요청 키를 건다",
  "lib/memory/write/FragmentWriter.js::_runUpdate"                 : "update가 연 트랜잭션에서 실행한다",
  "lib/memory/write/FragmentWriter.js::findKeyOfId"                : "가져오기(ImportRunner)가 트랜잭션을 열며 admin 주체를 건다"
});

/**
 * 키 조건을 손으로 쓰고 키 목록을 넘기지 않아도 되는 위치와 사유. 키는 "파일::함수"이고 모듈 최상위 상수는 "(top)"이다.
 */
const HAND_KEY_ALLOWED = Object.freeze({
  "lib/memory/consolidate/SessionLessons.js::(top)":
    "정리 주기의 교훈 추출이 쓰는 SQL 상수다. system 주체로 실행한다"
});

/**
 * 풀이 아니라 주입받은 실행기를 .query로 부르는 위치와 사유. 키는 "파일::함수"다.
 */
const INJECTED_EXECUTORS = Object.freeze({
  "lib/memory/read/LexicalSearch.js::search":
    "this.query는 생성자가 받은 실행기이고 기본값은 queryWithAgentVector다"
});

/** 호출의 표시 이름. 메서드 호출은 메서드 이름, 그 밖에는 호출식 전체다. */
const callName = (c) => c.method ?? c.callee;
const scopeKey = (item) => item.scope.join(">");
const fnName   = (item) => item.scope.at(-1) ?? "(top)";

/** 전체 행을 허용하는 주체로 실행하는 호출인지 */
function runsAsFullSubject(call) {
  const name = callName(call);
  if (name === "queryWithAgentVector") return call.args[0]?.value === "system" || call.args[0]?.value === "admin";
  if (name === "queryScoped" || name === "applyRowScope" || name === "beginScoped") {
    return call.args.some(a => a.kind === "member" && a.object === "ROW_SUBJECT")
      || call.args.some(a => a.kind === "object" && a.keys.includes("subject"));
  }
  return false;
}

/**
 * 스캔 결과들에서 SQL을 만들어 돌려주는 함수 이름과, 두 표를 건드리는 대문자 SQL 상수 이름을 모은다.
 *
 * @param {Iterable<ReturnType<typeof scanSource>>} scans
 * @returns {{ builders: Set<string>, sqlConsts: Set<string> }}
 */
function collectSqlSources(scans) {
  const builders  = new Set();
  const sqlConsts = new Set();
  for (const scan of scans) {
    for (const s of scan.strings) {
      if (!FRAGMENT_TABLE_SQL.test(s.text) || s.scope.length === 0) continue;
      const executes = scan.calls.some(c => scopeKey(c) === scopeKey(s) && EXECUTOR_CALL.test(callName(c)));
      if (!executes) builders.add(fnName(s));
    }
    for (const [name, text] of scan.constTexts) {
      if (SQL_CONST_NAME.test(name) && FRAGMENT_TABLE_SQL.test(text)) sqlConsts.add(name);
    }
  }
  return { builders, sqlConsts };
}

/**
 * 한 파일의 위반 목록. 항목은 "파일::함수: 설명"이다.
 *
 * @param {string} file
 * @param {ReturnType<typeof scanSource>} scan
 * @param {{ builders: Set<string>, sqlConsts: Set<string> }} sources
 * @returns {string[]}
 */
function rowScopeViolations(file, scan, { builders, sqlConsts }) {
  const out    = [];
  const sqlFns = new Map();
  const mark   = (item) => {
    if (!sqlFns.has(scopeKey(item))) sqlFns.set(scopeKey(item), { name: fnName(item), handKey: false });
    return sqlFns.get(scopeKey(item));
  };
  for (const s of scan.strings) {
    if (!FRAGMENT_TABLE_SQL.test(s.text)) continue;
    if (HAND_KEY_CONDITION.test(s.text)) mark(s).handKey = true;
    else mark(s);
  }
  for (const c of scan.calls) {
    const usesBuilder = builders.has(callName(c));
    const passesConst = c.args.some(a => a.kind === "identifier" && sqlConsts.has(a.name));
    if (usesBuilder || passesConst) mark(c);
  }

  for (const [key, fn] of sqlFns) {
    const id    = `${file}::${fn.name}`;
    const calls = scan.calls.filter(c => scopeKey(c) === key);

    for (const c of calls) {
      if (c.method !== "query" || INJECTED_EXECUTORS[id]) continue;
      if (c.receiver !== "client") out.push(`${id}: ${c.receiver}.query로 풀에 바로 질의한다(${c.line}행)`);
      else if (!SCOPED_TRANSACTIONS[id]) out.push(`${id}: 트랜잭션에 범위를 거는 지점이 등록되지 않았다(${c.line}행)`);
    }

    if (!fn.handKey || HAND_KEY_ALLOWED[id]) continue;
    const notesKeys = calls.some(c => KEY_NOTE_CALL.test(callName(c)));
    if (!notesKeys && !calls.some(runsAsFullSubject)) out.push(`${id}: 손으로 쓴 키 조건의 키 목록을 넘기지 않는다`);
  }
  return out;
}

/** 서버가 기동할 때 실행하는 점검 스크립트도 런타임 접속으로 두 표를 읽는다 */
const files   = [...listSourceFiles("lib"), "scripts/check-embedding-consistency.js"].filter(f => !SKIPPED_FILES.has(f));
const scans   = new Map(files.map(f => [f, scanFile(f, TABLE_CONSTS)]));
const sources = collectSqlSources(scans.values());

describe("파편 표 질의의 행 수준 보안 범위", () => {
  it("위반이 없다", () => {
    const violations = files.flatMap(f => rowScopeViolations(f, scans.get(f), sources));
    assert.deepEqual(violations, []);
  });

  it("등록한 위치가 실제로 있다", () => {
    const present = new Set();
    for (const f of files) {
      for (const item of [...scans.get(f).strings.filter(s => FRAGMENT_TABLE_SQL.test(s.text)), ...scans.get(f).calls]) {
        present.add(`${f}::${fnName(item)}`);
      }
    }
    const listed = [...Object.keys(SCOPED_TRANSACTIONS), ...Object.keys(HAND_KEY_ALLOWED), ...Object.keys(INJECTED_EXECUTORS)];
    const stale  = listed.filter(id => !present.has(id));
    assert.deepEqual(stale, []);
  });
});

describe("범위 규칙 검사의 변형 소스 시험", () => {
  const check = (source, extra = { builders: new Set(), sqlConsts: new Set() }) => {
    const scan = scanSource(source, TABLE_CONSTS);
    const own  = collectSqlSources([scan]);
    return rowScopeViolations("lib/x.js", scan, {
      builders : new Set([...own.builders, ...extra.builders]),
      sqlConsts: new Set([...own.sqlConsts, ...extra.sqlConsts])
    });
  };

  it("풀에 바로 보내는 파편 질의가 잡힌다", () => {
    const out = check("export async function load(pool, id) { return pool.query(`SELECT id FROM ${SCHEMA}.fragments WHERE id = $1`, [id]); }");
    assert.ok(out.some(m => m.includes("풀에 바로 질의한다")), out.join("; "));
  });

  it("SQL을 만드는 함수나 SQL 상수를 거쳐 풀에 바로 보내는 질의가 잡힌다", () => {
    const built = check([
      "function hiddenSql(col) { return `NOT EXISTS (SELECT 1 FROM ${T_FRAGMENTS} rv WHERE rv.id = ${col})`; }",
      "export async function load(pool, id) { return pool.query(`SELECT 1 FROM ${SCHEMA}.case_events ce WHERE ${hiddenSql(\"ce.id\")}`, [id]); }"
    ].join("\n"));
    assert.ok(built.some(m => m.includes("load: pool.query로 풀에 바로 질의한다")), built.join("; "));

    const constant = check("export async function load(pool, id) { return pool.query(STALE_ROWS_SQL, [id]); }", { builders: new Set(), sqlConsts: new Set(["STALE_ROWS_SQL"]) });
    assert.ok(constant.some(m => m.includes("풀에 바로 질의한다")), constant.join("; "));
  });

  it("등록되지 않은 트랜잭션 클라이언트 질의가 잡힌다", () => {
    const out = check("export async function load(client, id) { return client.query(`SELECT id FROM ${SCHEMA}.fragments WHERE id = $1`, [id]); }");
    assert.ok(out.some(m => m.includes("범위를 거는 지점이 등록되지 않았다")), out.join("; "));
  });

  it("키 목록을 넘기지 않는 손으로 쓴 키 조건이 잡힌다", () => {
    const out = check("export async function load(agentId, id, keyId) { return queryWithAgentVector(agentId, `SELECT id FROM ${SCHEMA}.fragments WHERE id = $1 AND key_id = $2`, [id, keyId]); }");
    assert.ok(out.some(m => m.includes("키 목록을 넘기지 않는다")), out.join("; "));
  });

  it("키 목록을 적거나 전체 허용 주체로 실행하면 통과한다", () => {
    assert.deepEqual(check("export async function load(agentId, id, keyId) { const params = [id, keyId]; noteKeyScope(params, [keyId]); return queryWithAgentVector(agentId, `SELECT id FROM ${SCHEMA}.fragments WHERE id = $1 AND key_id = $2`, params); }"), []);
    assert.deepEqual(check("export async function load(id, keyId) { return queryWithAgentVector(\"system\", `SELECT id FROM ${SCHEMA}.fragments WHERE id = $1 AND key_id = $2`, [id, keyId]); }"), []);
    assert.deepEqual(check("export async function load(pool, id, keyId) { return queryScoped(pool, `SELECT id FROM ${SCHEMA}.fragments WHERE id = $1 AND key_id = $2`, [id, keyId], ROW_SUBJECT.ADMIN); }"), []);
  });
});
