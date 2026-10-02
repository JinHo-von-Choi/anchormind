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
import { execFile }                    from "node:child_process";
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
 */
async function runOnce({ base = baseUrl, now = 1_000_000, age = 10_000, state = null } = {}) {
  /** 재시작 명령을 바꿀 수 없는 스크립트는 실제 서비스를 재시작하므로 실행하지 않는다. */
  if (!SCRIPT_SOURCE.includes("MEMENTO_WATCHDOG_RESTART_CMD") || !SCRIPT_SOURCE.includes("MEMENTO_WATCHDOG_BASE_URL")) {
    throw new Error("memento-watchdog.sh가 시험용 재정의 변수를 지원하지 않는다");
  }
  assertScratchTarget(base);
  const stateFile   = path.join(tmpDir, "state");
  const restartFile = path.join(tmpDir, "restarts");
  if (state === null) fs.rmSync(stateFile, { force: true });
  else fs.writeFileSync(stateFile, state);
  fs.writeFileSync(restartFile, "");
  const { stdout: out } = await execFileAsync("bash", [SCRIPT], {
    env: {
      PATH                            : process.env.PATH,
      MEMENTO_WATCHDOG_BASE_URL       : base,
      MEMENTO_WATCHDOG_STATE_FILE     : stateFile,
      MEMENTO_WATCHDOG_NOW            : String(now),
      MEMENTO_WATCHDOG_SERVICE_AGE_SEC: String(age),
      MEMENTO_WATCHDOG_RESTART_CMD    : `echo restart >> ${restartFile}`
    },
    encoding: "utf8"
  });
  const restarts = fs.readFileSync(restartFile, "utf8").split("\n").filter(Boolean).length;
  const saved    = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8").trim() : "";
  return { restarts, out, state: saved };
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
});
