/**
 * content_tokens 백필 스크립트 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 데이터베이스 없이 인자 처리, 환경 준비, 묶음 값 준비, 실행 흐름(미리보기 기본, --confirm 실행, 실패 행 재시도,
 * 선행 조건 거부)을 대역으로 검사한다. 실제 서버에서의 이어하기는 tests/db-concurrency/lexical-channel.test.js가 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import os               from "node:os";

import {
  parseBackfillArgs, prepareEnvironment, buildBatchParams, makePrepareBatch, main,
  BACKFILL_WHERE, BACKFILL_SET, CANDIDATE_SQL, DEFAULT_JOB, DEFAULT_BATCH_SIZE, BackfillUsageError
} from "../../scripts/ops/backfill-content-tokens.mjs";

const TARGET_ENV = { PGHOST: "db.internal.test", PGPORT: "6543", PGDATABASE: "memento", PGUSER: "ops", PGPASSWORD: "s3cret-pw" };

describe("parseBackfillArgs", () => {
  it("기본은 미리보기이고 작업 이름과 묶음 크기 기본값을 쓴다", () => {
    const opts = parseBackfillArgs([]);
    assert.equal(opts.confirm, false);
    assert.equal(opts.job, DEFAULT_JOB);
    assert.equal(opts.batchSize, DEFAULT_BATCH_SIZE);
    assert.equal(opts.restart, false);
    assert.equal(opts.retryFailures, false);
  });

  it("값 옵션은 --name value와 --name=value를 모두 받는다", () => {
    const opts = parseBackfillArgs(["--confirm", "--batch-size=50", "--job", "content-tokens-2", "--restart", "--url", "postgres://h/d"]);
    assert.equal(opts.confirm, true);
    assert.equal(opts.batchSize, 50);
    assert.equal(opts.job, "content-tokens-2");
    assert.equal(opts.restart, true);
    assert.equal(opts.url, "postgres://h/d");
  });

  it("--dry-run은 --confirm보다 우선한다", () => {
    assert.equal(parseBackfillArgs(["--confirm", "--dry-run"]).confirm, false);
  });

  const rejects = [
    ["알 수 없는 인자", ["--force"]],
    ["위치 인자", ["x"]],
    ["묶음 크기 0", ["--batch-size", "0"]],
    ["묶음 크기 상한 초과", ["--batch-size", "5001"]],
    ["묶음 크기 숫자 아님", ["--batch-size", "abc"]],
    ["작업 이름 형식", ["--job", "Bad Name"]],
    ["값 없는 옵션", ["--url"]],
    ["--restart와 --retry-failures 동시", ["--restart", "--retry-failures"]]
  ];
  for (const [name, argv] of rejects) {
    it(`거부: ${name}`, () => assert.throws(() => parseBackfillArgs(argv), BackfillUsageError));
  }

  it("오류 메시지에 인자 값을 담지 않는다", () => {
    try {
      parseBackfillArgs(["--url=postgres://u:pw-secret@h/d", "--nope=pw-secret"]);
      assert.fail("거부해야 한다");
    } catch (err) {
      assert.doesNotMatch(err.message, /pw-secret/);
    }
  });
});

describe("prepareEnvironment", () => {
  it("연결 설정을 대상으로 바꾸고 환경 파일을 읽지 않게 한다", () => {
    const env = { DATABASE_URL: "postgres://x", DB_HOST: "old", BATCH_DATABASE_URL: "postgres://y", DOTENV_CONFIG_PATH: ".env", KEEP: "1" };
    prepareEnvironment(env, { host: "h", port: 6543, database: "d", user: "u", password: "p" });
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.DB_HOST, undefined);
    assert.equal(env.BATCH_DATABASE_URL, undefined);
    assert.equal(env.POSTGRES_HOST, "h");
    assert.equal(env.POSTGRES_PORT, "6543");
    assert.equal(env.POSTGRES_DB, "d");
    assert.equal(env.POSTGRES_USER, "u");
    assert.equal(env.POSTGRES_PASSWORD, "p");
    assert.equal(env.DOTENV_CONFIG_PATH, os.devNull);
    assert.equal(env.REDIS_ENABLED, "false");
    assert.equal(env.KEEP, "1");
  });
});

describe("묶음 값과 문장", () => {
  it("buildBatchParams는 id, 토큰 문서, 해시를 같은 순서로 만든다", async () => {
    const rows   = [{ id: "a", content: "x y", content_hash: "h1" }, { id: "b", content: "", content_hash: "h2" }];
    const params = await buildBatchParams(rows, async (content) => content.toUpperCase());
    assert.deepEqual(params, [["a", "b"], ["X Y", ""], ["h1", "h2"]]);
  });

  it("갱신 문장은 해시가 같은 행에만 값을 쓰고 아니면 기존 값을 둔다", () => {
    assert.equal(BACKFILL_WHERE, "content_tokens IS NULL");
    assert.match(BACKFILL_SET, /^content_tokens = COALESCE\(/);
    assert.match(BACKFILL_SET, /unnest\(\$4::text\[\], \$5::text\[\], \$6::text\[\]\)/);
    assert.match(BACKFILL_SET, /m\.id = f\.id AND m\.hash = f\.content_hash/);
    assert.match(BACKFILL_SET, /to_tsvector\('simple', m\.doc\)/);
    assert.match(BACKFILL_SET, /, f\.content_tokens\)$/);
  });

  it("makePrepareBatch는 같은 조건과 묶음 크기로 다음 후보를 읽는다", async () => {
    const calls = [];
    const run   = async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: "f2", content: "서버 재시작", content_hash: "h" }] };
    };
    const prepare = makePrepareBatch(run, async () => "서버 재시작");
    assert.deepEqual(await prepare({ afterId: "f1", batchSize: 10 }), [["f2"], ["서버 재시작"], ["h"]]);
    assert.equal(calls[0].sql, CANDIDATE_SQL.batch);
    assert.deepEqual(calls[0].params, ["f1", 10]);
    await prepare({ afterId: "", batchSize: 1, onlyId: "f9" });
    assert.equal(calls[1].sql, CANDIDATE_SQL.single);
    assert.deepEqual(calls[1].params, ["f9"]);
  });
});

/** main의 실행 의존성 대역 */
function runtimeStub({ column = true, config = { DB_HOST: "db.internal.test", DB_PORT: 6543, DB_NAME: "memento" }, failRun = null } = {}) {
  const calls = { ensure: 0, run: [], retry: [], queries: [], loadedWithEnv: null, shutdown: 0 };
  const loadRuntime = async (env) => {
    calls.loadedWithEnv = { ...env };
    return {
      config,
      run: async (sql) => {
        calls.queries.push(sql);
        if (sql.includes("column_present")) return { rows: [{ column_present: column, indexes: [] }] };
        if (sql.includes("to_regclass($1) AS watermark")) return { rows: [{ watermark: null, failure: null }] };
        return { rows: [{ key_id: "k1", total: "5", missing: "2" }] };
      },
      lexicalSchemaSql      : "SELECT ... column_present",
      ensureBackfillTables  : async () => { calls.ensure++; },
      runResumableBackfill  : async (spec) => {
        if (failRun) throw failRun;
        calls.run.push(spec);
        return { job: spec.job, rowsUpdated: 3, failedRows: 0, lastId: "f3", resumedFrom: "", alreadyCompleted: false };
      },
      retryBackfillFailures : async (spec) => { calls.retry.push(spec); return { resolved: 1, stillFailing: 0 }; },
      tokenize              : async (content) => content,
      shutdown              : async () => { calls.shutdown++; }
    };
  };
  return { calls, loadRuntime };
}

