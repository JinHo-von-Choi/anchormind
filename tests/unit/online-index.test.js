/**
 * 온라인 색인 스크립트의 계획, 인자 처리, 실행 논리 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 데이터베이스 없이 순수 함수와 가짜 클라이언트로 검사한다. 실제 서버에서의 동작은
 * tests/db-concurrency/online-index.test.js 가 일회용 서버에서 검사한다.
 */
import { describe, it }  from "node:test";
import assert            from "node:assert/strict";
import fs                from "node:fs";
import os                from "node:os";
import path              from "node:path";
import {
  STEP, parseArgs, resolveTarget, resolveFreeBytes, requiredDiskBytes, createSql, planSteps,
  formatPlan, retryDelayMs, INSPECT_SQL, TABLE_SIZE_SQL, OPEN_TXN_SQL,
  OnlineIndexUsageError, OnlineIndexPreconditionError, OnlineIndexBuildError
} from "../../scripts/ops/online-index-plan.mjs";
import { buildIndexOnline, warnOpenTransactions, main } from "../../scripts/ops/online-index.mjs";
import {
  validateManifest, loadManifest, findBuildableEntry, IndexManifestError
} from "../../scripts/ops/index-manifest.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

const ENTRY = Object.freeze({
  name: "idx_example_workspace", table: "fragments",
  definition: "ON agent_memory.fragments (workspace) WHERE valid_to IS NULL"
});
const UNIQUE_ENTRY = Object.freeze({
  name: "uq_example_hash", table: "fragments", unique: true,
  definition: "ON agent_memory.fragments (content_hash)"
});

function writeManifest(indexes) {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "oi-manifest-"));
  const file = path.join(dir, "manifest.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, indexes }));
  return file;
}

describe("parseArgs", () => {
  it("기본값", () => {
    const o = parseArgs(["--index", "a"]);
    assert.equal(o.lockTimeout, "3s");
    assert.equal(o.retries, 2);
    assert.equal(o.retryWaitMs, 2000);
    assert.equal(o.retryMaxWaitMs, 30000);
    assert.equal(o.dryRun, false);
    assert.equal(o.confirm, false);
    assert.deepEqual(o.indexes, ["a"]);
  });

  it("값 옵션과 불리언 옵션을 읽는다", () => {
    const o = parseArgs(["--dry-run", "--confirm", "--index", "a", "--index", "b", "--lock-timeout", "500ms",
                         "--retries", "0", "--retry-wait-ms", "10", "--retry-max-wait-ms", "99", "--free-bytes", "1000", "--url", "postgres://h/d"]);
    assert.deepEqual(o.indexes, ["a", "b"]);
    assert.equal(o.dryRun, true);
    assert.equal(o.confirm, true);
    assert.equal(o.lockTimeout, "500ms");
    assert.equal(o.retries, 0);
    assert.equal(o.retryWaitMs, 10);
    assert.equal(o.retryMaxWaitMs, 99);
    assert.equal(o.freeBytes, 1000);
    assert.equal(o.url, "postgres://h/d");
  });

  const rejected = [
    ["알 수 없는 인자",          ["--force"]],
    ["값 없는 옵션",             ["--index"]],
    ["다음 옵션이 값 자리",      ["--index", "--confirm"]],
    ["잠금 제한 형식",           ["--lock-timeout", "3s; DROP TABLE x"]],
    ["잠금 제한 단위 없음",      ["--lock-timeout", "3"]],
    ["재시도 음수",              ["--retries", "-1"]],
    ["재시도 상한 초과",         ["--retries", "11"]],
    ["여유 바이트 비정수",       ["--free-bytes", "1e9"]],
    ["대기 시간 상한 초과",      ["--retry-wait-ms", "600001"]],
    ["대기 상한 비정수",         ["--retry-max-wait-ms", "1.5"]]
  ];
  for (const [name, argv] of rejected) {
    it(`${name}는 거부한다`, () => {
      assert.throws(() => parseArgs(argv), OnlineIndexUsageError);
    });
  }
});

