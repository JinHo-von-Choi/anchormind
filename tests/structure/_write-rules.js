/**
 * 의미 쓰기 구조 검사 규칙
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * _source-scan.js가 모은 호출식과 문자열에서 fragments 의미 열 쓰기를 찾는 규칙이다.
 * 실제 저장소 파일과 시험용 합성 소스에 같은 규칙을 적용한다.
 */

export const SEMANTIC_COLUMNS = Object.freeze([
  "content", "topic", "keywords", "is_anchor", "workspace", "key_id", "context_summary", "goal", "outcome"
]);

/** fragments 표 쓰기. 스키마는 리터럴이거나 보간이다. */
const TABLE_WRITE   = /\b(INSERT\s+INTO|UPDATE)\s+(?:\$\{\}\.|[A-Za-z_]+\.)?fragments(?![\w])/i;
/** 표 이름 자체가 보간이거나 연결된 식인 쓰기. 어느 표인지 정적으로 알 수 없다. */
const DYNAMIC_TABLE = /\b(INSERT\s+INTO|UPDATE)\s+(?:\$\{\}|[A-Za-z_]+\.\$\{\}|\$\{\}\.\$\{\})(?![\w.])/i;
const SET_CLAUSE    = /\bSET\b([\s\S]*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|$)/i;
const ASSIGNMENT    = /(?:^|,)\s*(?:[a-z_]+\.)?([a-z_]+)\s*=(?!=)/gi;
const LEADING_SET   = /^\s*(?:[a-z_]+\.)?([a-z_]+)\s*=(?!=)/i;

/** UPDATE 문자열의 SET 절에서 대입되는 열 이름. SET 절이 보간이면 dynamic=true. */
function setColumns(text, matchEnd) {
  const set = SET_CLAUSE.exec(text.slice(matchEnd));
  if (!set) return { columns: [], dynamic: false };
  const columns = [...set[1].matchAll(ASSIGNMENT)].map(m => m[1].toLowerCase());
  return { columns, dynamic: /^\s*\$\{\}/.test(set[1]) };
}

/** 문자열 하나에서 fragments 쓰기를 찾는다. 의미 열을 쓰지 않으면 null. */
function sqlWrite(text) {
  const fixed   = TABLE_WRITE.exec(text);
  const dynamic = fixed ? null : DYNAMIC_TABLE.exec(text);
  const m       = fixed ?? dynamic;
  if (!m) return null;

  const table = fixed ? "fragments" : "dynamic";
  if (/INSERT/i.test(m[1])) return { kind: `${table}-insert`, columns: ["*"], dynamicSet: false };

  const { columns, dynamic: dynamicSet } = setColumns(text, m.index + m[0].length);
  const semantic = columns.filter(c => SEMANTIC_COLUMNS.includes(c));
  if (table === "dynamic" && dynamicSet) semantic.push("?");
  return { kind: `${table}-update`, columns: semantic, dynamicSet: fixed !== null && dynamicSet };
}

/**
 * 파일 하나의 의미 열 SQL 쓰기와 동적 SET 문장 유무를 찾는다.
 *
 * @param {string} file
 * @param {ReturnType<import("./_source-scan.js").scanSource>} scan
 * @param {{ dynamicSetModules: Object, dynamicSetHelpers: string[] }} opts
 */
export function findSemanticSql(file, scan, { dynamicSetModules = {}, dynamicSetHelpers = [] } = {}) {
  const writes     = [];
  let   dynamicSet = false;
  const fnOf       = (s) => s.scope.at(-1) ?? "<module>";

  for (const s of scan.strings) {
    const w = sqlWrite(s.text);
    if (!w) continue;
    dynamicSet = dynamicSet || w.dynamicSet;
    if (w.columns.length > 0) writes.push({ file, fn: fnOf(s), kind: w.kind, columns: w.columns, line: s.line });
  }

  const buildsSet = file in dynamicSetModules || scan.calls.some(c => dynamicSetHelpers.includes(c.callee));
  if (buildsSet) {
    for (const s of scan.strings) {
      const lead = LEADING_SET.exec(s.text);
      if (lead && SEMANTIC_COLUMNS.includes(lead[1].toLowerCase()) && !TABLE_WRITE.test(s.text)) {
        writes.push({ file, fn: fnOf(s), kind: "set-fragment", columns: [lead[1].toLowerCase()], line: s.line });
      }
    }
  }
  return { writes, dynamicSet };
}

/** 이름만으로 FragmentWriter 의미 메서드 수신 객체로 보는 형태 */
const RECEIVER_NAME = /(?:^|\.)(?:store|writer)$/;
/** 바인딩 출처로 FragmentWriter 의미 메서드 수신 객체로 보는 형태 */
const RECEIVER_SOURCE = /^new (?:FragmentWriter|FragmentStore)$|(?:^|\.)(?:store|writer)$/;

/**
 * 파일 하나에서 FragmentWriter 의미 메서드 호출 위치를 찾는다. 수신 객체는 이름(store, writer)이나
 * 바인딩(new FragmentWriter, new FragmentStore, a.store, a.writer를 담은 변수나 속성)으로 판정한다.
 * 기록 값의 키는 객체 리터럴이면 그 키, 변수면 같은 함수 안의 객체 리터럴 초기화와 속성 대입으로
 * 모은다. 알 수 없으면 keys는 null이다.
 *
 * @returns {Array<{file: string, fn: string, scope: string[], callee: string, method: string, keys: string[]|null, line: number}>}
 */
