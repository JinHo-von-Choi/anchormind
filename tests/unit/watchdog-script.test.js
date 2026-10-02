/**
 * memento-watchdog.sh 판정 시험
 *
 * 응답을 고정한 로컬 HTTP 서버를 띄우고, 재시작 명령을 파일 기록으로 바꿔
 * 스크립트의 재시작 판정만 본다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import http                            from "node:http";
import fs                              from "node:fs";
import os                              from "node:os";
import path                            from "node:path";
import { execFile, spawn }              from "node:child_process";
import { promisify }                   from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT        = path.resolve(import.meta.dirname, "../../memento-watchdog.sh");
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT, "utf8");
const SERVICE_PORT  = "57332";
const LOCAL_HOSTS   = new Set(["127.0.0.1", "localhost"]);

let routes = {};
let server;
let baseUrl;
let tmpDir;

before(async () => {
  server = http.createServer((req, res) => {
    const code = routes[req.url] ?? 404;
    if (code === "drop") {
      req.socket.destroy();
      return;
    }
    res.statusCode = code;
    res.end(String(code));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
});

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 판정 대상 주소가 로컬 시험 서버인지 확인한다.
 * 비어 있거나 서비스 포트, 로컬이 아닌 호스트면 스크립트를 실행하지 않고 중단한다.
 */
function assertScratchTarget(base) {
  if (!base) {
    throw new Error("MEMENTO_WATCHDOG_BASE_URL 재정의가 없어 시험을 중단한다");
  }
  const url = new URL(base);
  if (url.port === SERVICE_PORT || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`시험 대상이 서비스 주소다: ${base}. 로컬 시험 서버만 허용한다`);
  }
}

/**
 * 스크립트를 한 번 실행하고 재시작 횟수와 상태 파일을 돌려준다.
 *
 * age가 null이면 SERVICE_AGE_SEC를 넘기지 않고, activeEnter가 정의돼 있어야 한다.
 * 두 재정의가 모두 없으면 스크립트가 systemctl을 부르므로 실행하지 않는다.
 * restartCmd에는 $STATE 가 상태 파일 경로로 치환된다.
 */
async function runOnce({
  base = baseUrl, now = 1_000_000, age = 10_000, activeEnter, state = null,
  stateFile = path.join(tmpDir, "state"), lockFile, restartCmd
} = {}) {
  /** 재시작 명령을 바꿀 수 없는 스크립트는 실제 서비스를 재시작하므로 실행하지 않는다. */
  if (!SCRIPT_SOURCE.includes("MEMENTO_WATCHDOG_RESTART_CMD") || !SCRIPT_SOURCE.includes("MEMENTO_WATCHDOG_BASE_URL")) {
    throw new Error("memento-watchdog.sh가 시험용 재정의 변수를 지원하지 않는다");
  }
  assertScratchTarget(base);
  if (age === null && activeEnter === undefined) {
    throw new Error("기동 시각 재정의가 없어 systemctl을 부르게 되므로 시험을 중단한다");
  }
  const restartFile = path.join(tmpDir, "restarts");
  if (state === null) {
    try { fs.rmSync(stateFile, { force: true }); } catch (err) { if (err.code !== "ENOTDIR") throw err; }
  } else {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, state);
  }
  fs.writeFileSync(restartFile, "");
  const env = {
    PATH                            : process.env.PATH,
    MEMENTO_WATCHDOG_BASE_URL       : base,
    MEMENTO_WATCHDOG_STATE_FILE     : stateFile,
    MEMENTO_WATCHDOG_NOW            : String(now),
    MEMENTO_WATCHDOG_RESTART_CMD    : (restartCmd ?? "echo restart >> $RESTART_FILE")
  };
  if (age !== null)             env.MEMENTO_WATCHDOG_SERVICE_AGE_SEC       = String(age);
  if (activeEnter !== undefined) env.MEMENTO_WATCHDOG_ACTIVE_ENTER_TIMESTAMP = activeEnter;
  if (lockFile)                 env.MEMENTO_WATCHDOG_LOCK_FILE             = lockFile;
  env.RESTART_FILE = restartFile;
  env.STATE        = stateFile;
  const { stdout: out } = await execFileAsync("bash", [SCRIPT], { env, encoding: "utf8" });
  const restarts = fs.readFileSync(restartFile, "utf8").split("\n").filter(Boolean).length;
  const saved    = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8").trim() : "";
  return { restarts, out, state: saved, restartLog: fs.readFileSync(restartFile, "utf8") };
}

/**
 * 잠금 파일을 쥔 프로세스를 띄우고 잠금이 잡힐 때까지 기다린다.
 * 돌려주는 객체의 release()는 이 프로세스의 PID에만 신호를 보낸다.
 */
