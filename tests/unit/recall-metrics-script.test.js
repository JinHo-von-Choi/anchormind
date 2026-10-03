/**
 * 검색 지표 측정 스크립트의 대상 검사와 실행 골격 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 데이터베이스와 임베딩에 접속하지 않는다. 대상 거부 조건, 환경 준비, 병렬 실행기, 라벨 대조,
 * 지표 JSON 조립, 두 지표 JSON의 비교를 스텁 입력으로 확인한다.
 */

import { test, describe, mock } from "node:test";
import assert                   from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile }         from "node:child_process";
import { promisify }        from "node:util";
import { tmpdir }               from "node:os";
import path                     from "node:path";

import {
  MeasureRefusalError, parseTarget, resolveMeasureTarget, prepareEnvironment, assertConfigMatchesTarget,
  runWithConcurrency, executePass, queryKeywords, buildRecallParams, resolveLabels, scoreResults, countOrderChanges, buildReport,
  compareFiles, main, PASSES
} from "../../scripts/measure/recall-metrics.mjs";
import { TEST_PORT, TEST_USER, TEST_PASSWORD } from "../db-concurrency/_guard.js";

const execFileAsync = promisify(execFile);
const scriptUrl     = new URL("../../scripts/measure/recall-metrics.mjs", import.meta.url).href;

const lane = { host: "localhost", port: TEST_PORT, database: "restore_copy", user: TEST_USER, password: TEST_PASSWORD };

describe("parseTarget", () => {
  test("host:port/database를 분해한다", () => {
    assert.deepEqual(parseTarget("localhost:35433/restore_copy"), { host: "localhost", port: 35433, database: "restore_copy" });
    assert.equal(parseTarget("[::1]:35433/x").host, "::1");
  });

  test("형식이 다르거나 포트가 범위 밖이면 거부한다", () => {
    for (const bad of [undefined, "", "localhost", "localhost:35433", "localhost:abc/x", "localhost:35433/a-b", "localhost:70000/x", "postgres://u:p@h:1/d"]) {
      assert.throws(() => parseTarget(bad), MeasureRefusalError, String(bad));
    }
  });
});

describe("resolveMeasureTarget", () => {
  test("시험 컨테이너는 기본 접속 값으로 허용된다", () => {
    assert.deepEqual(resolveMeasureTarget("localhost:35433/restore_copy", {}), lane);
  });

  test("원격 호스트와 다른 포트는 거부 대상과 함께 거부된다", () => {
    assert.throws(() => resolveMeasureTarget("db.example.com:35433/x", {}), (e) => e instanceof MeasureRefusalError && e.message.includes("db.example.com") && e.message.startsWith("측정 거부"));
    assert.throws(() => resolveMeasureTarget("localhost:5432/x", {}), (e) => e instanceof MeasureRefusalError && e.message.includes("5432"));
  });

  test("다른 사용자와 비밀번호는 거부되고 메시지에 비밀번호가 없다", () => {
    assert.throws(() => resolveMeasureTarget("localhost:35433/x", { POSTGRES_USER: "other" }), MeasureRefusalError);
    assert.throws(
      () => resolveMeasureTarget("localhost:35433/x", { POSTGRES_PASSWORD: "super-secret-value" }),
      (e) => e instanceof MeasureRefusalError && !e.message.includes("super-secret-value")
    );
  });

  test("DB_LANE_SERVER_ALLOW는 호스트와 포트만 열고 접속 값 조건은 그대로다", () => {
    const env = { DB_LANE_SERVER_ALLOW: "localhost:5432" };
    assert.equal(resolveMeasureTarget("localhost:5432/x", env).port, 5432);
    assert.throws(() => resolveMeasureTarget("localhost:5432/x", { ...env, POSTGRES_USER: "other" }), MeasureRefusalError);
  });

  test("BATCH_DATABASE_URL이 있으면 거부한다", () => {
    assert.throws(() => resolveMeasureTarget("localhost:35433/x", { BATCH_DATABASE_URL: "postgres://elsewhere" }), /BATCH_DATABASE_URL/);
  });

  test("main은 대상이 거부되면 환경을 바꾸지 않고 거부한다", async () => {
    const before = process.env.POSTGRES_HOST;
    await assert.rejects(main(["--target", "db.example.com:5432/x"]), MeasureRefusalError);
    await assert.rejects(main([]), MeasureRefusalError);
    assert.equal(process.env.POSTGRES_HOST, before);
  });
});

