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

/**
 * lcov 본문을 파일별 [hit, found] 수치로 나눈다.
 *
 * @param {string} text
 * @returns {Array<{file: string, lines: number[], branches: number[], functions: number[]}>}
 */
export function parseLcov(text) {
  const records = [];
  let   cur     = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      cur = { file: line.slice(3), lines: [0, 0], branches: [0, 0], functions: [0, 0] };
    } else if (cur && line.startsWith("LF:"))  { cur.lines[1]     = Number(line.slice(3)); }
    else if (cur && line.startsWith("LH:"))    { cur.lines[0]     = Number(line.slice(3)); }
    else if (cur && line.startsWith("BRF:"))   { cur.branches[1]  = Number(line.slice(4)); }
    else if (cur && line.startsWith("BRH:"))   { cur.branches[0]  = Number(line.slice(4)); }
    else if (cur && line.startsWith("FNF:"))   { cur.functions[1] = Number(line.slice(4)); }
    else if (cur && line.startsWith("FNH:"))   { cur.functions[0] = Number(line.slice(4)); }
    else if (cur && line === "end_of_record")  { records.push(cur); cur = null; }
  }
  return records;
}

/**
 * 파일별 수치를 합해 백분율(소수 둘째 자리)을 낸다.
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
  const pct = ([hit, found]) => (found === 0 ? 100 : Math.round((hit / found) * 10000) / 100);
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
 */
export function findDrops(current, baseline) {
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

function main(argv) {
  const args     = argv.filter(a => !a.startsWith("--"));
  const flags    = argv.filter(a => a.startsWith("--"));
  const unknown  = flags.filter(f => f !== "--write" && f !== "--allow-decrease");
  const lcovPath = args[0];
  if (!lcovPath || unknown.length > 0 || (flags.includes("--allow-decrease") && !flags.includes("--write"))) {
    console.error("사용법: node scripts/check-coverage.js <lcov.info> [--write [--allow-decrease]]");
    return 2;
  }
  const current = summarize(parseLcov(fs.readFileSync(lcovPath, "utf8")), isSourceFile);
  if (current.files === 0) {
    console.error(`[coverage] ${lcovPath} 에 저장소 소스 파일 기록이 없다`);
    return 2;
  }

  if (flags.includes("--write")) {
    const prev = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) : null;
    const plan = planWrite(current, prev, flags.includes("--allow-decrease"));
    if (!plan.ok) {
      console.error("[coverage] 기준선을 낮출 수 없다. 기준선은 기록하지 않았다:\n  " + plan.lowered.join("\n  "));
      console.error("[coverage] 승인된 재생성이면 --write --allow-decrease 를 쓴다.");
      return 1;
    }
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(plan.next, null, 2) + "\n");
    console.log(`[coverage] 기준선 기록: ${JSON.stringify(plan.next)}`);
    return 0;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const drops    = findDrops(current, baseline);
  console.log(`[coverage] 현재 lines ${current.lines}% branches ${current.branches}% functions ${current.functions}% (파일 ${current.files})`);
  if (drops.length > 0) {
    console.error("[coverage] 기준선 아래로 내려간 지표:\n  " + drops.join("\n  "));
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error("[coverage] 실행 실패:", err);
    process.exitCode = 2;
  }
}
