/**
 * 온라인 색인 스크립트 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * scripts/ops/online-index.mjs 를 일회용 서버의 전용 데이터베이스에 --url 로 실행한다.
 * 색인 생성, 재실행 시 건너뜀, 이전 시도가 남긴 무효 색인 재구성, 잠금 대기 초과 뒤
 * 재시도, 재시도 소진, 디스크 여유 거부, 확인 플래그 없는 실행 거부를 검사한다.
 * 실행마다 전용 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import fs                           from "node:fs";
import os                           from "node:os";
import path                         from "node:path";
import { spawn }                    from "node:child_process";
import { describe, it, before, after } from "node:test";
import assert                       from "node:assert/strict";
import pg                           from "pg";

const {
  prepareLaneDatabase, dropLaneDatabase, directClientConfig, directQuery, seedFragments
} = await import("./_harness.js");

await prepareLaneDatabase();

const SCRIPT  = path.join(import.meta.dirname, "../../scripts/ops/online-index.mjs");
const CONFIG  = directClientConfig();
const URL_ARG = `postgresql://${CONFIG.user}:${encodeURIComponent(CONFIG.password)}@${CONFIG.host}:${CONFIG.port}/${CONFIG.database}`;
const PLENTY  = "100000000000";

let manifestDir;

/** 작업 목록 파일을 만든다. */
function manifestFor(indexes) {
  const file = path.join(manifestDir, `manifest-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, indexes }));
  return file;
}

/** 스크립트를 실행하고 종료 코드와 출력을 모은다. 출력이 쌓일 때마다 onOutput 을 부른다. */
function runScript(args, { env = {}, onOutput = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child  = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env }, cwd: manifestDir });
    let   output = "";
    const timer  = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`스크립트가 제한 시간 안에 끝나지 않았다:\n${output}`)); }, 60000);
    const take   = chunk => { output += chunk; onOutput(output); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function indexRow(name) {
  const { rows } = await directQuery(
    `SELECT i.indisvalid AS valid, i.indisunique AS "unique", c.oid::int AS oid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1 AND c.relnamespace = 'agent_memory'::regnamespace`, [name]);
  return rows[0] ?? null;
}

/** 다른 연결이 표에 SHARE UPDATE EXCLUSIVE 잠금을 잡고 있게 한다. CONCURRENTLY 문과 충돌한다. */
async function holdTableLock() {
  const client = new pg.Client(CONFIG);
  await client.connect();
  await client.query("BEGIN");
  await client.query("LOCK TABLE agent_memory.fragments IN SHARE UPDATE EXCLUSIVE MODE");
  return {
    async release() {
      try { await client.query("COMMIT"); } finally { await client.end(); }
    }
  };
}

/** 스냅숏을 잡은 채 열려 있는 트랜잭션. CONCURRENTLY 문은 이 트랜잭션이 끝나기를 기다린다. */
async function holdOpenSnapshot() {
  const client = new pg.Client(CONFIG);
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  await client.query("SELECT count(*) FROM agent_memory.fragments");
  return {
    async release() {
      try { await client.query("COMMIT"); } finally { await client.end(); }
    }
  };
}

before(async () => {
  manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-lane-"));
  await seedFragments("online-index", 300);
});

after(async () => {
  try {
    fs.rmSync(manifestDir, { recursive: true, force: true });
  } finally {
    await dropLaneDatabase();
  }
});

describe("online-index 실서버", () => {
  it("색인을 만들고 유효하며, 다시 실행하면 같은 색인을 건너뛴다", async () => {
    const manifest = manifestFor([{ name: "idx_oi_topic", table: "fragments", definition: "ON agent_memory.fragments (topic)" }]);
    const args     = ["--confirm", "--url", URL_ARG, "--manifest", manifest, "--index", "idx_oi_topic", "--free-bytes", PLENTY];

    const first = await runScript(args);
    assert.equal(first.code, 0, first.output);
    const built = await indexRow("idx_oi_topic");
    assert.equal(built.valid, true);

    const second = await runScript(args);
    assert.equal(second.code, 0, second.output);
    assert.match(second.output, /건너뛴다/);
    assert.equal((await indexRow("idx_oi_topic")).oid, built.oid);
  });

  it("UNIQUE 항목은 유일 색인으로 만든다", async () => {
    const manifest = manifestFor([{ name: "uq_oi_hash", table: "fragments", unique: true, definition: "ON agent_memory.fragments (content_hash, agent_id)" }]);
    const result   = await runScript(["--confirm", "--url", URL_ARG, "--manifest", manifest, "--index", "uq_oi_hash", "--free-bytes", PLENTY]);
    assert.equal(result.code, 0, result.output);
    const row = await indexRow("uq_oi_hash");
    assert.equal(row.valid,  true);
    assert.equal(row.unique, true);
  });

  it("이전 시도가 남긴 무효 색인을 제거하고 다시 만든다", async () => {
    await assert.rejects(
      directQuery("CREATE UNIQUE INDEX CONCURRENTLY idx_oi_leftover ON agent_memory.fragments (topic)"),
      err => err.code === "23505"
    );
    assert.equal((await indexRow("idx_oi_leftover")).valid, false);

    const manifest = manifestFor([{ name: "idx_oi_leftover", table: "fragments", definition: "ON agent_memory.fragments (topic, type)" }]);
    const result   = await runScript(["--confirm", "--url", URL_ARG, "--manifest", manifest, "--index", "idx_oi_leftover", "--free-bytes", PLENTY]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /무효 색인 idx_oi_leftover 을 제거한다/);
    const row = await indexRow("idx_oi_leftover");
    assert.equal(row.valid,  true);
    assert.equal(row.unique, false);
  });

  it("잠금 대기 제한을 넘으면 재시도하고, 잠금이 풀리면 만든다", async () => {
    const manifest = manifestFor([{ name: "idx_oi_retry", table: "fragments", definition: "ON agent_memory.fragments (importance)" }]);
    const lock     = await holdTableLock();
    let   released = false;
    let   result;
    try {
      result = await runScript(
        ["--confirm", "--url", URL_ARG, "--manifest", manifest, "--index", "idx_oi_retry", "--free-bytes", PLENTY,
         "--lock-timeout", "300ms", "--retries", "10", "--retry-wait-ms", "200", "--retry-max-wait-ms", "400"],
        {
          onOutput: output => {
            if (!released && output.includes("55P03")) { released = true; lock.release().catch(() => {}); }
          }
        }
      );
    } finally {
      if (!released) await lock.release();
    }
    assert.equal(result.code, 0, result.output);
    assert.ok(released, "잠금 대기 초과가 관찰되지 않았다");
    assert.equal((await indexRow("idx_oi_retry")).valid, true);
  });

  it("재시도를 모두 쓰면 종료 코드 1 이고 색인을 남기지 않는다", async () => {
    const manifest = manifestFor([{ name: "idx_oi_exhaust", table: "fragments", definition: "ON agent_memory.fragments (access_count)" }]);
    const lock     = await holdTableLock();
    let   result;
    try {
      result = await runScript(["--confirm", "--url", URL_ARG, "--manifest", manifest, "--index", "idx_oi_exhaust", "--free-bytes", PLENTY,
                                "--lock-timeout", "200ms", "--retries", "1", "--retry-wait-ms", "50"]);
    } finally {
      await lock.release();
    }
    assert.equal(result.code, 1, result.output);
    assert.equal(await indexRow("idx_oi_exhaust"), null);
  });

  it("열린 트랜잭션이 있으면 경고하고, 끝나면 만든다", async () => {
    const manifest = manifestFor([{ name: "idx_oi_snapshot", table: "fragments", definition: "ON agent_memory.fragments (created_at)" }]);
    const args     = ["--confirm", "--url", URL_ARG, "--manifest", manifest, "--index", "idx_oi_snapshot", "--free-bytes", PLENTY,
                      "--lock-timeout", "300ms", "--retries", "1", "--retry-wait-ms", "50"];
    const snapshot = await holdOpenSnapshot();
    let   blocked;
    try {
      blocked = await runScript(args);
    } finally {
      await snapshot.release();
    }
    assert.equal(blocked.code, 1, blocked.output);
    assert.match(blocked.output, /경고: 열려 있는 트랜잭션 \d+개/);
    /** 열린 트랜잭션은 무효 색인의 제거도 막으므로 무효 색인이 남을 수 있다. 유효한 색인은 남지 않는다. */
    const leftover = await indexRow("idx_oi_snapshot");
    assert.ok(leftover === null || leftover.valid === false);
    if (leftover !== null) assert.match(blocked.output, /무효 색인이 남아 있을 수 있/);

    const after = await runScript(args);
    assert.equal(after.code, 0, after.output);
    assert.doesNotMatch(after.output, /경고: 열려 있는 트랜잭션/);
    assert.equal((await indexRow("idx_oi_snapshot")).valid, true);
  });

  it("디스크 여유가 표 크기의 2배보다 작으면 만들지 않는다", async () => {
    const manifest = manifestFor([{ name: "idx_oi_disk", table: "fragments", definition: "ON agent_memory.fragments (id)" }]);
    const result   = await runScript(["--confirm", "--url", URL_ARG, "--manifest", manifest, "--index", "idx_oi_disk", "--free-bytes", "1"]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /디스크 여유가 부족하다/);
    assert.equal(await indexRow("idx_oi_disk"), null);
  });

  it("--confirm 없이는 실행하지 않고, 대상이 명시되지 않아도 실행하지 않는다", async () => {
    const manifest = manifestFor([{ name: "idx_oi_refused", table: "fragments", definition: "ON agent_memory.fragments (id)" }]);

    const noConfirm = await runScript(["--url", URL_ARG, "--manifest", manifest, "--index", "idx_oi_refused", "--free-bytes", PLENTY]);
    assert.equal(noConfirm.code, 2, noConfirm.output);

    const noTarget = await runScript(["--confirm", "--manifest", manifest, "--index", "idx_oi_refused", "--free-bytes", PLENTY],
      { env: { DATABASE_URL: URL_ARG } });
    assert.equal(noTarget.code, 2, noTarget.output);

    assert.equal(await indexRow("idx_oi_refused"), null);
  });

  it("표준 PG 환경변수로 대상을 받는다", async () => {
    const manifest = manifestFor([{ name: "idx_oi_pgenv", table: "case_events", definition: "ON agent_memory.case_events (case_id, created_at)" }]);
    const result   = await runScript(["--confirm", "--manifest", manifest, "--index", "idx_oi_pgenv", "--free-bytes", PLENTY], {
      env: {
        PGHOST: CONFIG.host, PGPORT: String(CONFIG.port), PGDATABASE: CONFIG.database,
        PGUSER: CONFIG.user, PGPASSWORD: CONFIG.password
      }
    });
    assert.equal(result.code, 0, result.output);
    assert.equal((await indexRow("idx_oi_pgenv")).valid, true);
  });

  it("--dry-run 은 서버에 닿지 않는다", async () => {
    const manifest = manifestFor([{ name: "idx_oi_dry", table: "fragments", definition: "ON agent_memory.fragments (id)" }]);
    const result   = await runScript(["--dry-run", "--url", "postgresql://nobody:x@127.0.0.1:1/none", "--manifest", manifest, "--index", "idx_oi_dry"]);
    assert.equal(result.code, 0, result.output);
    assert.equal(await indexRow("idx_oi_dry"), null);
  });
});