describe("prepareEnvironment", () => {
  test("접속 값을 대상으로 정하고 이전 연결 값과 외부 의존을 끈다", () => {
    const env = { DB_HOST: "old", DATABASE_URL: "postgres://old", POSTGRES_HOST: "old", REDIS_ENABLED: "true", CACHE_ENABLED: "true" };
    prepareEnvironment(env, lane, { embeddings: "on" });
    assert.equal(env.POSTGRES_HOST, "localhost");
    assert.equal(env.POSTGRES_PORT, String(TEST_PORT));
    assert.equal(env.POSTGRES_DB, "restore_copy");
    assert.equal(env.DB_HOST, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.REDIS_ENABLED, "false");
    assert.equal(env.CACHE_ENABLED, "false");
    assert.equal(env.MEMENTO_METRICS_DEFAULT, "off");
    assert.equal(env.LOG_LEVEL, "error");
    assert.ok(env.LOG_DIR.startsWith(tmpdir()));
    const given = { LOG_LEVEL: "info", LOG_DIR: "/somewhere" };
    prepareEnvironment(given, lane, { embeddings: "on" });
    assert.deepEqual([given.LOG_LEVEL, given.LOG_DIR], ["info", "/somewhere"]);
  });

  test("DOTENV_CONFIG_PATH는 지정이 없을 때만 시험용 파일로 둔다", () => {
    const unset = {};
    prepareEnvironment(unset, lane, { embeddings: "on" });
    assert.equal(unset.DOTENV_CONFIG_PATH, ".env.test");
    const set = { DOTENV_CONFIG_PATH: "custom.env" };
    prepareEnvironment(set, lane, { embeddings: "on" });
    assert.equal(set.DOTENV_CONFIG_PATH, "custom.env");
  });

  test("임베딩 off는 키와 엔드포인트를 비우고 on은 건드리지 않는다", () => {
    const keys = { EMBEDDING_API_KEY: "k", OPENAI_API_KEY: "k", GEMINI_API_KEY: "k", EMBEDDING_BASE_URL: "http://x", EMBEDDING_PROVIDER: "gemini" };
    const off  = { ...keys };
    const on   = { ...keys };
    prepareEnvironment(off, lane, { embeddings: "off" });
    prepareEnvironment(on, lane, { embeddings: "on" });
    assert.equal(off.EMBEDDING_PROVIDER, "openai");
    assert.ok(["EMBEDDING_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "EMBEDDING_BASE_URL"].every(k => off[k] === undefined));
    assert.deepEqual(on.EMBEDDING_API_KEY, "k");
    assert.equal(on.EMBEDDING_PROVIDER, "gemini");
  });
});

describe("assertConfigMatchesTarget", () => {
  test("같으면 통과하고 하나라도 다르면 거부한다", () => {
    assert.doesNotThrow(() => assertConfigMatchesTarget({ DB_HOST: "localhost", DB_PORT: TEST_PORT, DB_NAME: "restore_copy" }, lane));
    for (const over of [{ DB_HOST: "other" }, { DB_PORT: 5432 }, { DB_NAME: "prod" }]) {
      assert.throws(() => assertConfigMatchesTarget({ DB_HOST: "localhost", DB_PORT: TEST_PORT, DB_NAME: "restore_copy", ...over }, lane), MeasureRefusalError);
    }
  });
});

describe("runWithConcurrency", () => {
  test("결과는 입력 순서이고 동시 실행 수는 한도를 넘지 않는다", async () => {
    let active = 0, peak = 0;
    const results = await runWithConcurrency([5, 1, 4, 2, 3, 6], 3, async (n) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, n));
      active -= 1;
      return n * 10;
    });
    assert.deepEqual(results, [50, 10, 40, 20, 30, 60]);
    assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
  });

  test("한도가 항목 수보다 커도 동작하고 빈 입력은 빈 결과", async () => {
    assert.deepEqual(await runWithConcurrency([1, 2], 8, async (n) => n), [1, 2]);
    assert.deepEqual(await runWithConcurrency([], 8, async (n) => n), []);
  });
});

