#!/usr/bin/env node
/**
 * 단위 시험 커버리지 하한 점검
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * lcov 파일의 줄, 분기, 함수 합계를 저장소에 커밋된 기준선과 비교한다.
 * 합계가 기준선에서 허용 폭을 뺀 값보다 낮으면 종료 코드 1로 끝난다.
 * 허용 폭은 시험 실행 순서와 병렬도에서 오는 소수점 둘째 자리 흔들림을 흡수한다.
 * --write 는 현재 값으로 기준선 파일을 다시 쓴다. 어느 지표든 기준선보다 낮아지면
 * 아무것도 쓰지 않고 실패하며, 낮추는 갱신은 --allow-decrease 를 함께 줄 때만 한다.
 * 같은 lcov 에서는 항상 같은 파일을 만든다.
 * 입력이 숫자로 읽히지 않거나(LF:abc, 음수, LH > LF), 합계가 0..100 의 유한한 수가 아니거나,
 * 기준선에 숫자가 아닌 필드가 있으면 통과시키지 않고 종료 코드 2로 끝난다.
 *
 * 사용:
 *   node scripts/check-coverage.js coverage/lcov.info
 *   node scripts/check-coverage.js coverage/lcov.info --write [--allow-decrease]
 *
 * 종료 코드: 0 통과, 1 기준선 아래, 2 실행 실패
 */

import fs                from "node:fs";
import path              from "node:path";
import { fileURLToPath } from "node:url";

const ROOT              = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH     = path.join(ROOT, "coverage-baseline.json");
const METRICS           = ["lines", "branches", "functions"];
const DEFAULT_TOLERANCE = 0.5;

/** 입력(lcov, 기준선)이 읽을 수 없는 값일 때 던진다. 호출부는 종료 코드 2로 바꾼다. */
export class CoverageInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "CoverageInputError";
  }
}

const isFiniteNumber = v => typeof v === "number" && Number.isFinite(v);

/** 0 이상의 정수 문자열만 받는다. 그 밖의 값은 읽을 수 없는 입력이다. */
function parseCount(raw, tag, file) {
  if (!/^\d+$/.test(raw)) {
    throw new CoverageInputError(`lcov ${tag}:${raw} 는 0 이상의 정수가 아니다 (${file})`);
  }
  return Number(raw);
}

/** 합계가 0..100 의 유한한 수인지 확인한다. */
function assertMetrics(values, label) {
  for (const m of METRICS) {
    const v = values[m];
    if (!isFiniteNumber(v) || v < 0 || v > 100) {
      throw new CoverageInputError(`${label} ${m} 값이 0..100 의 유한한 수가 아니다: ${String(v)}`);
    }
  }
}

/** 기준선의 지표 셋과 tolerance 가 모두 유한한 수인지 확인한다. */
function assertBaseline(baseline) {
  if (baseline === null || typeof baseline !== "object") {
    throw new CoverageInputError("기준선이 객체가 아니다");
  }
  assertMetrics(baseline, "기준선");
  if (!isFiniteNumber(baseline.tolerance) || baseline.tolerance < 0) {
    throw new CoverageInputError(`기준선 tolerance 가 0 이상의 유한한 수가 아니다: ${String(baseline.tolerance)}`);
  }
}

/**
 * lcov 본문을 파일별 [hit, found] 수치로 나눈다.
 *
 * @param {string} text
 * @returns {Array<{file: string, lines: number[], branches: number[], functions: number[]}>}
 */
export function parseLcov(text) {
  const tags    = { "LF:": ["lines", 1], "LH:": ["lines", 0], "BRF:": ["branches", 1], "BRH:": ["branches", 0], "FNF:": ["functions", 1], "FNH:": ["functions", 0] };
  const records = [];
  let   cur     = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      cur = { file: line.slice(3), lines: [0, 0], branches: [0, 0], functions: [0, 0] };
      continue;
    }
    if (!cur) continue;
    if (line === "end_of_record") {
      for (const m of METRICS) {
        if (cur[m][0] > cur[m][1]) {
          throw new CoverageInputError(`lcov ${m} 적중 ${cur[m][0]} 가 전체 ${cur[m][1]} 보다 크다 (${cur.file})`);
        }
      }
      records.push(cur);
      cur = null;
      continue;
    }
    const tag = Object.keys(tags).find(t => line.startsWith(t));
    if (tag) {
      const [metric, idx] = tags[tag];
      cur[metric][idx]    = parseCount(line.slice(tag.length), tag.slice(0, -1), cur.file);
    }
  }
  if (cur) throw new CoverageInputError(`lcov 기록이 end_of_record 없이 끝났다 (${cur.file})`);
  return records;
}

/**
 * 파일별 수치를 합해 백분율(소수 둘째 자리)을 낸다. 전체 개수가 0 인 지표는 NaN 이며 호출부가 거부한다.
 *
 * @param {ReturnType<typeof parseLcov>} records
 * @param {(file: string) => boolean} [include]
 * @returns {{lines: number, branches: number, functions: number, files: number}}
 */
