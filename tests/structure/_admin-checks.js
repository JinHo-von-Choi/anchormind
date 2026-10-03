/**
 * 관리 모듈 구조 검사 도우미
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 관리 모듈 소스(문자열)를 받아 두 가지를 판정한다. 실제 파일과 시험용으로 고친 소스 모두에 쓴다.
 *   routePairs        처리기 소스에서 (HTTP 메서드, 대표 경로) 쌍을 읽는다. 메서드는 같은 줄의 비교, 경로를
 *                     담은 match 변수에서 이어진 변수를 쓰는 메서드 비교, 앞선 `req.method !== "M"` 가드 순으로 정한다.
 *   scopeViolations   기억 표 SQL에 범위 술어가 붙었는지, scopedQuery 조립 함수가 술어를 버리지 않는지,
 *                     관리 모듈 밖의 기억 경로 호출이 전체 범위 가드(requireFullScope) 뒤에 있는지 본다.
 */

import { scanSource } from "./_source-scan.js";

export const SAMPLE = "6f1c0f7e-2222-4000-8000-000000000003";

/** 처리기가 접두를 뺀 하위 경로로 비교하는 모듈 */
const SUB_PATH_PREFIX = Object.freeze({ "admin-memory": "/memory" });

/** 라우트가 아니라 접두로만 쓰는 경로(모듈별) */
const PREFIX_ONLY = Object.freeze({ "admin-routes": ["/assets/"] });

const ADMIN_BASE_RE = "\\\\/v1\\\\/internal\\\\/model\\\\/nothing";

/** 정규식 원문을 대표 경로들로 바꾼다. 선택 그룹 (\/x)?는 있는 경우와 없는 경우 둘을 만든다. */
function samplesFromRegexSource(source) {
  const body     = source.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/");
  const optional = /\((\/[a-z-]+)\)\?/;
  const variants = optional.test(body) ? [body.replace(optional, "$1"), body.replace(optional, "")] : [body];
  return variants.map((v) => v.replace(/\(\[\^\/\]\+\)|\(\[0-9a-f-\]\{36\}\)/g, SAMPLE));
}