function io() {
  const out = [];
  const err = [];
  return { out, err, deps: { out: line => out.push(line), err: line => err.push(line) } };
}

describe("main", () => {
  it("대상이 없으면 연결하지 않고 2로 끝난다", async () => {
    const { calls, loadRuntime } = runtimeStub();
    const sink = io();
    assert.equal(await main([], {}, { ...sink.deps, loadRuntime }), 2);
    assert.equal(calls.loadedWithEnv, null);
  });

  it("미리보기는 쓰지 않고 키별 미채움 수를 출력한다", async () => {
    const { calls, loadRuntime } = runtimeStub();
    const sink = io();
    const env  = { ...TARGET_ENV };
    assert.equal(await main([], env, { ...sink.deps, loadRuntime }), 0);
    assert.equal(calls.ensure, 0);
    assert.equal(calls.run.length, 0);
    assert.match(sink.out.join("\n"), /k1/);
    assert.doesNotMatch([...sink.out, ...sink.err].join("\n"), /s3cret-pw/);
    assert.equal(calls.loadedWithEnv.DOTENV_CONFIG_PATH, os.devNull);
    assert.equal(calls.loadedWithEnv.POSTGRES_HOST, "db.internal.test");
    assert.equal(calls.shutdown, 1);
  });

  it("--confirm은 표를 만들고 백필을 실행한다", async () => {
    const { calls, loadRuntime } = runtimeStub();
    const sink = io();
    assert.equal(await main(["--confirm", "--batch-size", "7", "--restart"], { ...TARGET_ENV }, { ...sink.deps, loadRuntime }), 0);
    assert.equal(calls.ensure, 1);
    const [spec] = calls.run;
    assert.equal(spec.job, DEFAULT_JOB);
    assert.equal(spec.where, BACKFILL_WHERE);
    assert.equal(spec.set, BACKFILL_SET);
    assert.equal(spec.batchSize, 7);
    assert.equal(spec.restart, true);
    assert.equal(typeof spec.prepareBatch, "function");
    assert.match(sink.out.join("\n"), /rowsUpdated/);
  });

  it("--retry-failures는 기록된 실패 행만 다시 한다", async () => {
    const { calls, loadRuntime } = runtimeStub();
    const sink = io();
    assert.equal(await main(["--confirm", "--retry-failures"], { ...TARGET_ENV }, { ...sink.deps, loadRuntime }), 0);
    assert.equal(calls.run.length, 0);
    assert.equal(calls.retry.length, 1);
  });

  it("열이 없으면 거부한다", async () => {
    const { calls, loadRuntime } = runtimeStub({ column: false });
    const sink = io();
    assert.equal(await main(["--confirm"], { ...TARGET_ENV }, { ...sink.deps, loadRuntime }), 2);
    assert.equal(calls.run.length, 0);
    assert.match(sink.err.join("\n"), /053/);
  });

  it("불러온 연결 설정이 대상과 다르면 거부한다", async () => {
    const { calls, loadRuntime } = runtimeStub({ config: { DB_HOST: "other", DB_PORT: 6543, DB_NAME: "memento" } });
    const sink = io();
    assert.equal(await main(["--confirm"], { ...TARGET_ENV }, { ...sink.deps, loadRuntime }), 2);
    assert.equal(calls.run.length, 0);
  });

  it("실행 실패는 1로 끝나고 연결을 닫는다", async () => {
    const { calls, loadRuntime } = runtimeStub({ failRun: Object.assign(new Error("connection lost"), { code: "57P01" }) });
    const sink = io();
    assert.equal(await main(["--confirm"], { ...TARGET_ENV }, { ...sink.deps, loadRuntime }), 1);
    assert.equal(calls.shutdown, 1);
  });

  it("--help는 연결하지 않는다", async () => {
    const { calls, loadRuntime } = runtimeStub();
    const sink = io();
    assert.equal(await main(["--help"], {}, { ...sink.deps, loadRuntime }), 0);
    assert.equal(calls.loadedWithEnv, null);
    assert.match(sink.out.join("\n"), /--confirm/);
  });
});