export function summarize(records, include = () => true) {
  const sum   = { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
  let   files = 0;
  for (const rec of records) {
    if (!include(rec.file)) continue;
    files++;
    for (const m of METRICS) {
      sum[m][0] += rec[m][0];
      sum[m][1] += rec[m][1];
    }
  }
  const pct = ([hit, found]) => (found === 0 ? NaN : Math.round((hit / found) * 10000) / 100);
  return {
    lines    : pct(sum.lines),
    branches : pct(sum.branches),
    functions: pct(sum.functions),
    files
  };
}

/**
 * 현재 값이 기준선에서 허용 폭을 넘게 내려간 지표를 돌려준다.
 *
 * @param {{lines: number, branches: number, functions: number}} current
 * @param {{lines: number, branches: number, functions: number, tolerance: number}} baseline
 * @returns {string[]}
 * @throws {CoverageInputError} 현재 값이나 기준선이 유한한 수가 아닐 때
 */
export function findDrops(current, baseline) {
  assertMetrics(current, "현재");
  assertBaseline(baseline);
  const drops = [];
  for (const m of METRICS) {
    const floor = Math.round((baseline[m] - baseline.tolerance) * 100) / 100;
    if (current[m] < floor) {
      drops.push(`${m}: ${current[m]}% < ${floor}% (기준선 ${baseline[m]}%, 허용 폭 ${baseline.tolerance}%p)`);
    }
  }
  return drops;
}

/**
 * --write 가 기록할 기준선을 정한다. 허용 폭 없이 기준선보다 낮아지는 지표가 있고
 * allowDecrease 가 아니면 기록하지 않는다(ok=false).
 *
 * @param {{lines: number, branches: number, functions: number}} current
 * @param {{lines: number, branches: number, functions: number, tolerance?: number}|null} prev
 * @param {boolean} allowDecrease
 * @returns {{ok: boolean, next: {lines: number, branches: number, functions: number, tolerance: number}, lowered: string[]}}
 */
export function planWrite(current, prev, allowDecrease) {
  assertMetrics(current, "현재");
  if (prev) assertBaseline(prev);
  const tolerance = prev?.tolerance ?? DEFAULT_TOLERANCE;
  const next      = { lines: current.lines, branches: current.branches, functions: current.functions, tolerance };
  const lowered   = prev ? findDrops(current, { ...prev, tolerance: 0 }) : [];
  return { ok: lowered.length === 0 || allowDecrease, next, lowered };
}

/** 저장소 소스 파일만 센다(tests, node_modules 제외). lcov 의 SF 는 실행 위치 기준 상대 경로다. */
function isSourceFile(file) {
  const rel = path.relative(ROOT, path.resolve(ROOT, file));
  return !rel.startsWith("..") && !rel.startsWith(`tests${path.sep}`) && !rel.includes("node_modules");
}

/** 기준선 파일을 읽는다. 읽기나 해석에 실패하면 읽을 수 없는 입력으로 취급한다. */
function readBaseline(baselinePath) {
  try {
    return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (err) {
    throw new CoverageInputError(`기준선 ${baselinePath} 을 읽을 수 없다: ${err.message}`);
  }
}

function execute(argv, baselinePath, io) {
  const args     = argv.filter(a => !a.startsWith("--"));
  const flags    = argv.filter(a => a.startsWith("--"));
  const unknown  = flags.filter(f => f !== "--write" && f !== "--allow-decrease");
  const lcovPath = args[0];
  if (!lcovPath || unknown.length > 0 || (flags.includes("--allow-decrease") && !flags.includes("--write"))) {
    io.error("사용법: node scripts/check-coverage.js <lcov.info> [--write [--allow-decrease]]");
    return 2;
  }
  const current = summarize(parseLcov(fs.readFileSync(lcovPath, "utf8")), isSourceFile);
  if (current.files === 0) {
    io.error(`[coverage] ${lcovPath} 에 저장소 소스 파일 기록이 없다`);
    return 2;
  }
  assertMetrics(current, "현재");

  if (flags.includes("--write")) {
    const prev = fs.existsSync(baselinePath) ? readBaseline(baselinePath) : null;
    const plan = planWrite(current, prev, flags.includes("--allow-decrease"));
    if (!plan.ok) {
      io.error("[coverage] 기준선을 낮출 수 없다. 기준선은 기록하지 않았다:\n  " + plan.lowered.join("\n  "));
      io.error("[coverage] 승인된 재생성이면 --write --allow-decrease 를 쓴다.");
      return 1;
    }
    fs.writeFileSync(baselinePath, JSON.stringify(plan.next, null, 2) + "\n");
    io.log(`[coverage] 기준선 기록: ${JSON.stringify(plan.next)}`);
    return 0;
  }

  const drops = findDrops(current, readBaseline(baselinePath));
  io.log(`[coverage] 현재 lines ${current.lines}% branches ${current.branches}% functions ${current.functions}% (파일 ${current.files})`);
  if (drops.length > 0) {
    io.error("[coverage] 기준선 아래로 내려간 지표:\n  " + drops.join("\n  "));
    return 1;
  }
  return 0;
}

/**
 * 명령줄 동작 전체. 읽을 수 없는 입력은 모두 종료 코드 2로 끝난다(통과로 처리하지 않는다).
 *
 * @param {string[]} argv
 * @param {string} [baselinePath]
 * @param {{log: Function, error: Function}} [io]
 * @returns {number} 종료 코드
 */
export function runCli(argv, baselinePath = BASELINE_PATH, io = console) {
  try {
    return execute(argv, baselinePath, io);
  } catch (err) {
    io.error(err instanceof CoverageInputError ? `[coverage] 입력 오류: ${err.message}` : `[coverage] 실행 실패: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
