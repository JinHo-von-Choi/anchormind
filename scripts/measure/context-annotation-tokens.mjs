#!/usr/bin/env node
/**
 * context 주입 줄 주석 토큰 증가율 측정 스크립트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 파편 목록을 context 크기의 창으로 나누어 주입 줄(lib/memory/read/ContextLines.js)을 주석 없이(off)와
 * 주석과 함께(on) 만들고 토큰 수를 센다. 같은 창으로 답 꾸러미(lib/memory/read/AnswerPack.js)의 부가 토큰도
 * 잰다. DB, 네트워크, 설정 파일에 닿지 않으며 결과를 기대값과 대조하지 않는다.
 *
 * 입력(JSONL, --fragments):
 *   - 평가 세트 줄: store를 본문으로 쓴다(tests/fixtures/recall-goldset.jsonl). 저장일은 --base-date,
 *     assertion은 저장 기본값 observed로 채운다.
 *   - 내보내기 줄(형식 버전 1, 2): record가 fragment이거나 없는 줄의 content, type, is_anchor, created_at,
 *     assertion_status를 그대로 쓴다. 머리, 링크, 이력, 끝 줄은 건너뛴다. 복구본에서 내보낸 파일로
 *     실제 분포를 잴 수 있다.
 * 창 안에서 is_anchor 파편은 앵커 구획, 나머지는 type별 core 구획에 들어간다. 창 크기 기본값은
 * contextInjection.maxCoreFragments 기본값(15)이다.
 *
 * 토큰 수는 cl100k_base(js-tiktoken, 저장 경로의 countTokens와 같은 인코더)로 세고, context 응답의
 * totalTokens가 쓰는 문자 수 / 4 추정도 함께 싣는다.
 *
 * 사용:
 *   node scripts/measure/context-annotation-tokens.mjs [--fragments <path>] [--window <n>]
 *     [--base-date YYYY-MM-DD] [--out <path>]
 */

import { readFileSync, writeFileSync } from "node:fs";
import path                            from "node:path";
import { fileURLToPath }               from "node:url";
import { encodingForModel }            from "js-tiktoken";

import { parseArgs }                 from "../../lib/cli/parseArgs.js";
import { percentile }                from "../../lib/memory/signals/RecallRankStats.js";
import { renderContextSectionLines } from "../../lib/memory/read/ContextLines.js";
import { buildAnswerPack }           from "../../lib/memory/read/AnswerPack.js";

const ROOT                = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_FRAGMENTS = path.join(ROOT, "tests/fixtures/recall-goldset.jsonl");
export const DEFAULT_WINDOW    = 15;
const DEFAULT_BASE_DATE   = "2026-10-03";
const SCHEMA              = "context-annotation-tokens/v1";
const SKIPPED_RECORDS     = new Set(["header", "link", "version", "end"]);

export const usage = [
  "Usage:",
  "  node scripts/measure/context-annotation-tokens.mjs [options]",
  "",
  "Options:",
  "  --fragments <path>      JSONL input: evaluation set lines with store, or export lines (default: tests/fixtures/recall-goldset.jsonl)",
  `  --window <n>            Fragments per context window (default: ${DEFAULT_WINDOW})`,
  `  --base-date YYYY-MM-DD  Storage date for lines without created_at (default: ${DEFAULT_BASE_DATE})`,
  "  --out <path>            Write the JSON report to a file instead of stdout"
].join("\n");

/** 입력이나 옵션을 해석할 수 없을 때의 오류 */
export class MeasureInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "MeasureInputError";
  }
}

/**
 * JSONL 텍스트를 측정용 파편 목록으로 바꾼다.
 *
 * @param {string} text
 * @param {{baseDate?: string}} [options]
 * @returns {Array<{id: string, type: string, content: string, is_anchor: boolean, created_at: string, assertion_status: string|null}>}
 */
export function parseFragmentLines(text, { baseDate = DEFAULT_BASE_DATE } = {}) {
  const fallbackDate = new Date(`${baseDate}T00:00:00Z`);
  if (!Number.isFinite(fallbackDate.getTime())) throw new MeasureInputError(`invalid --base-date: ${baseDate}`);

  const fragments = [];
  String(text).split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new MeasureInputError(`line ${index + 1}: ${err.message}`);
    }
    if (SKIPPED_RECORDS.has(row.record)) return;
    const isEvalLine = typeof row.store === "string";
    const content    = isEvalLine ? row.store : row.content;
    if (typeof content !== "string" || content === "") return;
    fragments.push({
      id              : String(row.id ?? `line-${index + 1}`),
      type            : row.type || "fact",
      content,
      is_anchor       : row.is_anchor === true,
      created_at      : row.created_at ?? fallbackDate.toISOString(),
      assertion_status: isEvalLine ? (row.assertion_status ?? "observed") : (row.assertion_status ?? null)
    });
  });
  if (fragments.length === 0) throw new MeasureInputError("no fragments in input");
  return fragments;
}

