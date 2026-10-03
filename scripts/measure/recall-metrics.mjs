#!/usr/bin/env node
/**
 * 검색 지표 측정 스크립트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 평가 세트(tests/fixtures/recall-eval-v2)의 질의를 대상 DB에 실행해 R@1/5/10, MRR,
 * 예산 내 토큰 가중 nDCG, 지연 백분위수를 지표 JSON으로 출력한다. 기대값과 대조하지
 * 않는다. 두 지표 JSON의 비교는 --compare 로 질의별 짝지은 부트스트랩 95% 구간을 낸다.
 *
 * 대상 DB는 일회용 시험 서버(포트 35433의 시험 컨테이너, 또는 DB_LANE_SERVER_ALLOW 로
 * 명시한 한 곳)여야 하며 접속을 열기 전에 검사한다. 연결 설정은 --target 만으로 정하고
 * Redis와 지표 수집은 끈다.
 *
 * 사용:
 *   node scripts/measure/recall-metrics.mjs --target <host:port/database> [옵션]
 *   node scripts/measure/recall-metrics.mjs --compare <기준.json> <후보.json> [옵션]
 */

import { readFile, writeFile } from "node:fs/promises";
import os                      from "node:os";
import path                    from "node:path";
import { fileURLToPath }       from "node:url";

import { LaneRefusalError, assertLaneServer, resolveLaneServer } from "../../tests/db-concurrency/_guard.js";
import { parseArgs }                                              from "../../lib/cli/parseArgs.js";
import {
  loadEvalDir, splitLabeled, coverageReport, EvalSetError, AUXILIARY_SUBSETS, SUBSETS
} from "../../lib/memory/signals/RecallEvalSet.js";
import { scoreQuery, summarizeRows, latencySummary, NDCG_UNIT_TOKENS } from "../../lib/memory/signals/RecallMetrics.js";
import { compareRuns, DEFAULT_ITERATIONS, DEFAULT_SEED, DEFAULT_CONFIDENCE } from "../../lib/memory/signals/PairedBootstrap.js";

const ROOT            = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_EVAL    = path.join(ROOT, "tests/fixtures/recall-eval-v2");
const SCHEMA_METRICS  = "recall-metrics/v1";
const SCHEMA_COMPARE  = "recall-compare/v1";
const TARGET_PATTERN  = /^(\[[^\]]+\]|[^:/\s]+):(\d{1,5})\/([A-Za-z0-9_]+)$/;
const EMBEDDING_KEYS  = ["EMBEDDING_API_KEY", "GEMINI_API_KEY", "CF_API_TOKEN", "CLOUDFLARE_API_TOKEN", "OPENAI_API_KEY", "EMBEDDING_BASE_URL"];
const LEGACY_DB_KEYS  = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_URL"];

/** 측정을 시작할 수 없는 조건. 메시지에는 거부한 대상만 담는다. */
export class MeasureRefusalError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "MeasureRefusalError";
  }
}

export const usage = [
  "Usage:",
  "  node scripts/measure/recall-metrics.mjs --target <host:port/database> [options]",
  "  node scripts/measure/recall-metrics.mjs --compare <baseline.json> <candidate.json> [options]",
  "",
  "Measure options:",
  "  --target <host:port/db>  Disposable lane server database (required, checked before connecting)",
  `  --eval-dir <path>        Evaluation set directory (default: tests/fixtures/recall-eval-v2)`,
  `  --subsets a,b            Subsets to run (default: ${SUBSETS.join(",")})`,
  "  --examples               Include example.jsonl (synthetic sample, labels do not exist in a real DB)",
  "  --embeddings off|on      off (default) disables the query embedding channel; on uses the environment",
  "  --token-budget <n>       recall token budget and nDCG budget (default: 4000)",
  "  --page-size <n>          Max fragments per recall call (default: 10)",
  "  --query-keywords <mode>  whitespace (default) sends the query split on spaces as keywords next to the text,",
  "                           none sends the text only. A keywords field in an entry always wins",
  "  --limit <n>              Run only the first n labeled queries",
  "  --out <path>             Write the metric JSON to a file instead of stdout",
  "",
  "Compare options:",
  `  --iterations <n>         Bootstrap resamples (default: ${DEFAULT_ITERATIONS})`,
  `  --seed <n>               Bootstrap seed (default: ${DEFAULT_SEED})`,
  `  --confidence <p>         Interval level (default: ${DEFAULT_CONFIDENCE})`
].join("\n");