describe("resolveTarget", () => {
  it("--url 을 우선하고 비밀번호는 label 에 담지 않는다", () => {
    const t = resolveTarget({ url: "postgresql://ops:s3cr%40t@db.example.test:35433/work" }, { PGHOST: "other", PGDATABASE: "other" });
    assert.equal(t.config.host, "db.example.test");
    assert.equal(t.config.port, 35433);
    assert.equal(t.config.database, "work");
    assert.equal(t.config.user, "ops");
    assert.equal(t.config.password, "s3cr@t");
    assert.ok(!t.label.includes("s3cr"));
    assert.ok(t.label.includes("db.example.test:35433/work"));
  });

  it("표준 PG 환경변수에서 읽는다", () => {
    const t = resolveTarget({}, { PGHOST: "h", PGPORT: "6000", PGDATABASE: "d", PGUSER: "u", PGPASSWORD: "p" });
    assert.deepEqual(t.config, { host: "h", port: 6000, database: "d", user: "u", password: "p" });
    assert.ok(!t.label.includes("p@"));
  });

  const rejected = [
    ["환경변수가 비어 있음",     {},                                          {}],
    ["PGDATABASE 없음",          {},                                          { PGHOST: "h" }],
    ["PGHOST 없음",              {},                                          { PGDATABASE: "d" }],
    ["postgres 가 아닌 주소",    { url: "http://h/d" },                       {}],
    ["주소 형식 오류",           { url: "not a url" },                        {}],
    ["데이터베이스 이름 없음",   { url: "postgres://h:5432/" },               {}],
    ["쿼리 매개변수(sslmode)",   { url: "postgres://h:5432/d?sslmode=require" }, {}]
  ];
  for (const [name, opts, env] of rejected) {
    it(`${name}는 거부한다`, () => {
      assert.throws(() => resolveTarget(opts, env), OnlineIndexUsageError);
    });
  }

  it("DATABASE_URL 과 POSTGRES_* 환경변수는 대상으로 쓰지 않는다", () => {
    assert.throws(() => resolveTarget({}, { DATABASE_URL: "postgres://h/d", POSTGRES_HOST: "h", POSTGRES_DB: "d" }), OnlineIndexUsageError);
  });
});

describe("resolveFreeBytes", () => {
  it("--free-bytes 가 우선", async () => {
    assert.equal(await resolveFreeBytes({ freeBytes: 5, dataDir: "/x" }, async () => { throw new Error("부르면 안 된다"); }), 5);
  });

  it("--data-dir 은 statfs 의 bsize 와 bavail 로 계산한다", async () => {
    assert.equal(await resolveFreeBytes({ dataDir: "/x" }, async () => ({ bsize: 4096, bavail: 10 })), 40960);
  });

  it("둘 다 없으면 거부한다", async () => {
    await assert.rejects(resolveFreeBytes({}, async () => ({})), OnlineIndexUsageError);
  });

  it("필요 여유는 표 크기의 2배다", () => {
    assert.equal(requiredDiskBytes(150), 300);
  });
});

describe("retryDelayMs", () => {
  const cases = [
    [1, 2000, 30000, 2000], [2, 2000, 30000, 4000], [3, 2000, 30000, 8000],
    [4, 2000, 30000, 16000], [5, 2000, 30000, 30000], [10, 2000, 30000, 30000], [1, 0, 30000, 0], [3, 100, 150, 150]
  ];
  for (const [attempt, base, cap, expected] of cases) {
    it(`시도 ${attempt}, 기본 ${base}, 상한 ${cap} 은 ${expected}`, () => {
      assert.equal(retryDelayMs(attempt, base, cap), expected);
    });
  }
});