async function holdLock(lockFile) {
  const child = spawn("bash", ["-c", `exec 9>"$1"; flock -n 9 || exit 1; echo locked; exec sleep 30`, "bash", lockFile], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", code => reject(new Error(`잠금 획득 실패 ${code}`)));
  });
  return { release: () => child.kill("SIGTERM") };
}

describe("memento-watchdog.sh", () => {
  it("시험 대상 주소 검사는 서비스 포트와 외부 호스트를 거부한다", () => {
    assert.throws(() => assertScratchTarget(""), /재정의가 없어/);
    assert.throws(() => assertScratchTarget(undefined), /재정의가 없어/);
    assert.throws(() => assertScratchTarget("http://127.0.0.1:57332"), /서비스 주소/);
    assert.throws(() => assertScratchTarget("http://localhost:57332/health"), /서비스 주소/);
    assert.throws(() => assertScratchTarget("https://memento.anchormind.net"), /서비스 주소/);
    assert.doesNotThrow(() => assertScratchTarget("http://127.0.0.1:19100"));
  });

  it("live 200이면 ready가 503이어도 재시작하지 않는다", async () => {
    routes = { "/health/live": 200, "/health/ready": 503, "/health": 503 };
    const r = await runOnce();
    assert.equal(r.restarts, 0);
    assert.match(r.out, /ready 상태 변화: none -> 503/);
  });

  it("구버전 서버(/health/live 404)가 /health 503을 주면 살아 있는 것으로 본다", async () => {
    routes = { "/health": 503 };
    assert.equal((await runOnce()).restarts, 0);
  });

  it("연결이 거부되면 재시작한다", async () => {
    const r = await runOnce({ base: "http://127.0.0.1:1" });
    assert.equal(r.restarts, 1);
    assert.match(r.state, /^1 1000000 /);
  });

  it("기동 유예 안에서는 재시작하지 않는다", async () => {
    assert.equal((await runOnce({ base: "http://127.0.0.1:1", age: 30 })).restarts, 0);
  });

  it("연속 재시작은 지수 간격으로 늦춘다", async () => {
    const base = "http://127.0.0.1:1";
    assert.equal((await runOnce({ base, now: 1_000_030, state: "1 1000000 none" })).restarts, 0, "1회 뒤 60초 미만");
    assert.equal((await runOnce({ base, now: 1_000_060, state: "1 1000000 none" })).restarts, 1, "1회 뒤 60초 경과");
    assert.equal((await runOnce({ base, now: 1_000_100, state: "2 1000000 none" })).restarts, 0, "2회 뒤 120초 미만");
    assert.equal((await runOnce({ base, now: 1_001_800, state: "9 1000000 none" })).restarts, 1, "상한 1800초");
  });

  it("live가 회복되면 연속 횟수를 0으로 되돌린다", async () => {
    routes = { "/health/live": 200, "/health/ready": 200 };
    const r = await runOnce({ state: "3 1000000 503" });
    assert.match(r.state, /^0 1000000 200$/);
  });

  it("live가 500 또는 503이면 재시작한다", async () => {
    routes = { "/health/live": 500 };
    assert.equal((await runOnce()).restarts, 1);
    routes = { "/health/live": 503, "/health": 200 };
    assert.equal((await runOnce()).restarts, 1);
  });

  it("live가 404이고 /health 응답이 끊기면 재시작한다", async () => {
    routes = { "/health": "drop" };
    const r = await runOnce();
    assert.equal(r.restarts, 1);
    assert.match(r.out, /live=404/);
  });

  describe("상태 파일", () => {
    const dead = "http://127.0.0.1:1";

    for (const [name, content] of [
      ["숫자가 아닌 값", "abc def ghi"],
      ["잘린 파일", "3"],
      ["빈 파일", ""],
      ["ready 코드 누락", "3 1000000"],
      ["ready 코드 형식 오류", "3 1000000 xyz"],
      ["필드 초과", "3 1000000 200 extra"]
    ]) {
      it(`손상(${name})이면 이력 없음으로 두되 한 번의 대기 구간 안에서는 재시작하지 않는다`, async () => {
        const first = await runOnce({ base: dead, now: 1_000_000, state: content });
        assert.equal(first.restarts, 0);
        assert.match(first.state, /^1 1000000 none$/, "안전한 형식으로 다시 기록");
        const early = await runOnce({ base: dead, now: 1_000_030, state: first.state });
        assert.equal(early.restarts, 0);
        const later = await runOnce({ base: dead, now: 1_000_060, state: first.state });
        assert.equal(later.restarts, 1);
      });
    }

    it("손상된 상태 파일은 건강한 상태보다 재시작을 늘리지 않는다", async () => {
      const healthy = await runOnce({ base: dead, now: 1_000_030, state: "1 1000000 none" });
      const corrupt = await runOnce({ base: dead, now: 1_000_030, state: "x" });
      assert.ok(corrupt.restarts <= healthy.restarts);
    });

    it("앞자리 0이 있어도 십진수로 읽는다", async () => {
      const r = await runOnce({ base: dead, now: 1_010_000, state: "08 001000000 none" });
      assert.equal(r.restarts, 1);
      assert.match(r.state, /^9 1010000 none$/);
    });

    it("상태 파일이 없으면 이력 없음으로 바로 재시작한다", async () => {
      assert.equal((await runOnce({ base: dead, state: null })).restarts, 1);
    });

    it("상태 디렉터리가 없으면 만들고 기록한다", async () => {
      const stateFile = path.join(tmpDir, "missing", "nested", "state");
      fs.rmSync(path.join(tmpDir, "missing"), { recursive: true, force: true });
      const r = await runOnce({ base: dead, stateFile, state: null });
      assert.equal(r.restarts, 1);
      assert.match(r.state, /^1 1000000 none$/);
    });

    it("상태를 기록할 수 없으면 재시작하지 않고 사유를 남긴다", async () => {
      const blocker   = path.join(tmpDir, "not-a-dir");
      fs.writeFileSync(blocker, "x");
      const stateFile = path.join(blocker, "state");
      const r         = await runOnce({ base: dead, stateFile, state: null, lockFile: path.join(tmpDir, "own.lock") });
      assert.equal(r.restarts, 0);
      assert.match(r.out, /상태 파일 기록 실패/);
    });

    it("재시작 명령이 실행되는 시점에 새 상태가 이미 기록돼 있다", async () => {
      const seen = path.join(tmpDir, "seen");
      fs.rmSync(seen, { force: true });
      const r = await runOnce({ base: dead, now: 1_000_000, state: "2 900000 503", restartCmd: `cat $STATE > ${seen}; echo restart >> $RESTART_FILE` });
      assert.equal(r.restarts, 1);
      assert.equal(fs.readFileSync(seen, "utf8").trim(), "3 1000000 503");
    });

    it("상태 기록은 임시 파일을 남기지 않는다", async () => {
      const dir = path.join(tmpDir, "clean");
      fs.rmSync(dir, { recursive: true, force: true });
      await runOnce({ base: dead, stateFile: path.join(dir, "state"), state: null });
      assert.deepEqual(fs.readdirSync(dir).filter(f => f !== "state.lock").sort(), ["state"]);
    });
  });

  describe("중복 실행", () => {
    it("잠금이 잡혀 있으면 아무것도 하지 않고 종료한다", async () => {
      const lockFile = path.join(tmpDir, "held.lock");
      const holder   = await holdLock(lockFile);
      try {
        const r = await runOnce({ base: "http://127.0.0.1:1", lockFile, state: null });
        assert.equal(r.restarts, 0);
        assert.equal(r.out, "");
        assert.equal(r.state, "", "상태도 건드리지 않는다");
      } finally {
        holder.release();
      }
    });

    it("잠금이 풀리면 다시 판정한다", async () => {
      const lockFile = path.join(tmpDir, "free.lock");
      const holder   = await holdLock(lockFile);
      holder.release();
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal((await runOnce({ base: "http://127.0.0.1:1", lockFile, state: null })).restarts, 1);
    });
  });

  describe("기동 시각", () => {
    const dead = "http://127.0.0.1:1";

    it("ActiveEnterTimestamp가 비어 있으면 자정 직후에도 기동 직후로 보지 않는다", async () => {
      const { stdout } = await execFileAsync("date", ["-d", "", "+%s"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
      const midnight   = Number(stdout.trim());
      const r          = await runOnce({ base: dead, now: midnight + 30, age: null, activeEnter: "" });
      assert.equal(r.restarts, 1);
    });

    it("ActiveEnterTimestamp가 유예 안이면 재시작하지 않는다", async () => {
      const r = await runOnce({ base: dead, now: 1_000_000, age: null, activeEnter: "@999950" });
      assert.equal(r.restarts, 0);
      assert.match(r.out, /기동 50초 경과/);
    });

    it("시계가 뒤로 가서 경과 시간이 음수이면 유예가 끝난 것으로 본다", async () => {
      assert.equal((await runOnce({ base: dead, age: -50 })).restarts, 1);
      assert.equal((await runOnce({ base: dead, now: 1_000_000, age: null, activeEnter: "@1000500" })).restarts, 1);
    });

    it("마지막 재시작 이후 경과 시간이 음수이면 대기가 끝난 것으로 본다", async () => {
      const r = await runOnce({ base: dead, now: 1_000_000, state: "3 1005000 none" });
      assert.equal(r.restarts, 1);
    });
  });
});