/**
 * "host:port/database" 형식의 대상을 분해한다.
 *
 * @param {string} spec
 * @returns {{host: string, port: number, database: string}}
 */
export function parseTarget(spec) {
  const match = TARGET_PATTERN.exec(String(spec ?? ""));
  if (!match) throw new MeasureRefusalError(`측정 거부: --target 은 host:port/database 형식이어야 한다 (받은 값: "${spec ?? ""}")`);
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new MeasureRefusalError(`측정 거부: 포트 ${port} 가 범위 밖이다`);
  return { host: match[1].replace(/^\[|\]$/g, ""), port, database: match[3] };
}

/**
 * 대상이 일회용 시험 서버인지 확인한다. 사용자와 비밀번호는 환경의 POSTGRES_USER와
 * POSTGRES_PASSWORD에서 읽으며 비어 있으면 시험 컨테이너 값이 기본이다.
 *
 * @param {string} spec
 * @param {Record<string, string|undefined>} env
 * @returns {{host: string, port: number, database: string, user: string, password: string}}
 */
export function resolveMeasureTarget(spec, env) {
  const target = parseTarget(spec);
  if (env.BATCH_DATABASE_URL) {
    throw new MeasureRefusalError("측정 거부: BATCH_DATABASE_URL 이 설정되어 있어 배치 풀이 다른 DB로 향할 수 있다. 값을 비우고 다시 실행한다.");
  }
  const server = resolveLaneServer({
    POSTGRES_HOST    : target.host,
    POSTGRES_PORT    : String(target.port),
    POSTGRES_USER    : env.POSTGRES_USER,
    POSTGRES_PASSWORD: env.POSTGRES_PASSWORD
  });
  try {
    assertLaneServer(server, env);
  } catch (err) {
    if (!(err instanceof LaneRefusalError)) throw err;
    throw new MeasureRefusalError(`측정 거부: ${err.message.replace(/^DB 동시성 시험 거부: /, "")}`, { cause: err });
  }
  return { ...server, database: target.database };
}

/**
 * 검증된 대상으로 환경을 정한다. 연결 설정 모듈을 불러오기 전에 호출해야 한다.
 * Redis, 캐시, 지표 수집은 끄고, 로그는 오류만 임시 디렉터리에 남긴다(로거가 표준 출력으로
 * 쓰므로 지표 JSON과 섞이지 않게 한다). 임베딩 off 모드에서는 질의 임베딩 채널이 켜지지 않도록
 * 키와 엔드포인트 값을 비운다.
 *
 * @param {Record<string, string|undefined>} env 수정 대상(보통 process.env)
 * @param {{host: string, port: number, database: string, user: string, password: string}} target
 * @param {{embeddings: "off"|"on"}} opts
 */
export function prepareEnvironment(env, target, { embeddings }) {
  for (const key of LEGACY_DB_KEYS) delete env[key];
  env.POSTGRES_HOST           = target.host;
  env.POSTGRES_PORT           = String(target.port);
  env.POSTGRES_DB             = target.database;
  env.POSTGRES_USER           = target.user;
  env.POSTGRES_PASSWORD       = target.password;
  env.REDIS_ENABLED           = "false";
  env.CACHE_ENABLED           = "false";
  env.MEMENTO_METRICS_DEFAULT = "off";
  env.DOTENV_CONFIG_PATH    ??= ".env.test";
  env.LOG_LEVEL             ??= "error";
  env.LOG_DIR               ??= path.join(os.tmpdir(), "recall-metrics-logs");

  if (embeddings === "off") {
    env.EMBEDDING_PROVIDER = "openai";
    for (const key of EMBEDDING_KEYS) delete env[key];
  }
}

