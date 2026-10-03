/**
 * CLI: benchmark - 회상 품질 오프라인 정량 평가
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 골드셋 (저장문, 질의) 쌍을 격리 스코프에 적재하고 질의를 실행해
 * Recall@k / MRR / 지연을 산출한다. 실행이 끝나면 적재분을 회수한다.
 */

import { readFile, writeFile } from "node:fs/promises";
import { MemoryManager }       from "../memory/MemoryManager.js";
import { shutdownPool }        from "../tools/db.js";
import { RecallBenchmark, validateGoldset, compareToBaseline, embeddingMismatch } from "../memory/signals/RecallBenchmark.js";
import { parseJsonl }                             from "../memory/signals/RecallEvalSet.js";
import { resolveFormat, renderTable, renderJson } from "./_format.js";
import { EMBEDDING_PROVIDER, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, DB_HOST, DB_PORT, DB_NAME } from "../config.js";

const DEFAULT_GOLDSET = "tests/fixtures/recall-goldset.jsonl";

export const usage = [
  "Usage: memento-mcp benchmark [options]",
  "",
  "Measure recall quality against a goldset of (stored text, paraphrased query) pairs.",
  "",
  "Options:",
  `  --goldset <path>       Goldset JSONL path (default: ${DEFAULT_GOLDSET})`,
  "  --baseline <path>      Compare against a saved baseline JSON and report regressions",
  "  --save-baseline <path> Write the resulting metrics to a baseline JSON file",
  "  --limit <n>            Evaluate only the first n goldset entries",
  "  --repeat <n>           Evaluate n times on one seeding and report the median (default: 1)",
  "  --synthetic            Generate synthetic reverse queries for the seeded fragments before evaluating",
  "  --page-size <n>        Max fragments per recall call (default: 10)",
  "  --no-seed              Skip seeding (evaluate against an already seeded scope)",
  "  --no-cleanup           Keep seeded fragments after the run (for debugging)",
  "  --agent-id <id>        Isolation agent id (default: benchmark-harness)",
  "  --key-scope <mode>     isolated (default) measures against the seeded set only;",
  "                         corpus competes against production fragments and is not reproducible",
  "  --workspace <name>     Isolation workspace (default: __benchmark__)",
  "  --format table|json    Output format (default: table if TTY, json otherwise)",
  "  --json                 Shorthand for --format json",
  "",
  "Examples:",
  "  memento-mcp benchmark",
  "  memento-mcp benchmark --limit 20 --json",
  "  memento-mcp benchmark --save-baseline scripts/baseline-recall.json",
  "  memento-mcp benchmark --baseline scripts/baseline-recall.json",
].join("\n");

/**
 * JSONL 파일을 읽어 골드셋 배열로 파싱한다.
 *
 * @param {string} path
 * @returns {Promise<Object[]>}
 */
async function loadGoldset(path) {
  return parseJsonl(await readFile(path, "utf-8"), `골드셋 ${path}`);
}

/**
 * 비율 값을 백분율 문자열로 만든다.
 *
 * @param {number|null} value
 * @returns {string}
 */
function pct(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "--";
}

/**
 * 기준선과 현재 실행의 임베딩 모델이 다르면 경고를 stderr로 낸다.
 *
 * @param {Object} baselineRaw 읽어 들인 기준선 JSON
 * @param {{model: string, dimensions: number}} embeddingInfo
 */
function warnEmbeddingMismatch(baselineRaw, embeddingInfo) {
  const mismatch = embeddingMismatch(baselineRaw.embedding, embeddingInfo);
  if (mismatch) console.error(`[benchmark] ${mismatch}`);
}

/**
 * 실행이 붙을 데이터베이스를 알리는 한 줄. 연결 풀과 같은 설정에서 읽고
 * 사용자와 비밀번호는 담지 않는다.
 *
 * @returns {string}
 */
export function dbTargetLine() {
  return `[benchmark] 대상 DB: host=${DB_HOST || "(미지정)"} port=${DB_PORT} database=${DB_NAME || "(미지정)"}`;
}

/**
 * 기준선 저장을 거부해야 하면 사유를 돌려준다. 임베딩된 파편이 없는 실행은
 * 임베딩 모델 표기와 수치가 맞지 않으므로 저장하지 않는다. 적재를 건너뛴(--no-seed)
 * 실행은 파편을 임베딩하지 않으므로 그 사실을 사유에 밝힌다.
 *
 * @param {Object} report
 * @param {{seed?: boolean}} [run] seed=false 는 --no-seed 로 실행했다는 뜻
 * @returns {string|null}
 */
export function baselineRefusal(report, { seed = true } = {}) {
  if (report?.embedding?.embedded > 0) return null;
  if (!seed) {
    return "--no-seed 실행은 파편을 적재하지도 임베딩하지도 않으므로 --save-baseline으로 저장할 수 없다. " +
           "--no-seed 없이 EMBEDDING_ENABLED=true와 임베딩 모델을 지정해 다시 실행한다.";
  }
  return "임베딩된 파편이 0건인 실행은 --save-baseline으로 저장하지 않는다. " +
         "EMBEDDING_ENABLED=true와 임베딩 모델을 지정해 다시 실행한다.";
}

/**
 * 기준선 파일을 쓴다.
 *
 * @param {Object} report
 * @param {{path: string, goldsetPath: string, embeddingInfo: Object, seed: boolean}} target
 * @returns {Promise<void>}
 */
async function saveBaseline(report, { path, goldsetPath, embeddingInfo, seed }) {
  const refusal = baselineRefusal(report, { seed });
  if (refusal) throw new Error(refusal);
  await writeFile(path, JSON.stringify({
    generated_at: report.generated_at,
    goldset     : goldsetPath,
    goldset_size: report.goldset_size,
    embedding   : embeddingInfo,
    metrics     : report.metrics,
  }, null, 2) + "\n", "utf-8");
}

