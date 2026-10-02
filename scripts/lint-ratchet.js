#!/usr/bin/env node
/**
 * 린트 래칫: 규칙별, 파일별 값이 기준선을 넘지 않게 한다.
 *
 * 대상 규칙은 RATCHET_RULES다. 파일별 값은 경고마다의 크기(복잡도, 줄 수, 깊이)를
 * 더한 합이고, 크기가 없는 규칙은 경고 수다. 기준선(scripts/lint-baseline.json)보다
 * 커지면 실패한다. 작아지면 낮출 수 있다는 안내만 낸다.
 * 기준선은 --update가 현재 값으로 다시 쓰며, 같은 코드에서는 항상 같은 파일을 만든다.
 * --update는 어느 값이든 기준선보다 커졌으면 아무것도 쓰지 않고 실패한다. 값을 올리는
 * 갱신은 --allow-increase를 함께 줄 때만 하며, 이 옵션은 통합 담당자나 소유자가 승인한
 * 재생성에만 쓴다.
 *
 * 사용: node scripts/lint-ratchet.js [--update [--allow-increase] | --init]
 * 종료 코드: 0 통과, 1 기준선 초과, 2 실행 실패
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import fs                from "node:fs";
import path              from "node:path";
import { fileURLToPath } from "node:url";

export const RATCHET_RULES = [
  "complexity",
  "max-lines-per-function",
  "max-lines",
  "max-depth",
  "local/no-silent-catch",
  "no-restricted-properties"
];

const SIZED_RULES   = new Set(["complexity", "max-lines-per-function", "max-lines", "max-depth"]);
const ROOT          = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(ROOT, "scripts", "lint-baseline.json");
const TARGETS       = ["lib", "server.js", "bin", "scripts", "config"];

/**
 * 경고 하나의 크기. complexity, max-lines, max-lines-per-function, max-depth는
 * 메시지의 실측값을, 그 밖의 규칙은 1을 쓴다.
 *
 * @param {{ ruleId: string, message: string }} msg
 * @returns {number}
 */