/**
 * 연결 설정이 검증된 대상과 같은지 확인한다.
 *
 * @param {{DB_HOST: string, DB_PORT: number, DB_NAME: string}} config
 * @param {{host: string, port: number, database: string}} target
 */
export function assertConfigMatchesTarget(config, target) {
  if (config.DB_HOST !== target.host || config.DB_PORT !== target.port || config.DB_NAME !== target.database) {
    throw new MeasureRefusalError(
      `측정 거부: 연결 설정(host=${config.DB_HOST} port=${config.DB_PORT} database=${config.DB_NAME})이 ` +
      `검증한 대상(host=${target.host} port=${target.port} database=${target.database})과 다르다.`
    );
  }
}

/**
 * 항목을 제한 병렬도로 처리한다. 결과 순서는 입력 순서다.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let   next    = 0;
  const worker  = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * 질의 전체를 한 번 실행한다. 호출 하나의 실패는 그 질의의 error로 남기고 나머지는 계속한다.
 *
 * @param {Object[]} entries
 * @param {(entry: Object) => Promise<Array<{id: string, tokens: number}>>} recallFn
 * @param {number} concurrency
 * @param {() => number} now 밀리초 시계
 * @returns {Promise<Array<{entry: Object, fragments: Array|null, latencyMs: number, error: string|null}>>}
 */
export async function executePass(entries, recallFn, concurrency, now = () => performance.now()) {
  return runWithConcurrency(entries, concurrency, async (entry) => {
    const startedAt = now();
    try {
      const fragments = await recallFn(entry);
      return { entry, fragments, latencyMs: now() - startedAt, error: null };
    } catch (err) {
      return { entry, fragments: null, latencyMs: now() - startedAt, error: `${err.name}: ${err.message}` };
    }
  });
}

/** 지연 측정 단계. cold는 프로세스 시작 뒤 첫 실행이며 캐시를 비우지 않는다. */
export const PASSES = Object.freeze([
  { name: "cold",    concurrency: 1 },
  { name: "warm_c1", concurrency: 1 },
  { name: "warm_c8", concurrency: 8 }
]);

/**
 * 질의와 함께 보내는 키워드를 정한다. 항목에 keywords가 있으면 그것을 쓰고, 없으면 모드를 따른다.
 * whitespace는 질의를 공백으로 나누고 앞뒤 문장부호를 떼어 중복 없이 최대 10개를 쓴다.
 * none은 키워드를 보내지 않는다. 임베딩이 꺼진 실행에서 질의 문장만 보내면 어휘 채널이 비므로
 * 기본은 whitespace다.
 *
 * @param {Object} entry
 * @param {"whitespace"|"none"} mode
 * @returns {string[]}
 */