export function findSemanticCalls(file, scan) {
  const bound = new Set(scan.bindings.filter(b => RECEIVER_SOURCE.test(b.source)).map(b => b.name));
  const sites = [];

  for (const call of scan.calls) {
    if (!call.receiver || !["insert", "insertDetailed", "update", "create"].includes(call.method)) continue;
    const byName  = RECEIVER_NAME.test(call.receiver) && call.method !== "create";
    if (!byName && !bound.has(call.receiver)) continue;

    const payload = call.method === "update" ? call.args[1] : call.args[0];
    sites.push({
      file,
      fn    : call.scope.at(-1) ?? "<module>",
      scope : call.scope,
      callee: `${call.receiver}.${call.method}`,
      method: call.method,
      keys  : payloadKeys(payload, call.scope, scan),
      line  : call.line
    });
  }
  return sites;
}

/** 기록 값의 키 목록. 알 수 없으면 null. */
function payloadKeys(payload, scope, scan) {
  if (!payload) return null;
  if (payload.kind === "object") return payload.spreads ? null : payload.keys;
  if (payload.kind !== "identifier") return null;

  const fn      = scope.at(-1) ?? null;
  const sameFn  = (s) => (s.at(-1) ?? null) === fn;
  const inits   = scan.objectVars.filter(v => v.name === payload.name && sameFn(v.scope));
  const assigns = scan.memberAssigns.filter(a => a.object === payload.name && sameFn(a.scope));
  if (inits.length === 0 && assigns.length === 0) return null;
  return [...inits.flatMap(v => v.keys), ...assigns.map(a => a.property)];
}

/** 같은 파일에서 this.X() 또는 X()로 부르는 함수 이름 */
export function localCallee(callee) {
  const m = /^(?:this\.)?([A-Za-z_$][\w$]*)$/.exec(callee);
  return m ? m[1] : null;
}

/** 함수가 같은 파일 안의 호출을 따라 WriteGate의 check()에 닿는지 본다. */
export function reachesGateCheck(scan, fn, seen = new Set()) {
  if (seen.has(fn)) return false;
  seen.add(fn);
  const calls = scan.calls.filter(c => c.scope.includes(fn));
  if (calls.some(c => /gate(?:\(\))?\.check$/i.test(c.callee))) return true;
  return calls.some(c => {
    const local = localCallee(c.callee);
    return local !== null && reachesGateCheck(scan, local, seen);
  });
}

/** 파일 안에서 관문 함수와, 관문이 덮은 함수에서만 불리는 함수의 집합 */
export function coveredFunctions(scan, gatedFns) {
  const covered = new Set(gatedFns.filter(fn => reachesGateCheck(scan, fn)));
  const callers = new Map();
  for (const c of scan.calls) {
    const local = localCallee(c.callee);
    if (!local) continue;
    if (!callers.has(local)) callers.set(local, new Set());
    callers.get(local).add(c.scope.at(-1) ?? "<module>");
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [fn, from] of callers) {
      if (covered.has(fn)) continue;
      if ([...from].every(f => covered.has(f))) {
        covered.add(fn);
        changed = true;
      }
    }
  }
  return covered;
}

/**
 * 의미 메서드 호출 위반. 관문이 덮은 함수 안의 호출은 통과한다. 허용 목록 함수 안의 호출은
 * 기록 값에 의미 열이 보이지 않을 때만 통과한다.
 *
 * @param {string} file
 * @param {Object} scan
 * @param {{ gatedFns: string[], allowed: Object<string, string> }} opts
 * @returns {string[]}
 */
export function semanticCallViolations(file, scan, { gatedFns, allowed }) {
  const covered    = coveredFunctions(scan, gatedFns);
  const violations = [];
  for (const site of findSemanticCalls(file, scan)) {
    if (site.scope.some(s => covered.has(s))) continue;
    const semanticKeys = (site.keys ?? []).filter(k => SEMANTIC_COLUMNS.includes(k));
    const listed       = site.scope.some(s => `${file}::${s}` in allowed);
    if (listed && semanticKeys.length === 0) continue;
    const detail = semanticKeys.length > 0 ? `, 의미 열 ${semanticKeys.join(",")}` : "";
    violations.push(`${file}::${site.fn} (${site.callee}${detail}, ${site.line}행)`);
  }
  return violations;
}

/**
 * 관문 통과 표식 모듈(gateApproval.js)을 쓰는 방식의 위반. 등록 함수(approveGateValue)는 WriteGate.js만
 * 가져올 수 있다. 그 밖의 파일은 이름 있는 isGateApproved 가져오기만 허용하고, 별칭 여부와 관계없이
 * approveGateValue 가져오기, 이름공간 가져오기, 다시 내보내기, 동적 가져오기는 위반이다.
 * 동적 가져오기는 지정자를 알 수 없어도 위반으로 본다.
 *
 * @param {string} file
 * @param {Object} scan
 * @returns {string[]}
 */
export function gateApprovalImportViolations(file, scan) {
  if (file === "lib/memory/write/WriteGate.js") return [];
  return scan.importSpecs
    .filter(sp => sp.source === null || /(^|\/)gateApproval\.js$/.test(sp.source))
    .filter(sp => !(sp.kind === "named" && sp.imported === "isGateApproved"))
    .map(sp => `${file}: gateApproval.js ${sp.kind}${sp.imported ? ` ${sp.imported}` : ""}`);
}