describe("planSteps 단계 순서", () => {
  const plan = planSteps({ entries: [ENTRY, UNIQUE_ENTRY], lockTimeout: "3s", retries: 2, targetLabel: "u@h:1/d" });
  const ids  = plan.map(s => s.id);

  it("공통 단계 뒤에 색인마다 같은 순서의 일곱 단계가 이어진다", () => {
    const perIndex = [STEP.DISK_CHECK, STEP.TXN_CHECK, STEP.INSPECT, STEP.DROP_INVALID, STEP.CREATE, STEP.VERIFY, STEP.RETRY];
    assert.deepEqual(ids, [STEP.BACKUP_GATE, STEP.CONNECT, STEP.SESSION, ...perIndex, ...perIndex]);
  });

  it("백업 확인과 연결과 세션 설정이 색인 작업보다 앞선다", () => {
    assert.ok(ids.indexOf(STEP.BACKUP_GATE) < ids.indexOf(STEP.CONNECT));
    assert.ok(ids.indexOf(STEP.CONNECT)     < ids.indexOf(STEP.SESSION));
    assert.ok(ids.indexOf(STEP.SESSION)     < ids.indexOf(STEP.DISK_CHECK));
  });

  it("세션 단계는 lock_timeout 을 설정한다", () => {
    const session = plan.find(s => s.id === STEP.SESSION);
    assert.ok(session.sql.includes("SET lock_timeout='3s'"));
  });

  it("생성 문은 CONCURRENTLY 와 IF NOT EXISTS 를 쓰고 UNIQUE 는 항목 표시를 따른다", () => {
    assert.match(createSql(ENTRY),        /^CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_example_workspace ON agent_memory\.fragments/);
    assert.match(createSql(UNIQUE_ENTRY), /^CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_example_hash ON /);
  });

  it("formatPlan 은 줄마다 번호와 단계 id 로 시작하고 SQL 은 들여쓴다", () => {
    const lines = formatPlan(plan);
    const heads = lines.filter(l => /^\d+\. /.test(l)).map(l => l.split(" ")[1]);
    assert.deepEqual(heads, ids);
  });
});

/** SQL 종류를 보고 응답하는 가짜 클라이언트. */
function fakeClient({ state = "absent", tableName = "fragments", bytes = 1000, creates = [], drops = [], open = { open_count: 0, oldest_seconds: 0 } } = {}) {
  const log   = [];
  const queue = [...creates];
  const dropQueue = [...drops];
  const self  = {
    log,
    get state() { return state; },
    async query(sql) {
      if (sql === INSPECT_SQL) {
        log.push("inspect");
        return state === "absent"
          ? { rows: [] }
          : { rows: [{ valid: state === "valid", table_name: tableName, table_schema: "agent_memory" }] };
      }
      if (sql === TABLE_SIZE_SQL) { log.push("size"); return { rows: [{ bytes: String(bytes) }] }; }
      if (sql === OPEN_TXN_SQL) { log.push("txn"); return { rows: [open] }; }
      if (sql.startsWith("DROP INDEX CONCURRENTLY")) {
        log.push("drop");
        const failure = dropQueue.shift();
        if (failure) throw Object.assign(new Error(failure.message ?? "정리 오류"), { code: failure.code });
        state = "absent";
        return { rows: [] };
      }
      if (sql.startsWith("CREATE ")) {
        log.push("create");
        const behavior = queue.shift() ?? "valid";
        if (typeof behavior === "object") { state = behavior.leave ?? state; throw Object.assign(new Error(behavior.message ?? "오류"), { code: behavior.code }); }
        state = behavior;
        return { rows: [] };
      }
      if (sql.startsWith("SET ")) { log.push("set"); return { rows: [] }; }
      throw new Error(`예상하지 못한 SQL: ${sql}`);
    },
    async end() { log.push("end"); }
  };
  return self;
}

function runBuild(client, overrides = {}) {
  const sleeps = [];
  const opts   = {
    freeBytes: 1_000_000, retries: 2, retryWaitMs: 7, log: () => {},
    sleep: async ms => { sleeps.push(ms); }, ...overrides
  };
  return { sleeps, promise: buildIndexOnline(client, ENTRY, opts) };
}