/**
 * 지표 묶음을 사람이 읽는 형태로 출력한다.
 *
 * @param {Object} report
 */
function printReport(report) {
  const m = report.metrics;

  console.log(`Goldset: ${report.goldset_size} entries, seeded ${report.seeded}, embedded ${report.embedding.embedded} (pending ${report.embedding.pending})`);
  if (report.synthetic) {
    console.log(`Synthetic: ${report.synthetic.generated} queries for ${report.synthetic.processed} fragments`);
  }
  if (report.settle) {
    console.log(`Settle:  ${report.settle.links} links after ${report.settle.waitedMs}ms${report.settle.stable ? "" : " (not stable, timed out)"}`);
  }
  console.log("");
  console.log(`Recall@1  ${pct(m.offline_recall_at_1)}`);
  console.log(`Recall@5  ${pct(m.offline_recall_at_5)}`);
  console.log(`Recall@10 ${pct(m.offline_recall_at_10)}`);
  console.log(`MRR       ${typeof m.offline_mrr === "number" ? m.offline_mrr.toFixed(4) : "--"}`);
  console.log(`Misses    ${m.misses}`);
  console.log(`Latency   p50 ${m.latency_ms.p50 ?? "--"}ms, p95 ${m.latency_ms.p95 ?? "--"}ms, max ${m.latency_ms.max ?? "--"}ms`);
  if (m.spread) {
    console.log(`Spread    recall@5 ${pct(m.spread.recall_at_5_min)} ~ ${pct(m.spread.recall_at_5_max)} over ${m.spread.runs} runs (median reported)`);
  }
  console.log("");

  const rows = Object.entries(m.by_query_class).map(([cls, v]) => ({
    query_class: cls,
    cases      : v.cases,
    "recall@1" : pct(v.offline_recall_at_1),
    "recall@5" : pct(v.offline_recall_at_5),
    "recall@10": pct(v.offline_recall_at_10),
    mrr        : typeof v.offline_mrr === "number" ? v.offline_mrr.toFixed(4) : "--",
  }));

  console.log(renderTable(rows, ["query_class", "cases", "recall@1", "recall@5", "recall@10", "mrr"]));

  const misses = report.rows.filter(r => r.rank === null);
  if (misses.length > 0) {
    console.log("");
    console.log(`Missed (${misses.length}):`);
    for (const miss of misses.slice(0, 20)) {
      console.log(`  ${miss.id} [${miss.queryClass}] ${miss.query}`);
    }
    if (misses.length > 20) console.log(`  ... ${misses.length - 20} more`);
  }
}

export default async function benchmark(args) {
  const goldsetPath = args.goldset || DEFAULT_GOLDSET;

  let goldset;
  try {
    goldset = await loadGoldset(goldsetPath);
  } catch (err) {
    console.error(`[benchmark] ${err.message}`);
    process.exit(1);
  }

  const errors = validateGoldset(goldset);
  if (errors.length > 0) {
    console.error(`[benchmark] 골드셋 검증 실패 (${errors.length}건):`);
    for (const e of errors.slice(0, 10)) console.error(`  - ${e}`);
    process.exit(1);
  }

  if (args.limit) {
    const n = parseInt(args.limit, 10);
    if (Number.isFinite(n) && n > 0) goldset = goldset.slice(0, n);
  }

  const manager = MemoryManager.create();
  const runner  = new RecallBenchmark(manager, {
    agentId  : args["agent-id"]  || undefined,
    workspace: args.workspace    || undefined,
    pageSize : args["page-size"] ? parseInt(args["page-size"], 10) : undefined,
    keyId    : args["key-scope"] === "corpus" ? null : undefined,
  });

  const isJson = resolveFormat(args) === "json";
  let   report;
  let   exitCode = 0;

  try {
    console.error(dbTargetLine());
    report = await runner.run(goldset, {
      seed      : args.seed    !== false,
      cleanup   : args.cleanup !== false,
      repeat    : args.repeat ? parseInt(args.repeat, 10) : 1,
      synthetic : args.synthetic === true,
      onProgress: ({ stage, total, round, of }) => {
        if (isJson) return;
        const suffix = round ? ` ${round}/${of}` : (total !== undefined ? ` (${total})` : "");
        console.error(`[benchmark] ${stage}${suffix}`);
      },
    });

    const embeddingInfo = {
      provider  : EMBEDDING_PROVIDER,
      model     : EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS
    };

    if (args["save-baseline"]) {
      await saveBaseline(report, { path: args["save-baseline"], goldsetPath, embeddingInfo, seed: args.seed !== false });
      if (!isJson) console.error(`[benchmark] baseline 저장: ${args["save-baseline"]}`);
    }

    let comparison = null;
    if (args.baseline) {
      const baselineRaw = JSON.parse(await readFile(args.baseline, "utf-8"));
      warnEmbeddingMismatch(baselineRaw, embeddingInfo);
      comparison = compareToBaseline(baselineRaw.metrics ?? baselineRaw, report.metrics);
      if (comparison.regressed) exitCode = 2;
    }

    if (isJson) {
      console.log(renderJson({ ...report, comparison }));
    } else {
      printReport(report);
      if (comparison) {
        console.log("");
        if (comparison.regressed) {
          console.log(`Regression detected (${comparison.reasons.length}):`);
          for (const reason of comparison.reasons) console.log(`  - ${reason}`);
        } else {
          console.log("No regression against baseline.");
        }
      }
    }
  } catch (err) {
    console.error(`[benchmark] ${err.message}`);
    exitCode = 1;
  } finally {
    shutdownPool().catch(() => {});
    setTimeout(() => process.exit(exitCode), 500);
  }
}