export function messageWeight(msg) {
  if (!SIZED_RULES.has(msg.ruleId)) return 1;
  const match = /(?:complexity of |\()(\d+)/.exec(msg.message);
  return match ? Number(match[1]) : 1;
}

/**
 * ESLint 결과를 { "rule": { "file": weight 합 } } 형태로 센다.
 *
 * @param {Array<{filePath: string, messages: Array<{ruleId: string|null, message: string}>}>} results
 * @param {string} root
 * @returns {Record<string, Record<string, number>>}
 */
export function countByRule(results, root) {
  const counts = Object.fromEntries(RATCHET_RULES.map(r => [r, {}]));
  for (const result of results) {
    const rel = path.relative(root, result.filePath).split(path.sep).join("/");
    for (const msg of result.messages) {
      if (!RATCHET_RULES.includes(msg.ruleId)) continue;
      counts[msg.ruleId][rel] = (counts[msg.ruleId][rel] ?? 0) + messageWeight(msg);
    }
  }
  return counts;
}

/**
 * 현재 값을 기준선과 비교한다.
 *
 * @param {Record<string, Record<string, number>>} current
 * @param {Record<string, Record<string, number>>} baseline
 * @returns {{ increased: string[], decreased: string[] }}
 */
export function compareCounts(current, baseline) {
  const increased = [];
  const decreased = [];
  for (const rule of RATCHET_RULES) {
    const cur   = current[rule]  ?? {};
    const base  = baseline[rule] ?? {};
    const files = new Set([...Object.keys(cur), ...Object.keys(base)]);
    for (const file of [...files].sort()) {
      const now     = cur[file]  ?? 0;
      const allowed = base[file] ?? 0;
      if (now > allowed) increased.push(`${rule} ${file}: ${allowed} -> ${now}`);
      if (now < allowed) decreased.push(`${rule} ${file}: ${allowed} -> ${now}`);
    }
  }
  return { increased, decreased };
}

/**
 * 기준선 파일을 결정적 순서로 직렬화한다. 정렬은 로캘과 무관한 코드 단위 순서다.
 *
 * @param {Record<string, Record<string, number>>} counts
 * @returns {string}
 */
export function serializeBaseline(counts) {
  const ordered = {};
  for (const rule of RATCHET_RULES) {
    const entries = Object.entries(counts[rule] ?? {})
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    ordered[rule] = Object.fromEntries(entries);
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * 명령줄 인자를 해석한다. 옵션은 순서와 무관하다.
 *
 * @param {string[]} args process.argv.slice(2)
 * @returns {{ mode: "--check"|"--init"|"--update", allowIncrease: boolean, unknown: string[] }}
 */
export function parseArgs(args) {
  const isMode        = a => a === "--init" || a === "--update" || a === "--check";
  const modes         = args.filter(isMode);
  const allowIncrease = args.includes("--allow-increase");
  const unknown       = args.filter(a => !isMode(a) && a !== "--allow-increase");
  if (modes.length > 1) unknown.push(...modes);
  return { mode: modes.length === 1 ? modes[0] : "--check", allowIncrease, unknown };
}

/**
 * 기준선 파일을 현재 값으로 갱신한다. 값이 늘어난 항목이 있고 allowIncrease가 아니면
 * 파일을 건드리지 않고 1을 돌려준다. 줄어든 값은 항상 기록한다.
 *
 * @param {{ current: Record<string, Record<string, number>>, baselinePath: string, allowIncrease: boolean }} opts
 * @returns {{ code: number, out: string[], err: string[] }}
 */
export function updateBaseline({ current, baselinePath, allowIncrease }) {
  const baseline      = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const { increased } = compareCounts(current, baseline);

  if (increased.length > 0 && !allowIncrease) {
    return {
      code: 1,
      out : [],
      err : [
        "[lint-ratchet] 기준선을 올릴 수 없다. 기준선은 기록하지 않았다:",
        ...increased.map(line => `  ${line}`),
        "[lint-ratchet] 승인된 재생성이면 --update --allow-increase 를 쓴다."
      ]
    };
  }
  fs.writeFileSync(baselinePath, serializeBaseline(current));
  return { code: 0, out: [`[lint-ratchet] 기준선 갱신: ${summary(current)}`], err: [] };
}

function summary(counts) {
  return RATCHET_RULES.map(r => `${r}=${Object.values(counts[r] ?? {}).reduce((a, b) => a + b, 0)}`).join(" ");
}

async function main(argv) {
  const { mode, allowIncrease, unknown } = parseArgs(argv.slice(2));

  if (unknown.length > 0) {
    console.error(`[lint-ratchet] 알 수 없는 옵션: ${unknown.join(" ")}`);
    return 2;
  }
  if (allowIncrease && mode !== "--update") {
    console.error("[lint-ratchet] --allow-increase는 --update와 함께만 쓴다.");
    return 2;
  }

  const { ESLint } = await import("eslint");
  const eslint     = new ESLint({ cwd: ROOT });
  const results    = await eslint.lintFiles(TARGETS);
  const current    = countByRule(results, ROOT);

  if (mode === "--init") {
    if (fs.existsSync(BASELINE_PATH)) {
      console.error("[lint-ratchet] 기준선이 이미 있다. --update를 쓴다.");
      return 2;
    }
    fs.writeFileSync(BASELINE_PATH, serializeBaseline(current));
    console.log(`[lint-ratchet] 기준선 생성: ${summary(current)}`);
    return 0;
  }

  if (mode === "--update") {
    const { code, out, err } = updateBaseline({ current, baselinePath: BASELINE_PATH, allowIncrease });
    out.forEach(line => console.log(line));
    err.forEach(line => console.error(line));
    return code;
  }

  const baseline                 = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const { increased, decreased } = compareCounts(current, baseline);

  if (increased.length > 0) {
    console.error("[lint-ratchet] 기준선 초과:");
    increased.forEach(line => console.error(`  ${line}`));
    return 1;
  }
  if (decreased.length > 0) {
    console.log(`[lint-ratchet] 기준선보다 작은 항목 ${decreased.length}개. node scripts/lint-ratchet.js --update 로 기준선을 낮춘다.`);
  }
  console.log(`[lint-ratchet] 통과: ${summary(current)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then(code => process.exit(code), (err) => {
    console.error("[lint-ratchet] 실행 실패:", err);
    process.exit(2);
  });
}