describe("executePass", () => {
  test("호출 실패는 그 질의의 error로 남기고 나머지는 계속한다", async () => {
    let tick = 0;
    const now = () => (tick += 10);
    const out = await executePass([{ id: "a" }, { id: "b" }], async (e) => {
      if (e.id === "a") throw new TypeError("boom");
      return [{ id: "x", tokens: 5 }];
    }, 1, now);
    assert.match(out[0].error, /TypeError: boom/);
    assert.equal(out[0].fragments, null);
    assert.equal(out[1].error, null);
    assert.deepEqual(out[1].fragments, [{ id: "x", tokens: 5 }]);
    assert.equal(out[1].latencyMs, 10);
  });
});

describe("질의 키워드와 recall 인자", () => {
  test("항목의 keywords가 있으면 모드와 무관하게 그대로 쓴다", () => {
    assert.deepEqual(queryKeywords({ query: "아무 질의", keywords: ["a", "b"] }, "none"), ["a", "b"]);
  });

  test("whitespace는 공백으로 나누고 앞뒤 문장부호를 떼고 중복을 뺀다", () => {
    assert.deepEqual(queryKeywords({ query: "백업을 (언제) 하지? 백업을" }, "whitespace"), ["백업을", "언제", "하지"]);
    assert.deepEqual(queryKeywords({ query: "FOO_BAR, recall 설정" }, "whitespace"), ["FOO_BAR", "recall", "설정"]);
  });

  test("whitespace는 최대 10개이고 none은 비어 있다", () => {
    const query = Array.from({ length: 15 }, (_, i) => `w${i}`).join(" ");
    assert.equal(queryKeywords({ query }, "whitespace").length, 10);
    assert.deepEqual(queryKeywords({ query }, "none"), []);
  });

  test("recall 인자는 마스터 범위이고 workspace가 있는 항목만 좁힌다", () => {
    const opts   = { budgetTokens: 3000, pageSize: 7, keywordMode: "whitespace" };
    const all    = buildRecallParams({ query: "백업 위치" }, opts);
    const scoped = buildRecallParams({ query: "백업 위치", workspace: "ws" }, opts);
    assert.deepEqual([all.text, all.tokenBudget, all.pageSize, all._isMaster, all.allWorkspaces], ["백업 위치", 3000, 7, true, true]);
    assert.deepEqual(all.keywords, ["백업", "위치"]);
    assert.equal(scoped.workspace, "ws");
    assert.equal(scoped.allWorkspaces, undefined);
    assert.equal(all.includeLinks, false);
  });

  test("none이고 항목 keywords가 없으면 keywords 인자를 싣지 않는다", () => {
    assert.equal("keywords" in buildRecallParams({ query: "백업 위치" }, { budgetTokens: 1, pageSize: 1, keywordMode: "none" }), false);
  });
});