describe("buildIndexOnline", () => {
  it("없는 색인을 만들고 유효성을 확인한다", async () => {
    const c = fakeClient();
    const { promise } = runBuild(c);
    assert.deepEqual(await promise, { status: "created", attempts: 1 });
    assert.deepEqual(c.log, ["size", "txn", "inspect", "create", "inspect"]);
  });

  it("이미 유효한 색인은 만들거나 제거하지 않는다", async () => {
    const c = fakeClient({ state: "valid" });
    const { promise } = runBuild(c);
    assert.deepEqual(await promise, { status: "exists", attempts: 0 });
    assert.deepEqual(c.log, ["size", "txn", "inspect"]);
  });

  it("남아 있는 무효 색인은 제거한 뒤 만든다", async () => {
    const c = fakeClient({ state: "invalid" });
    const { promise } = runBuild(c);
    assert.equal((await promise).status, "created");
    assert.deepEqual(c.log, ["size", "txn", "inspect", "inspect", "drop", "create", "inspect"]);
  });

  it("만든 뒤 무효이면 제거하고 다시 시도한다", async () => {
    const c = fakeClient({ creates: ["invalid", "valid"] });
    const { promise, sleeps } = runBuild(c);
    assert.deepEqual(await promise, { status: "created", attempts: 2 });
    assert.deepEqual(sleeps, [7]);
    assert.equal(c.log.filter(x => x === "drop").length, 1);
  });

  it("잠금 대기 초과(55P03)는 대기 후 다시 시도한다", async () => {
    const c = fakeClient({ creates: [{ code: "55P03", message: "lock timeout" }, "valid"] });
    const { promise, sleeps } = runBuild(c);
    assert.equal((await promise).attempts, 2);
    assert.deepEqual(sleeps, [7]);
  });

  it("교착(40P01)도 다시 시도한다", async () => {
    const c = fakeClient({ creates: [{ code: "40P01" }, "valid"] });
    assert.equal((await runBuild(c).promise).attempts, 2);
  });

  it("재시도를 모두 쓰면 오류를 던지고 무효 색인을 남기지 않는다", async () => {
    const c = fakeClient({ creates: ["invalid", "invalid", "invalid"] });
    const { promise, sleeps } = runBuild(c);
    await assert.rejects(promise, OnlineIndexBuildError);
    assert.equal(sleeps.length, 2);
    assert.equal(c.state, "absent");
    assert.equal(c.log.filter(x => x === "create").length, 3);
  });

  it("retries 가 0 이면 한 번만 시도하고 대기하지 않는다", async () => {
    const c = fakeClient({ creates: [{ code: "55P03" }] });
    const { promise, sleeps } = runBuild(c, { retries: 0 });
    await assert.rejects(promise, OnlineIndexBuildError);
    assert.deepEqual(sleeps, []);
  });

  it("재시도할 수 없는 오류는 무효 색인을 정리하고 원 오류를 던진다", async () => {
    const c = fakeClient({ creates: [{ code: "23505", message: "중복", leave: "invalid" }] });
    const { promise } = runBuild(c);
    await assert.rejects(promise, err => err.code === "23505" && err.message === "중복");
    assert.equal(c.state, "absent");
  });

  it("유효한 색인은 오류 정리 단계에서도 제거하지 않는다", async () => {
    const c = fakeClient({ creates: [{ code: "55P03", leave: "valid" }] });
    const { promise } = runBuild(c);
    assert.equal((await promise).status, "created");
    assert.ok(!c.log.includes("drop"));
  });

  it("재시도 대기는 두 배씩 늘고 상한으로 잘린다", async () => {
    const c = fakeClient({ creates: ["invalid", "invalid", "invalid", "invalid", "valid"] });
    const { promise, sleeps } = runBuild(c, { retries: 5, retryWaitMs: 1000, retryMaxWaitMs: 3500 });
    assert.equal((await promise).attempts, 5);
    assert.deepEqual(sleeps, [1000, 2000, 3500, 3500]);
  });

  it("생성이 재시도 불가 오류로 실패하고 정리도 실패하면 원 오류를 cause 로 남긴다", async () => {
    const c = fakeClient({ creates: [{ code: "23505", message: "중복", leave: "invalid" }], drops: [{ code: "55P03", message: "정리 잠금" }] });
    const { promise } = runBuild(c);
    await assert.rejects(promise, err => {
      assert.ok(err instanceof OnlineIndexBuildError);
      assert.equal(err.cause.code, "23505");
      assert.match(err.message, /정리 잠금/);
      return true;
    });
  });

  it("생성이 재시도 가능 오류이고 정리가 55P03 으로 실패하면 다음 시도가 정리하고 이어간다", async () => {
    const c = fakeClient({ creates: [{ code: "55P03", leave: "invalid" }, "valid"], drops: [{ code: "55P03" }] });
    const { promise, sleeps } = runBuild(c);
    assert.deepEqual(await promise, { status: "created", attempts: 2 });
    assert.deepEqual(sleeps, [7]);
    assert.equal(c.state, "valid");
    assert.equal(c.log.filter(x => x === "drop").length, 2);
  });

  it("만든 뒤 무효이고 정리가 55P03 이면 재시도로 처리한다", async () => {
    const c = fakeClient({ creates: ["invalid", "valid"], drops: [{ code: "55P03" }] });
    const { promise } = runBuild(c);
    assert.equal((await promise).attempts, 2);
  });

  it("시작 전 정리가 재시도 불가 오류이면 그대로 던진다", async () => {
    const c = fakeClient({ state: "invalid", drops: [{ code: "42501", message: "권한 없음" }] });
    const { promise } = runBuild(c);
    await assert.rejects(promise, err => err.code === "42501");
    assert.ok(!c.log.includes("create"));
  });

  it("재시도를 소진했는데 정리가 계속 실패하면 남은 무효 색인을 알린다", async () => {
    const c = fakeClient({ creates: [{ code: "55P03", leave: "invalid" }], drops: [{ code: "55P03" }, { code: "55P03" }], state: "absent" });
    const { promise } = runBuild(c, { retries: 0 });
    await assert.rejects(promise, err => err instanceof OnlineIndexBuildError && /무효 색인이 남아 있을 수 있/.test(err.message));
  });

  it("열린 트랜잭션이 있으면 수와 경과 시간을 경고하고 계속한다", async () => {
    const lines = [];
    const c = fakeClient({ open: { open_count: 2, oldest_seconds: 4210 } });
    const { promise } = runBuild(c, { log: l => lines.push(l) });
    assert.equal((await promise).status, "created");
    const warning = lines.find(l => l.startsWith("경고"));
    assert.ok(warning.includes("2개") && warning.includes("4210초"));
  });

  it("열린 트랜잭션이 없으면 경고하지 않는다", async () => {
    const lines = [];
    const result = await warnOpenTransactions(fakeClient(), l => lines.push(l));
    assert.deepEqual(result, { openCount: 0, oldestSeconds: 0 });
    assert.deepEqual(lines, []);
  });

  it("디스크 여유가 표 크기의 2배보다 작으면 만들지 않는다", async () => {
    const c = fakeClient({ bytes: 600 });
    const { promise } = runBuild(c, { freeBytes: 1199 });
    await assert.rejects(promise, OnlineIndexPreconditionError);
    assert.ok(!c.log.includes("create"));
  });

  it("디스크 여유가 정확히 2배이면 진행한다", async () => {
    const c = fakeClient({ bytes: 600 });
    const { promise } = runBuild(c, { freeBytes: 1200 });
    assert.equal((await promise).status, "created");
  });

  it("같은 이름의 색인이 다른 표에 있으면 거부한다", async () => {
    const c = fakeClient({ state: "valid", tableName: "fragment_links" });
    const { promise } = runBuild(c);
    await assert.rejects(promise, OnlineIndexPreconditionError);
    assert.ok(!c.log.includes("create"));
  });
});

