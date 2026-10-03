/**
 * anchormind hook이 작업 디렉터리의 .env를 읽지 않는지 보는 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 하네스는 훅을 작업 중인 저장소를 cwd로 두고 실행한다. 저장소의 .env에 서버 주소와 키를 적어 두어도 hook이 그
 * 주소로 요청하지 않고, .env 파일을 열지도 않는지 하위 프로세스로 확인한다. 파일 읽기는 fs를 감싸는 사전 적재
 * 모듈로 기록한다. hook 모듈의 정적 import 그래프에 lib/config.js와 dotenv가 없는지도 본다.
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import http                            from "node:http";
import { spawn }                       from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import os                              from "node:os";
import path                            from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BIN  = path.join(ROOT, "bin", "memento.js");

/** 요청을 세는 서버 */
function countingServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization ?? null, body });
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end("{\"accepted\":true}");
    });
  });
  return { server, seen };
}

const listen = (server) => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

let dir;
let hostile;
let benign;
let hostilePort;
let benignPort;

before(async () => {
  dir     = mkdtempSync(path.join(os.tmpdir(), "hook-dotenv-"));
  hostile = countingServer();
  benign  = countingServer();
  hostilePort = await listen(hostile.server);
  benignPort  = await listen(benign.server);
  writeFileSync(path.join(dir, ".env"), [
    `MEMENTO_CLI_REMOTE=http://127.0.0.1:${hostilePort}/mcp`,
    "MEMENTO_CLI_KEY=hostile-key-from-dotenv",
    "DOTENV_MARKER=loaded"
  ].join("\n"));
  writeFileSync(path.join(dir, "probe.mjs"), [
    "import fs from \"node:fs\";",
    "import { syncBuiltinESMExports } from \"node:module\";",
    "const log = process.env.HOOK_PROBE_LOG;",
    "const wrap = (name) => { const orig = fs[name]; fs[name] = function (p, ...rest) {",
    "  if (/\\.env$/.test(String(p))) fs.appendFileSync(log, `${name} ${p}\\n`);",
    "  return orig.call(this, p, ...rest); }; };",
    "for (const name of [\"readFileSync\", \"openSync\", \"existsSync\", \"statSync\"]) wrap(name);",
    "syncBuiltinESMExports();"
  ].join("\n"));
});

after(async () => {
  await new Promise(resolve => hostile.server.close(resolve));
  await new Promise(resolve => benign.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

/** cwd를 시험 디렉터리로 두고 hook을 실행한다. MEMENTO_CLI_*와 DOTENV_* 변수는 넘기지 않는다. */
function runHook(extraEnv, input) {
  const log = path.join(dir, `probe-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MEMENTO_CLI_|DOTENV_)/.test(k)));
  Object.assign(env, { HOOK_PROBE_LOG: log, UPDATE_CHECK_DISABLED: "true", ...extraEnv });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", path.join(dir, "probe.mjs"), BIN, "hook", "Stop", "--client", "codex"],
      { cwd: dir, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr, envReads: existsSync(log) ? readFileSync(log, "utf8") : "" }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("anchormind hook과 작업 디렉터리의 .env", () => {
  it("환경 변수에 서버 주소가 없으면 .env의 주소로 보내지 않고 종료 코드 1로 끝나며 .env를 열지 않는다", async () => {
    const r = await runHook({}, { session_id: "s1", last_assistant_message: "작업을 마쳤다" });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /MEMENTO_CLI_REMOTE is required/);
    assert.equal(hostile.seen.length, 0, "작업 디렉터리 .env의 주소로 요청했다");
    assert.equal(r.envReads, "", `.env를 읽었다: ${r.envReads}`);
  });

  it("환경 변수의 주소와 키만 쓰고 .env의 키를 보내지 않는다", async () => {
    const r = await runHook({ MEMENTO_CLI_REMOTE: `http://127.0.0.1:${benignPort}/mcp`, MEMENTO_CLI_KEY: "env-key" },
      { session_id: "s2", last_assistant_message: "작업을 마쳤다" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(hostile.seen.length, 0);
    assert.equal(benign.seen.length, 1);
    assert.equal(benign.seen[0].auth, "Bearer env-key");
    assert.equal(r.envReads, "");
  });

  it("다른 명령은 이전처럼 작업 디렉터리의 .env를 읽는다(사전 적재 모듈이 읽기를 기록한다)", async () => {
    const log = path.join(dir, "probe-other.log");
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MEMENTO_CLI_|DOTENV_)/.test(k)));
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", path.join(dir, "probe.mjs"), BIN, "completion", "bash"],
        { cwd: dir, env: { ...env, HOOK_PROBE_LOG: log, UPDATE_CHECK_DISABLED: "true" }, stdio: "ignore" });
      child.on("close", resolve);
    });
    assert.equal(code, 0);
    assert.match(readFileSync(log, "utf8"), /\.env/);
  });
});

describe("hook 모듈의 정적 import 그래프", () => {
  it("lib/config.js와 dotenv에 닿지 않는다", () => {
    const seen  = new Set();
    const stack = [path.join(ROOT, "lib/cli/hook.js")];
    while (stack.length > 0) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/^\s*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gm)) {
        const spec = m[1];
        assert.ok(!/dotenv/.test(spec), `${path.relative(ROOT, file)}가 ${spec}를 가져온다`);
        if (spec.startsWith(".")) stack.push(path.resolve(path.dirname(file), spec));
      }
    }
    assert.ok(![...seen].some(f => f.endsWith(path.join("lib", "config.js"))), [...seen].map(f => path.relative(ROOT, f)).join(", "));
  });
});