export function queryKeywords(entry, mode) {
  if (Array.isArray(entry.keywords)) return entry.keywords;
  if (mode === "none") return [];
  const tokens = entry.query.split(/\s+/).map(t => t.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")).filter(t => t.length > 0);
  return [...new Set(tokens)].slice(0, 10);
}

/**
 * recall 호출 인자를 만든다. 마스터 범위로 모든 에이전트의 파편을 보며 workspace가 있는 항목만
 * 그 workspace로 좁힌다.
 *
 * @param {Object} entry
 * @param {{budgetTokens: number, pageSize: number, keywordMode: "whitespace"|"none"}} opts
 * @returns {Object}
 */
export function buildRecallParams(entry, { budgetTokens, pageSize, keywordMode }) {
  const keywords = queryKeywords(entry, keywordMode);
  return {
    text: entry.query, ...(keywords.length > 0 ? { keywords } : {}),
    agentId: "default", tokenBudget: budgetTokens, pageSize,
    includeLinks: false, excludeSeen: false, _isMaster: true, includePeerAgents: true,
    ...(entry.workspace ? { workspace: entry.workspace } : { allWorkspaces: true })
  };
}

/**
 * 정답 파편을 대상 DB 조회 결과와 대조한다. DB에 없는 정답은 stale로 빼고, 남은 정답이 없는
 * 질의는 지표에서 제외한다. 시간 holdout 질의의 정답이 기준일 이전에 만들어졌으면 따로 알린다.
 *
 * @param {Object[]} entries 라벨이 있는 항목
 * @param {Map<string, {tokens: number, created_at: string|Date}>} known 대상 DB의 파편 정보
 * @returns {{usable: Array<{entry: Object, relevant: Map}>, stale: Object[], excluded: string[], holdout_violations: Object[]}}
 */
export function resolveLabels(entries, known) {
  const usable = [], stale = [], excluded = [], violations = [];

  for (const entry of entries) {
    const relevant = new Map();
    for (const item of entry.relevant) {
      const info = known.get(item.id);
      if (!info) { stale.push({ query: entry.id, fragment: item.id }); continue; }
      relevant.set(item.id, { grade: item.grade, tokens: info.tokens });
      if (entry.subset === "temporal_holdout" && new Date(info.created_at) <= new Date(`${entry.referenceDate}T23:59:59.999Z`)) {
        violations.push({ query: entry.id, fragment: item.id });
      }
    }
    if (relevant.size === 0) excluded.push(entry.id);
    else                     usable.push({ entry, relevant });
  }
  return { usable, stale, excluded, holdout_violations: violations };
}

/**
 * 첫 실행 결과를 지표 행으로 만든다. 호출이 실패한 질의는 행에 넣지 않고 failures에 담는다.
 *
 * @param {Array} usable resolveLabels의 usable
 * @param {Array} results 같은 순서의 executePass 결과
 * @param {{budgetTokens: number, unitTokens?: number}} opts
 * @returns {{rows: Object[], failures: Array<{id: string, error: string}>}}
 */
export function scoreResults(usable, results, { budgetTokens, unitTokens = NDCG_UNIT_TOKENS }) {
  const rows = [], failures = [];
  usable.forEach(({ entry, relevant }, i) => {
    const result = results[i];
    if (result.error) { failures.push({ id: entry.id, error: result.error }); return; }
    rows.push(scoreQuery({ entry, returned: result.fragments, relevant, budgetTokens, unitTokens }));
  });
  return { rows, failures };
}

/**
 * 첫 실행과 반환 순서가 다른 질의 수. 대상 DB가 실행 중에 바뀌었는지 가늠하는 값이다.
 *
 * @param {Array} first
 * @param {Array} other
 * @returns {number}
 */
export function countOrderChanges(first, other) {
  const key = (r) => (r.fragments ? r.fragments.map(f => f.id).join("\u0001") : null);
  return first.filter((r, i) => key(r) !== key(other[i])).length;
}

/**
 * 지표 JSON을 만든다. metrics, rows, coverage, labels는 같은 DB와 같은 세트에서 같은 값이고
 * 시각과 지연은 volatile 아래에만 둔다.
 *
 * @param {Object} input
 * @returns {Object}
 */
export function buildReport({ target, embeddings, params, coverage, labels, scored, passes, generatedAt }) {
  return {
    schema    : SCHEMA_METRICS,
    target    : { host: target.host, port: target.port, database: target.database },
    embeddings,
    params,
    coverage,
    labels,
    metrics   : summarizeRows(scored.rows, AUXILIARY_SUBSETS),
    failures  : scored.failures,
    rows      : scored.rows,
    volatile  : {
      generated_at: generatedAt,
      latency     : Object.fromEntries(passes.map(p => [p.name, { concurrency: p.concurrency, ...latencySummary(p.results.map(r => r.latencyMs)) }])),
      order_changes_vs_cold: Object.fromEntries(passes.slice(1).map(p => [p.name, countOrderChanges(passes[0].results, p.results)]))
    }
  };
}

/**
 * --compare 모드. 두 지표 JSON의 질의 행으로 부트스트랩 구간을 낸다.
 *
 * @param {string} baselinePath
 * @param {string} candidatePath
 * @param {{iterations: number, seed: number, confidence: number}} opts
 * @returns {Promise<Object>}
 */
export async function compareFiles(baselinePath, candidatePath, opts) {
  const [baseline, candidate] = await Promise.all([baselinePath, candidatePath].map(async (p) => JSON.parse(await readFile(p, "utf-8"))));
  for (const [name, doc] of [["기준", baseline], ["후보", candidate]]) {
    if (doc.schema !== SCHEMA_METRICS || !Array.isArray(doc.rows)) throw new MeasureRefusalError(`${name} 파일이 ${SCHEMA_METRICS} 지표 JSON이 아니다`);
  }
  return {
    schema   : SCHEMA_COMPARE,
    baseline : { file: path.basename(baselinePath),  embeddings: baseline.embeddings,  params: baseline.params },
    candidate: { file: path.basename(candidatePath), embeddings: candidate.embeddings, params: candidate.params },
    ...compareRuns(baseline.rows, candidate.rows, { ...opts, auxiliarySubsets: AUXILIARY_SUBSETS })
  };
}

/**
 * 정수 옵션을 읽는다.
 *
 * @param {Object} args
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function intOption(args, key, fallback) {
  if (args[key] === undefined) return fallback;
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value < 1) throw new MeasureRefusalError(`--${key} 는 1 이상의 정수여야 한다 (받은 값: ${args[key]})`);
  return value;
}

/**
 * 대상 DB에서 정답 파편의 토큰 수와 생성 시각을 읽는다.
 *
 * @param {Object} manager MemoryManager
 * @param {Object[]} entries
 * @param {(text: string) => number} countTokens
 * @returns {Promise<Map<string, {tokens: number, created_at: string|Date}>>}
 */
async function lookupFragments(manager, entries, countTokens) {
  const ids = [...new Set(entries.flatMap(e => e.relevant.map(r => r.id)))];
  const known = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await manager.store.getByIds(ids.slice(i, i + 200), "default", null, [], { includePeerAgents: true, _isMaster: true });
    for (const row of rows) known.set(row.id, { tokens: Math.max(1, countTokens(row.content || "")), created_at: row.created_at });
  }
  return known;
}