/** const NAME = `${BASE}/x` 형태의 경로 상수 */
function pathConstants(lines) {
  const consts = new Map([["ADMIN_BASE", ""]]);
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?const\s+([A-Z_]+)\s*=\s*`\$\{([A-Z_]+)\}([^`]*)`/.exec(line);
    if (m && consts.has(m[2])) consts.set(m[1], consts.get(m[2]) + m[3]);
  }
  return consts;
}

/** 한 줄의 경로 토큰. 토큰마다 대표 경로 변형 목록 */
function pathTokens(line, consts, prefix) {
  if (/^\s*(?:export\s+)?const\s+[A-Z_]+\s*=\s*`/.test(line)) return [];
  const tokens = [];
  for (const m of line.matchAll(/(startsWith\(\s*)?`(\^?)\$\{([A-Z_]+)\}([^`]*)`/g)) {
    if (m[1] || !consts.has(m[3])) continue;
    const path = consts.get(m[3]) + m[4];
    tokens.push(m[2] ? samplesFromRegexSource(path) : [path]);
  }
  for (const m of line.matchAll(/(?:===|!==)\s*([A-Z_]+)\b/g)) {
    if (consts.has(m[1]) && m[1] !== "ADMIN_BASE") tokens.push([consts.get(m[1])]);
  }
  for (const m of line.matchAll(new RegExp(`/\\^${ADMIN_BASE_RE}(\\\\/[^\\s]*?)\\$/`, "g"))) tokens.push(samplesFromRegexSource(m[1]));
  if (prefix) {
    for (const m of line.matchAll(/\.match\(\/\^(\\\/[a-z][^\s]*?)\$\//g)) tokens.push(samplesFromRegexSource(m[1]).map((s) => prefix + s));
    for (const m of line.matchAll(/subPath\s*===\s*"(\/[^"]*)"/g)) tokens.push([prefix + m[1]]);
    for (const m of line.matchAll(/subPath\.startsWith\(\s*"(\/[^"]*\/)"\s*\)/g)) tokens.push([prefix + m[1] + SAMPLE]);
  }
  for (const m of line.matchAll(/url\.pathname\.endsWith\(\s*"(\/[^"]*)"\s*\)/g)) tokens.push([m[1]]);
  return tokens;
}

/** match 변수와 거기서 이어진 변수를 쓰는 메서드 비교의 메서드 목록 */
function methodsFromMatchVariable(lines, start, end, variable) {
  const closure = new Set([variable]);
  for (let i = start + 1; i < end; i++) {
    const m = /^\s*const\s+(\w+)\s*=/.exec(lines[i]);
    if (m && [...closure].some((v) => new RegExp(`\\b${v}\\b`).test(lines[i]))) closure.add(m[1]);
  }
  const methods = new Set();
  for (let i = start + 1; i < end; i++) {
    if (![...closure].some((v) => new RegExp(`\\b${v}\\b`).test(lines[i]))) continue;
    for (const m of lines[i].matchAll(/req\.method\s*===\s*"([A-Z]+)"/g)) methods.add(m[1]);
  }
  return [...methods];
}

/**
 * 처리기 소스에서 (메서드, 대표 경로 변형) 토큰을 읽는다.
 *
 * @param {string} module
 * @param {string} source
 * @returns {{ tokens: Array<{ methods: string[], variants: string[], line: number }>, unknown: Array<{ variants: string[], line: number }> }}
 */
export function routePairs(module, source) {
  const lines  = source.replace(/\.match\(\s*\n\s*/g, ".match(").split("\n");
  const consts = pathConstants(lines);
  const prefix = SUB_PATH_PREFIX[module] ?? "";
  const skip   = new Set(PREFIX_ONLY[module] ?? []);
  const starts = lines.map((l, i) => (/^(?:export\s+)?(?:async\s+)?function\s/.test(l) ? i : -1)).filter((i) => i >= 0);
  const fnEnd  = (i) => starts.find((s) => s > i) ?? lines.length;
  const tokens = [];
  const unknown = [];
  let guard = null;
  lines.forEach((line, i) => {
    if (starts.includes(i)) guard = null;
    const found  = pathTokens(line, consts, prefix).map((v) => v.filter((p) => !skip.has(p))).filter((v) => v.length > 0);
    const same   = [...line.matchAll(/(?:req\.method\s*(?:===|!==)\s*|method:\s*)"([A-Z]+)"/g)].map((m) => m[1]);
    const matchV = /const\s+(\w+)\s*=\s*(?:url\.pathname|subPath)\.match\(/.exec(line)?.[1] ?? null;
    for (const variants of found) {
      let methods = same.length > 0 ? [same[0]] : [];
      if (methods.length === 0 && matchV) methods = methodsFromMatchVariable(lines, i, fnEnd(i), matchV);
      if (methods.length === 0 && guard) methods = [guard];
      if (methods.length === 0) unknown.push({ variants, line: i + 1 });
      else tokens.push({ methods, variants, line: i + 1 });
    }
    const negative = /req\.method\s*!==\s*"([A-Z]+)"/.exec(line);
    if (negative) guard = negative[1];
  });
  return { tokens, unknown };
}

/**
 * 소스의 라우트 토큰 가운데 같은 모듈, 같은 메서드의 표 항목이 없는 것.
 *
 * @param {string} module
 * @param {string} source
 * @param {Array<{ module: string, method: string, path: string }>} routes
 * @param {(path: string) => RegExp} compile
 * @returns {string[]}
 */
export function uncoveredRoutes(module, source, routes, compile) {
  const entries = routes.filter((r) => r.module === module).map((r) => ({ method: r.method, re: compile(r.path) }));
  const { tokens, unknown } = routePairs(module, source);
  const out = unknown.map((u) => `line ${u.line}: 메서드를 정할 수 없는 경로 ${u.variants[0]}`);
  for (const t of tokens) {
    for (const method of t.methods) {
      if (!t.variants.some((v) => entries.some((e) => e.method === method && e.re.test(v)))) {
        out.push(`line ${t.line}: ${method} ${t.variants[0]}`);
      }
    }
  }
  return out;
}

/** 관리 판정 범위를 걸어야 하는 표 */
export const SCOPED_TABLES = Object.freeze([
  "fragments", "fragment_links", "fragment_versions", "case_events", "case_event_edges", "fragment_claims",
  "fragment_evidence", "fragment_synthetic_query", "tool_feedback", "search_events", "idempotency_records",
  "memory_review_decisions"
]);

const TABLE_PATTERN   = new RegExp(`\\$\\{\\}\\.(${SCOPED_TABLES.join("|")})\\b`);
const PREDICATE_CALLS = new Set(["scopePredicate", "scopedQuery", "linkScopePredicate"]);
const GATE_CALL       = "requireFullScope";

/**
 * 관리 모듈 밖에서 가져와도 기억 표를 읽거나 쓰지 않는 모듈(가져온 이름 단위 제한이 있으면 그 이름만).
 * 로그, 지표 레지스트리, 본문 판독, SQL 조각 문자열, 풀 획득(질의 문자열은 이 검사의 SQL 규칙이 본다), 세션 표(기억 표 아님),
 * 감사 표(관리 감사, 전역 라우트), 설정과 Redis 연결, 내보내기 형식 협상과 가져오기 줄 판독이다.
 * 이 목록 밖의 가져오기는 기억 경로로 보고 전체 범위 가드를 요구한다.
 */
export const NON_DATA_IMPORTS = Object.freeze({
  "../logger.js"                        : null,
  "../utils.js"                         : null,
  "../config.js"                        : null,
  "../env-parse.js"                     : null,
  "../metrics.js"                       : null,
  "../auth.js"                          : null,
  "../logging/audit.js"                 : null,
  "../logging/audit-outbox.js"          : null,
  "../logging/audit-event.js"           : null,
  "../logging/AuditStore.js"            : null,
  "../memory/keyScope.js"               : null,
  "../memory/WorkingMemorySql.js"       : ["NOT_WM_ROW", "notWorkingMemoryRow"],
  "../memory/read/DeterministicRanking.js": null,
  "../memory/schema.js"                 : null,
  "../memory/ModeRegistry.js"           : null,
  "../memory/transfer/exportFormat.js"  : null,
  "../memory/transfer/importRecords.js" : null,
  "../memory/transfer/importErrors.js"  : null,
  "../memory/transfer/ImportReport.js"  : null,
  "../tools/db.js"                      : ["getPrimaryPool", "getPoolStats"],
  "../tools/pool-gate.js"               : null,
  "../http/helpers.js"                  : null,
  "../sessions.js"                      : null,
  "../scheduler-registry.js"            : null,
  "../scheduler.js"                     : ["getLastConsolidation"],
  "../redis.js"                         : null,
  "../../config/switches.js"            : null,
  "../../config/memory.js"              : null
});

/** 가져오기가 기억 경로인지 본다. */
function isDataImport(spec) {
  if (spec.source.startsWith("./") || spec.source.startsWith("node:")) return false;
  if (!Object.hasOwn(NON_DATA_IMPORTS, spec.source)) return true;
  const only = NON_DATA_IMPORTS[spec.source];
  return Array.isArray(only) && spec.kind !== "dynamic" && !only.includes(spec.imported);
}

/** scopedQuery 조립 함수가 받은 술어를 문자열에 넣는지 본다. */
function droppedBuilders(source) {
  const out = [];
  const calls = (source.match(/\bscopedQuery\(/g) ?? []).length - (/import[^;]*\bscopedQuery\b/.test(source) ? 1 : 0);
  let seen = 0;
  for (const m of source.matchAll(/\bscopedQuery\(\s*[^,()]+,\s*[^,()]+(?:\([^()]*\))?,\s*\((\w+)\)\s*=>\s*`((?:[^`\\]|\\.)*)`/g)) {
    seen += 1;
    if (!m[2].includes(`\${${m[1]}}`)) out.push(`scopedQuery 조립 함수가 술어 ${m[1]}를 쓰지 않는다: ${m[2].slice(0, 60).replace(/\s+/g, " ")}`);
  }
  if (seen < calls) out.push(`형식을 읽을 수 없는 scopedQuery 호출 ${calls - seen}건(조립 함수는 (ws) => \`...\` 형태로 쓴다)`);
  return out;
}

/**
 * 관리 모듈 소스의 범위 규칙 위반 목록.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function scopeViolations(source) {
  const scan  = scanSource(source);
  const out   = [];
  const calls = scan.calls;
  const preds = calls.filter((c) => PREDICATE_CALLS.has(c.callee));

  for (const s of scan.strings.filter((x) => TABLE_PATTERN.test(x.text))) {
    const end = s.line + (s.text.match(/\n/g) ?? []).length;
    if (!preds.some((c) => c.line >= s.line - 1 && c.line <= end)) out.push(`line ${s.line}: 범위 술어 없는 기억 표 SQL ${s.text.slice(0, 50).replace(/\s+/g, " ")}`);
  }
  out.push(...droppedBuilders(source));
  for (const s of scan.strings) {
    if (/workspace\s*=\s*ANY\s*\(/i.test(s.text)) out.push(`line ${s.line}: 손으로 쓴 workspace 범위 조건`);
  }

  const dataLocals  = new Set(scan.importSpecs.filter((sp) => sp.kind !== "dynamic" && isDataImport(sp)).map((sp) => sp.local));
  const dynSources  = new Set(scan.importSpecs.filter((sp) => sp.kind === "dynamic" && isDataImport(sp)).map((sp) => sp.source));
  const sites       = [
    ...calls.filter((c) => dataLocals.has(c.callee) || dataLocals.has(c.receiver)).map((c) => ({ scope: c.scope, line: c.line, what: c.callee })),
    ...scan.strings.filter((s) => dynSources.has(s.text)).map((s) => ({ scope: s.scope, line: s.line, what: `import(${s.text})` }))
  ];
  const gated   = new Set(calls.filter((c) => c.callee === GATE_CALL).map((c) => c.scope.at(-1)));
  const callers = (fn) => calls.filter((c) => c.callee === fn).map((c) => c.scope.at(-1) ?? null);
  const covered = (fn, seen = new Set()) => {
    if (fn === null || fn === undefined || seen.has(fn)) return false;
    if (gated.has(fn)) return true;
    seen.add(fn);
    const from = callers(fn);
    return from.length > 0 && from.every((caller) => covered(caller, seen));
  };
  for (const site of sites) {
    const fn = site.scope.at(-1) ?? null;
    if (!covered(fn)) out.push(`line ${site.line}: 전체 범위 가드 없이 기억 경로 호출 ${site.what} (${fn ?? "모듈 최상위"})`);
  }
  return out;
}