describe("main 실행 모드", () => {
  function harness(extra = {}) {
    const out = [];
    const err = [];
    const state = { connects: 0, client: null };
    const deps  = {
      out: l => out.push(l), err: l => err.push(l),
      sleep: async () => {},
      connect: async () => { state.connects += 1; state.client = fakeClient(); return state.client; },
      statfs: async () => ({ bsize: 1, bavail: 1_000_000 }),
      ...extra
    };
    return { out, err, state, deps };
  }

  const manifest = writeManifest([
    { name: "idx_example_workspace", table: "fragments", definition: "ON agent_memory.fragments (workspace)" },
    { name: "idx_example_links",     table: "fragment_links", definition: "ON agent_memory.fragment_links (weight)" },
    { name: "idx_baseline_one",      table: "fragments", baseline: true }
  ]);

  it("--dry-run 은 연결하지 않고 단계 순서를 출력한다", async () => {
    const h    = harness();
    const code = await main(["--dry-run", "--index", "idx_example_workspace", "--index", "idx_example_links", "--manifest", manifest], {}, h.deps);
    assert.equal(code, 0);
    assert.equal(h.state.connects, 0);
    const ids = h.out.join("\n").split("\n").filter(l => /^\d+\. /.test(l)).map(l => l.split(" ")[1]);
    const per = [STEP.DISK_CHECK, STEP.TXN_CHECK, STEP.INSPECT, STEP.DROP_INVALID, STEP.CREATE, STEP.VERIFY, STEP.RETRY];
    assert.deepEqual(ids, [STEP.BACKUP_GATE, STEP.CONNECT, STEP.SESSION, ...per, ...per]);
  });

  it("--dry-run 은 --confirm 이 함께 있어도 연결하지 않는다", async () => {
    const h    = harness();
    const code = await main(["--dry-run", "--confirm", "--index", "idx_example_workspace", "--manifest", manifest, "--url", "postgres://h/d"], {}, h.deps);
    assert.equal(code, 0);
    assert.equal(h.state.connects, 0);
  });

  it("--confirm 없는 실제 실행은 거부하고 연결하지 않는다", async () => {
    const h    = harness();
    const code = await main(["--index", "idx_example_workspace", "--manifest", manifest, "--url", "postgres://h/d", "--free-bytes", "1"], {}, h.deps);
    assert.equal(code, 2);
    assert.equal(h.state.connects, 0);
    assert.match(h.err.join("\n"), /--confirm/);
  });

  it("대상이 명시되지 않으면 거부하고 연결하지 않는다", async () => {
    const h    = harness();
    const code = await main(["--confirm", "--index", "idx_example_workspace", "--manifest", manifest, "--free-bytes", "1"], { DATABASE_URL: "postgres://h/d" }, h.deps);
    assert.equal(code, 2);
    assert.equal(h.state.connects, 0);
  });

  it("디스크 여유를 알 수 없으면 거부하고 연결하지 않는다", async () => {
    const h    = harness();
    const code = await main(["--confirm", "--index", "idx_example_workspace", "--manifest", manifest, "--url", "postgres://h/d"], {}, h.deps);
    assert.equal(code, 2);
    assert.equal(h.state.connects, 0);
  });

  it("baseline 항목과 목록에 없는 이름과 --index 누락은 거부한다", async () => {
    for (const idx of [["--index", "idx_baseline_one"], ["--index", "idx_missing"], []]) {
      const h    = harness();
      const code = await main(["--dry-run", ...idx, "--manifest", manifest], {}, h.deps);
      assert.equal(code, 2, idx.join(" "));
    }
  });

  it("실제 실행은 세션 설정을 먼저 보내고 색인을 만든 뒤 연결을 닫는다", async () => {
    const h    = harness();
    const code = await main(["--confirm", "--index", "idx_example_workspace", "--manifest", manifest, "--url", "postgres://h/d", "--free-bytes", "5000"], {}, h.deps);
    assert.equal(code, 0);
    assert.equal(h.state.connects, 1);
    const log = h.state.client.log;
    assert.deepEqual(log.slice(0, 2), ["set", "set"]);
    assert.ok(log.indexOf("create") > 1);
    assert.equal(log.at(-1), "end");
  });

  it("실행 실패는 종료 코드 1 이고 연결을 닫는다", async () => {
    const h = harness({
      connect: async () => { h.state.client = fakeClient({ bytes: 9_000_000 }); return h.state.client; }
    });
    const code = await main(["--confirm", "--index", "idx_example_workspace", "--manifest", manifest, "--url", "postgres://h/d", "--free-bytes", "5000"], {}, h.deps);
    assert.equal(code, 1);
    assert.equal(h.state.client.log.at(-1), "end");
    assert.match(h.err.join("\n"), /디스크 여유/);
  });

  it("--help 는 사용법을 출력한다", async () => {
    const h = harness();
    assert.equal(await main(["--help"], {}, h.deps), 0);
    assert.match(h.out.join("\n"), /--confirm/);
  });
});