/**
 * 측정 모드. 환경 준비, 연결 설정 대조, 질의 실행, 지표 JSON 생성 순서다.
 *
 * @param {Object} args parseArgs 결과
 * @returns {Promise<{report: Object, exitCode: number}>}
 */
async function measure(args) {
  const embeddings = args.embeddings === undefined ? "off" : args.embeddings;
  if (!["off", "on"].includes(embeddings)) throw new MeasureRefusalError(`--embeddings 는 off 또는 on 이다 (받은 값: ${embeddings})`);

  const target = resolveMeasureTarget(args.target, process.env);
  prepareEnvironment(process.env, target, { embeddings });

  const { DB_HOST, DB_PORT, DB_NAME, EMBEDDING_ENABLED, EMBEDDING_PROVIDER, EMBEDDING_MODEL } = await import("../../lib/config.js");
  assertConfigMatchesTarget({ DB_HOST, DB_PORT, DB_NAME }, target);
  if (embeddings === "off" && EMBEDDING_ENABLED) throw new MeasureRefusalError("측정 거부: 임베딩 off 모드인데 임베딩 기능이 켜져 있다.");

  const { dbTargetLine }      = await import("../../lib/cli/benchmark.js");
  const { MemoryManager }     = await import("../../lib/memory/MemoryManager.js");
  const { countTokens }       = await import("../../lib/memory/write/FragmentFactory.js");
  const { shutdownPool }      = await import("../../lib/tools/db.js");
  console.error(dbTargetLine());

  const budgetTokens = intOption(args, "token-budget", 4000);
  const pageSize     = intOption(args, "page-size", 10);
  const keywordMode  = args["query-keywords"] === undefined ? "whitespace" : args["query-keywords"];
  if (!["whitespace", "none"].includes(keywordMode)) throw new MeasureRefusalError(`--query-keywords 는 whitespace 또는 none 이다 (받은 값: ${keywordMode})`);
  const subsets      = typeof args.subsets === "string" ? args.subsets.split(",") : undefined;
  const dir          = path.resolve(args["eval-dir"] || DEFAULT_EVAL);
  const { entries }  = await loadEvalDir(dir, { subsets, includeExamples: args.examples === true });
  const { labeled, unlabeled } = splitLabeled(entries);
  const selected     = args.limit ? labeled.slice(0, intOption(args, "limit", labeled.length)) : labeled;

  const manager = MemoryManager.create();
  try {
    const resolved = resolveLabels(selected, await lookupFragments(manager, selected, countTokens));
    const recallFn = async (entry) => {
      const res = await manager.recall(buildRecallParams(entry, { budgetTokens, pageSize, keywordMode }));
      return (res?.fragments ?? []).map(f => ({ id: f.id, tokens: f.estimated_tokens || countTokens(f.content || "") }));
    };

    const queries = resolved.usable.map(u => u.entry);
    const passes  = [];
    for (const pass of PASSES) passes.push({ ...pass, results: await executePass(queries, recallFn, pass.concurrency) });
    const scored = scoreResults(resolved.usable, passes[0].results, { budgetTokens });

    const report = buildReport({
      target,
      embeddings: { mode: embeddings, provider: embeddings === "on" ? EMBEDDING_PROVIDER : null, model: embeddings === "on" ? EMBEDDING_MODEL : null },
      params    : { token_budget: budgetTokens, page_size: pageSize, query_keywords: keywordMode, ndcg_unit_tokens: NDCG_UNIT_TOKENS, subsets: subsets ?? [...SUBSETS], files: dir === DEFAULT_EVAL ? "tests/fixtures/recall-eval-v2" : path.basename(dir), limit: args.limit ? selected.length : null },
      coverage  : coverageReport(entries),
      labels    : { unlabeled: unlabeled.length, stale_fragments: resolved.stale, excluded_queries: resolved.excluded, holdout_violations: resolved.holdout_violations },
      scored,
      passes,
      generatedAt: new Date().toISOString()
    });
    return { report, exitCode: scored.failures.length > 0 ? 1 : 0 };
  } finally {
    await shutdownPool().catch((err) => console.error(`[measure] 연결 풀 종료 실패: ${err.message}`));
  }
}