describe("resolveLabels", () => {
  const known = new Map([["f1", { tokens: 80, created_at: "2026-03-01T00:00:00Z" }], ["f2", { tokens: 40, created_at: "2025-12-31T10:00:00Z" }]]);
  const entries = [
    { id: "q1", subset: "human_ko", relevant: [{ id: "f1", grade: 3 }, { id: "gone", grade: 1 }] },
    { id: "q2", subset: "human_ko", relevant: [{ id: "gone", grade: 3 }] },
    { id: "q3", subset: "temporal_holdout", referenceDate: "2026-01-01", relevant: [{ id: "f1", grade: 3 }, { id: "f2", grade: 2 }] }
  ];

  test("DB에 없는 정답은 stale로 빼고 남은 정답이 없는 질의는 제외한다", () => {
    const r = resolveLabels(entries, known);
    assert.deepEqual(r.stale, [{ query: "q1", fragment: "gone" }, { query: "q2", fragment: "gone" }]);
    assert.deepEqual(r.excluded, ["q2"]);
    assert.deepEqual(r.usable.map(u => u.entry.id), ["q1", "q3"]);
    assert.deepEqual([...r.usable[0].relevant], [["f1", { grade: 3, tokens: 80 }]]);
  });

  test("시간 holdout 정답이 기준일 이전에 만들어졌으면 알린다", () => {
    assert.deepEqual(resolveLabels(entries, known).holdout_violations, [{ query: "q3", fragment: "f2" }]);
  });
});

describe("지표 JSON 조립", () => {
  const entries  = [
    { id: "q1", subset: "human_ko", tags: ["spacing"], domain: "ops", relevant: [{ id: "f1", grade: 3 }] },
    { id: "q2", subset: "identifier", tags: [], relevant: [{ id: "f2", grade: 3 }] },
    { id: "q3", subset: "synthetic", tags: [], relevant: [{ id: "f1", grade: 3 }] }
  ];
  const known    = new Map([["f1", { tokens: 80, created_at: "2026-03-01" }], ["f2", { tokens: 60, created_at: "2026-03-01" }]]);
  const resolved = resolveLabels(entries, known);
  const make     = (offsetMs) => PASSES.map((p, i) => ({
    ...p,
    results: resolved.usable.map(({ entry }, k) => ({
      entry,
      fragments: entry.id === "q2" ? [{ id: "z", tokens: 10 }] : [{ id: "z", tokens: 10 }, { id: "f1", tokens: 80 }],
      latencyMs: offsetMs + i * 3 + k,
      error    : null
    }))
  }));
  const report = (passes, generatedAt) => buildReport({
    target: lane, embeddings: { mode: "off", provider: null, model: null }, params: { token_budget: 4000 },
    coverage: {}, labels: {}, scored: scoreResults(resolved.usable, passes[0].results, { budgetTokens: 4000 }), passes, generatedAt
  });

  test("대상 DB 이름만 담고 접속 비밀은 담지 않는다", () => {
    const text = JSON.stringify(report(make(1), "t"));
    assert.ok(text.includes("restore_copy"));
    assert.ok(!text.includes(TEST_PASSWORD));
  });

  test("시각과 지연이 달라도 volatile 밖의 값은 같다", () => {
    const a = report(make(1), "2026-10-03T00:00:00Z");
    const b = report(make(50), "2026-10-04T09:00:00Z");
    const { volatile: va, ...restA } = a;
    const { volatile: vb, ...restB } = b;
    assert.deepEqual(restA, restB);
    assert.notDeepEqual(va, vb);
  });

  test("합성 질의는 전체 지표에서 빠지고 부분집합 표에는 있다", () => {
    const { metrics } = report(make(1), "t");
    assert.equal(metrics.overall.cases, 2);
    assert.equal(metrics.by_subset.synthetic.cases, 1);
  });

  test("지연은 단계별로 동시성과 함께 요약한다", () => {
    const { volatile } = report(make(1), "t");
    assert.deepEqual(Object.keys(volatile.latency), PASSES.map(p => p.name));
    assert.equal(volatile.latency.warm_c8.concurrency, 8);
    assert.equal(volatile.latency.cold.n, 3);
  });

  test("호출이 실패한 질의는 행에서 빼고 failures에 담는다", () => {
    const passes = make(1);
    passes[0].results[1] = { ...passes[0].results[1], fragments: null, error: "Error: x" };
    const scored = scoreResults(resolved.usable, passes[0].results, { budgetTokens: 4000 });
    assert.equal(scored.rows.length, 2);
    assert.deepEqual(scored.failures, [{ id: "q2", error: "Error: x" }]);
  });

  test("countOrderChanges는 반환 순서가 달라진 질의 수를 센다", () => {
    const a = [{ fragments: [{ id: "x" }, { id: "y" }] }, { fragments: [{ id: "x" }] }];
    const b = [{ fragments: [{ id: "y" }, { id: "x" }] }, { fragments: [{ id: "x" }] }];
    assert.equal(countOrderChanges(a, b), 1);
    assert.equal(countOrderChanges(a, a), 0);
  });
});