/**
 * 비율을 소수 넷째 자리로 고정한다. 분모가 0이면 null이다.
 *
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number|null}
 */
function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

/**
 * 창 하나의 주입 줄을 만든다.
 *
 * @param {object[]} fragments
 * @param {boolean} annotate
 * @returns {string}
 */
function renderWindow(fragments, annotate) {
  const sections = {
    anchor  : fragments.filter(f => f.is_anchor),
    core    : fragments.filter(f => !f.is_anchor),
    learning: [],
    working : []
  };
  return renderContextSectionLines(sections, { annotate }).join("\n");
}

/**
 * 창 단위로 주석 전후 토큰과 꾸러미 부가 토큰을 잰다.
 *
 * @param {object[]} fragments
 * @param {{window?: number, countTokens: (text: string) => number}} options
 * @returns {object}
 */
export function measureAnnotation(fragments, { window = DEFAULT_WINDOW, countTokens }) {
  const totals = { tokens_off: 0, tokens_on: 0, chars_off: 0, chars_on: 0, estimate_off: 0, estimate_on: 0 };
  const pack   = { content_tokens: 0, pack_tokens: 0 };
  const growth = [];
  let windows  = 0;

  for (let start = 0; start < fragments.length; start += window) {
    const slice = fragments.slice(start, start + window);
    const off   = renderWindow(slice, false);
    const on    = renderWindow(slice, true);
    const tOff  = countTokens(off);
    const tOn   = countTokens(on);
    totals.tokens_off   += tOff;
    totals.tokens_on    += tOn;
    totals.chars_off    += off.length;
    totals.chars_on     += on.length;
    totals.estimate_off += Math.ceil(off.length / 4);
    totals.estimate_on  += Math.ceil(on.length / 4);
    growth.push(ratio(tOn - tOff, tOff) ?? 0);

    pack.content_tokens += countTokens(slice.map(f => f.content).join("\n"));
    pack.pack_tokens    += countTokens(buildAnswerPack(slice).text);
    windows++;
  }

  return {
    fragments    : fragments.length,
    memory_lines : fragments.length,
    windows,
    total        : {
      ...totals,
      growth_ratio         : ratio(totals.tokens_on - totals.tokens_off, totals.tokens_off),
      estimate_growth_ratio: ratio(totals.estimate_on - totals.estimate_off, totals.estimate_off)
    },
    per_window_growth: {
      min   : Math.min(...growth),
      median: percentile(growth, 50),
      p95   : percentile(growth, 95),
      max   : Math.max(...growth)
    },
    per_line: {
      annotation_tokens_mean: ratio(totals.tokens_on - totals.tokens_off, fragments.length)
    },
    pack: {
      ...pack,
      overhead_ratio: ratio(pack.pack_tokens - pack.content_tokens, pack.content_tokens)
    }
  };
}

/**
 * 양의 정수 옵션을 읽는다.
 *
 * @param {object} args
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(args, name, fallback) {
  if (args[name] === undefined) return fallback;
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value < 1) throw new MeasureInputError(`--${name} must be a positive integer`);
  return value;
}

/**
 * 진입점.
 *
 * @param {string[]} argv
 * @param {{write?: (text: string) => void}} [io]
 * @returns {Promise<number>} 종료 코드
 */
export async function main(argv, { write = text => process.stdout.write(text) } = {}) {
  const args = parseArgs(argv);
  if (args.help || args.h) { write(`${usage}\n`); return 0; }

  const input     = path.resolve(typeof args.fragments === "string" ? args.fragments : DEFAULT_FRAGMENTS);
  const window    = positiveInt(args, "window", DEFAULT_WINDOW);
  const baseDate  = typeof args["base-date"] === "string" ? args["base-date"] : DEFAULT_BASE_DATE;
  const fragments = parseFragmentLines(readFileSync(input, "utf8"), { baseDate });
  const encoder   = encodingForModel("gpt-4");
  const measured  = measureAnnotation(fragments, { window, countTokens: text => encoder.encode(text).length });

  const report = {
    schema   : SCHEMA,
    input    : { path: path.relative(ROOT, input), window, base_date: baseDate },
    tokenizer: "cl100k_base",
    ...measured
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (typeof args.out === "string") writeFileSync(args.out, text, "utf8");
  else                              write(text);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      const known = err instanceof MeasureInputError || err?.code === "ENOENT";
      console.error(`[measure] ${known ? err.message : err.stack}`);
      process.exit(known ? 3 : 1);
    }
  );
}