/**
 * 진입점.
 *
 * @param {string[]} argv
 * @returns {Promise<number>} 종료 코드
 */
export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) { console.log(usage); return 0; }

  let output;
  let exitCode = 0;
  if (args.compare) {
    const baseline  = args.compare;
    const candidate = args._[0];
    if (typeof baseline !== "string" || !candidate) throw new MeasureRefusalError("--compare 는 기준 JSON과 후보 JSON 두 경로가 필요하다");
    output = await compareFiles(baseline, candidate, {
      iterations: intOption(args, "iterations", DEFAULT_ITERATIONS),
      seed      : intOption(args, "seed", DEFAULT_SEED),
      confidence: args.confidence === undefined ? DEFAULT_CONFIDENCE : Number(args.confidence)
    });
  } else {
    ({ report: output, exitCode } = await measure(args));
  }

  const text = JSON.stringify(output, null, 2) + "\n";
  if (args.out) await writeFile(args.out, text, "utf-8");
  else          process.stdout.write(text);
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      const known = err instanceof MeasureRefusalError || err instanceof EvalSetError;
      console.error(`[measure] ${known ? err.message : err.stack}`);
      for (const detail of err.details ?? []) console.error(`  - ${detail}`);
      process.exit(known ? 3 : 1);
    }
  );
}