describe("작업 목록 검증", () => {
  const base = { name: "idx_ok", table: "fragments", definition: "ON agent_memory.fragments (workspace)" };
  const bad  = [
    ["이름 대문자",                { ...base, name: "Idx_Bad" }],
    ["이름에 공백",                { ...base, name: "idx bad" }],
    ["대형 표가 아님",             { ...base, table: "api_keys", definition: "ON agent_memory.api_keys (id)" }],
    ["definition 없음",            { name: "idx_ok", table: "fragments" }],
    ["definition 이 ON 으로 시작하지 않음", { ...base, definition: "agent_memory.fragments (workspace)" }],
    ["definition 이 다른 표를 가리킴", { ...base, definition: "ON agent_memory.fragment_links (weight)" }],
    ["definition 에 세미콜론",     { ...base, definition: "ON agent_memory.fragments (workspace); DROP TABLE x" }],
    ["definition 에 주석",         { ...base, definition: "ON agent_memory.fragments (workspace) -- x" }],
    ["unique 가 불리언이 아님",    { ...base, unique: "yes" }],
    ["baseline 이 definition 을 가짐", { name: "idx_ok", table: "fragments", baseline: true, definition: "ON agent_memory.fragments (a)" }]
  ];
  for (const [name, entry] of bad) {
    it(`${name}는 거부한다`, () => {
      assert.throws(() => validateManifest({ version: 1, indexes: [entry] }), IndexManifestError);
    });
  }

  it("이름 중복과 형식 오류를 거부한다", () => {
    assert.throws(() => validateManifest({ version: 1, indexes: [base, base] }), IndexManifestError);
    assert.throws(() => validateManifest({ version: 2, indexes: [] }), IndexManifestError);
    assert.throws(() => validateManifest(null), IndexManifestError);
  });

  it("저장소의 작업 목록은 유효하고 baseline 항목은 만들 수 없다", () => {
    const manifest = loadManifest();
    assert.ok(manifest.indexes.length > 0);
    assert.throws(() => findBuildableEntry(manifest, manifest.indexes[0].name), IndexManifestError);
  });
});

describe("구조 검사", () => {
  const files = ["scripts/ops/online-index.mjs", "scripts/ops/online-index-plan.mjs", "scripts/ops/index-manifest.mjs"];

  it("환경 파일 로더와 앱 설정 모듈을 불러오지 않는다", () => {
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      assert.ok(!/dotenv/i.test(text), `${file} 이 dotenv 를 쓴다`);
      assert.ok(!/lib\/config/.test(text), `${file} 이 lib/config 를 쓴다`);
      assert.ok(!/readFileSync\([^)]*\.env/.test(text), `${file} 이 .env 를 읽는다`);
    }
  });

  it("진입점 밖에서 process.env 를 읽지 않는다", () => {
    for (const file of files.filter(f => !f.endsWith("online-index.mjs"))) {
      assert.ok(!/process\.env/.test(fs.readFileSync(path.join(ROOT, file), "utf8")), `${file} 이 process.env 를 읽는다`);
    }
  });
});