describe("compareFiles", () => {
  const doc = (rows) => ({ schema: "recall-metrics/v1", embeddings: { mode: "off" }, params: {}, rows });
  const row = (id, hit) => ({ id, subset: "human_ko", tags: [], domain: null, hit_at_1: hit, hit_at_5: hit, hit_at_10: hit, rr: hit, ndcg: hit });

  const withFiles = async (docs, fn) => {
    const dir = await mkdtemp(path.join(tmpdir(), "recall-compare-"));
    try {
      const paths = [];
      for (const [i, d] of docs.entries()) {
        const p = path.join(dir, `m${i}.json`);
        await writeFile(p, JSON.stringify(d));
        paths.push(p);
      }
      return await fn(paths);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("같은 입력과 시드는 같은 구간을 낸다", async () => {
    const a = doc([row("1", 0), row("2", 0), row("3", 1)]);
    const b = doc([row("1", 1), row("2", 1), row("3", 1)]);
    await withFiles([a, b], async ([pa, pb]) => {
      const opts = { iterations: 100, seed: 5, confidence: 0.95 };
      const one  = await compareFiles(pa, pb, opts);
      assert.deepEqual(one, await compareFiles(pa, pb, opts));
      const overall = one.comparisons.find(c => c.group === "overall" && c.metric === "recall_at_5");
      assert.ok(overall.mean_diff > 0);
    });
  });

  test("지표 JSON이 아닌 파일은 거부한다", async () => {
    await withFiles([{ schema: "other", rows: [] }, doc([])], async ([pa, pb]) => {
      await assert.rejects(compareFiles(pa, pb, { iterations: 10, seed: 1, confidence: 0.95 }), MeasureRefusalError);
    });
  });

  test("main --compare는 --out 파일에 JSON을 쓴다", async () => {
    await withFiles([doc([row("1", 0)]), doc([row("1", 1)])], async ([pa, pb]) => {
      const out  = path.join(path.dirname(pa), "out.json");
      const code = await main(["--compare", pa, pb, "--iterations", "50", "--out", out]);
      assert.equal(code, 0);
      const { readFile } = await import("node:fs/promises");
      assert.equal(JSON.parse(await readFile(out, "utf-8")).schema, "recall-compare/v1");
    });
  });

  test("main --help는 사용법을 출력하고 0을 돌려준다", async () => {
    const log = mock.method(console, "log", () => {});
    try {
      assert.equal(await main(["--help"]), 0);
      assert.match(String(log.mock.calls[0].arguments[0]), /--target/);
    } finally {
      log.mock.restore();
    }
  });
});

describe("모듈 적재", () => {
  test("스크립트를 불러와도 연결 설정 모듈과 .env 적재가 일어나지 않는다", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "recall-metrics-env-"));
    try {
      const envFile = path.join(dir, "sentinel.env");
      await writeFile(envFile, "F1_SENTINEL=loaded\n");
      const { stdout } = await execFileAsync(process.execPath, [
        "--input-type=module", "-e",
        `await import(${JSON.stringify(scriptUrl)}); console.log(process.env.F1_SENTINEL ?? "unset");`
      ], { env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: envFile } });
      assert.equal(stdout.trim(), "unset");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
