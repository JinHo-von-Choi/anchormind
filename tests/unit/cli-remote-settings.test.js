/**
 * hook 명령의 원격 설정 출처 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 서버 주소와 키가 언제나 같은 출처의 한 쌍인지(Claude Code 플러그인 userConfig 변수 쌍 또는 MEMENTO_CLI_* 쌍),
 * 그리고 hook 명령이 cwd의 .env를 읽지 않아 저장소의 .env가 셸의 키를 다른 주소로 보내게 할 수 없는지 본다.
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import fs                              from "node:fs";
import http                            from "node:http";
import os                              from "node:os";
import path                            from "node:path";
import { spawn }                       from "node:child_process";
import { fileURLToPath }               from "node:url";

import { resolveHookRemote } from "../../lib/cli/_remoteSettings.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN  = path.join(ROOT, "bin", "memento.js");

const PLUGIN = {
  CLAUDE_PLUGIN_OPTION_SERVER_URL: "https://plugin.example.com/mcp",
  CLAUDE_PLUGIN_OPTION_API_KEY   : "plugin-option-value"
};
const SHELL = {
  MEMENTO_CLI_REMOTE: "https://shell.example.com/mcp",
  MEMENTO_CLI_KEY   : "shell-env-value"
};

describe("resolveHookRemote", () => {
  it("MEMENTO_CLI_REMOTE와 MEMENTO_CLI_KEY 쌍을 읽는다", () => {
    const r = resolveHookRemote({ ...SHELL });
    assert.deepEqual([r.remote, r.key, r.source, r.warning], [SHELL.MEMENTO_CLI_REMOTE, SHELL.MEMENTO_CLI_KEY, "cli", null]);
  });

  it("플러그인 변수가 둘 다 있으면 그 쌍이 셸 쌍보다 앞선다", () => {
    const r = resolveHookRemote({ ...SHELL, ...PLUGIN });
    assert.deepEqual([r.remote, r.key, r.source], [PLUGIN.CLAUDE_PLUGIN_OPTION_SERVER_URL, PLUGIN.CLAUDE_PLUGIN_OPTION_API_KEY, "plugin"]);
  });

  it("플러그인 주소만 있으면 버리고 셸 쌍을 쓰며 경고한다(다른 출처의 키를 그 주소로 보내지 않는다)", () => {
    const r = resolveHookRemote({ ...SHELL, CLAUDE_PLUGIN_OPTION_SERVER_URL: "https://hostile.example.com/mcp" });
    assert.equal(r.remote, SHELL.MEMENTO_CLI_REMOTE);
    assert.equal(r.key, SHELL.MEMENTO_CLI_KEY);
    assert.match(r.warning, /only one of/);
  });

  it("플러그인 키만 있으면 버리고 셸 쌍을 쓰며 경고한다", () => {
    const r = resolveHookRemote({ ...SHELL, CLAUDE_PLUGIN_OPTION_API_KEY: "stray" });
    assert.deepEqual([r.remote, r.key, r.source], [SHELL.MEMENTO_CLI_REMOTE, SHELL.MEMENTO_CLI_KEY, "cli"]);
    assert.ok(r.warning);
  });

  it("빈 문자열은 없는 값으로 본다", () => {
    const r = resolveHookRemote({ CLAUDE_PLUGIN_OPTION_SERVER_URL: "", CLAUDE_PLUGIN_OPTION_API_KEY: "", ...SHELL });
    assert.deepEqual([r.remote, r.key, r.warning], [SHELL.MEMENTO_CLI_REMOTE, SHELL.MEMENTO_CLI_KEY, null]);
    assert.deepEqual([resolveHookRemote({}).remote, resolveHookRemote({}).key], [null, null]);
  });
});

describe("hook 명령과 cwd의 .env", () => {
  const seen = { legit: [], hostile: [] };
  const servers = {};
  let workdir;

  /** 받은 요청의 경로와 Authorization 헤더를 기록하는 서버 */
  function listen(name) {
    const server = http.createServer((req, res) => {
      seen[name].push({ url: req.url, auth: req.headers.authorization });
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ok" } }));
      });
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => { servers[name] = server; resolve(); }));
  }
  const urlOf = (name) => `http://127.0.0.1:${servers[name].address().port}/mcp`;

  /** 셸 환경을 흉내 낸 자식 환경. 시험 실행기의 DOTENV_CONFIG_PATH는 빼서 cwd의 .env가 기본 대상이 되게 한다. */
  function childEnv(extra) {
    const env = { ...process.env, UPDATE_CHECK_DISABLED: "true", ...extra };
    for (const name of ["DOTENV_CONFIG_PATH", "CLAUDE_PLUGIN_OPTION_SERVER_URL", "CLAUDE_PLUGIN_OPTION_API_KEY"]) {
      if (!(name in extra)) delete env[name];
    }
    return env;
  }

  /** bin/memento.js hook SessionStart를 workdir에서 실행한다. */
  function runHook(env) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, "hook", "SessionStart", "--client", "claude-code"], { cwd: workdir, env });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      child.stdout.resume();
      child.on("close", (code) => resolve({ code, stderr }));
      child.stdin.end(JSON.stringify({ session_id: "s-env-1", hook_event_name: "SessionStart", source: "startup" }));
    });
  }

  before(async () => {
    await listen("legit");
    await listen("hostile");
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "anchormind-hook-env-"));
  });

  after(() => {
    for (const server of Object.values(servers)) server.close();
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it("cwd .env의 플러그인 주소는 셸의 주소와 키를 바꾸지 못한다", async () => {
    fs.writeFileSync(path.join(workdir, ".env"), `CLAUDE_PLUGIN_OPTION_SERVER_URL=${urlOf("hostile")}\n`);
    const result = await runHook(childEnv({ MEMENTO_CLI_REMOTE: urlOf("legit"), MEMENTO_CLI_KEY: "SHELLKEY_SENTINEL" }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(seen.hostile.length, 0);
    assert.equal(seen.legit.at(-1).auth, "Bearer SHELLKEY_SENTINEL");
  });

  it("cwd .env의 플러그인 주소와 키 쌍도 읽지 않는다", async () => {
    fs.writeFileSync(path.join(workdir, ".env"),
      `CLAUDE_PLUGIN_OPTION_SERVER_URL=${urlOf("hostile")}\nCLAUDE_PLUGIN_OPTION_API_KEY=DOTENV_KEY\nMEMENTO_CLI_REMOTE=${urlOf("hostile")}\n`);
    const result = await runHook(childEnv({ MEMENTO_CLI_REMOTE: urlOf("legit"), MEMENTO_CLI_KEY: "SHELLKEY_SENTINEL" }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(seen.hostile.length, 0);
    assert.equal(seen.legit.at(-1).auth, "Bearer SHELLKEY_SENTINEL");
  });

  it("프로세스 환경의 플러그인 쌍은 쓰고, 한쪽만 있으면 경고하고 셸 쌍을 쓴다", async () => {
    fs.rmSync(path.join(workdir, ".env"), { force: true });
    const plugin = await runHook(childEnv({
      MEMENTO_CLI_REMOTE: urlOf("hostile"), MEMENTO_CLI_KEY: "SHELLKEY_SENTINEL",
      CLAUDE_PLUGIN_OPTION_SERVER_URL: urlOf("legit"), CLAUDE_PLUGIN_OPTION_API_KEY: "PLUGINKEY_SENTINEL"
    }));
    assert.equal(plugin.code, 0, plugin.stderr);
    assert.equal(seen.legit.at(-1).auth, "Bearer PLUGINKEY_SENTINEL");

    const partial = await runHook(childEnv({
      MEMENTO_CLI_REMOTE: urlOf("legit"), MEMENTO_CLI_KEY: "SHELLKEY_SENTINEL",
      CLAUDE_PLUGIN_OPTION_SERVER_URL: urlOf("hostile")
    }));
    assert.equal(partial.code, 0, partial.stderr);
    assert.match(partial.stderr, /only one of/);
    assert.equal(seen.hostile.length, 0);
    assert.equal(seen.legit.at(-1).auth, "Bearer SHELLKEY_SENTINEL");
  });
});
