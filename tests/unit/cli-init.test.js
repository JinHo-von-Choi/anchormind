/**
 * anchormind init 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 생성 계획의 파일 목록 구조, dry-run이 아무것도 쓰지 않는지, --write와 --force의 덮어쓰기 규칙,
 * API 키가 어떤 파일과 출력에도 들어가지 않는지, init이 .env를 읽는 모듈을 가져오지 않는지 본다.
 * 파일 내용 전체를 고정 문자열과 대조하지 않는다. 쓰기는 시험마다 만든 임시 디렉터리에서만 한다.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert                                  from "node:assert/strict";
import fs                                      from "node:fs";
import os                                      from "node:os";
import path                                    from "node:path";
import { fileURLToPath }                       from "node:url";
import { spawn }                               from "node:child_process";
import { EventEmitter }                        from "node:events";

import init, { planInit, InitError, INIT_TARGETS } from "../../lib/cli/init.js";
import { diffLines }                               from "../../lib/cli/_lineDiff.js";
import { createOutput }                            from "../../lib/cli/_stdout.js";

const ROOT     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SENTINEL = "sentinel-key-value-0123456789abcdef";

/** 임시 디렉터리 안의 init 대상 경로와 출력 기록 */
function makeRun() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "anchormind-init-"));
  const out  = [];
  return {
    base,
    dir : path.join(base, "target"),
    out,
    text: () => out.join(""),
    deps: { stdout: (s) => out.push(s), homedir: () => path.join(base, "home") }
  };
}

/** 디렉터리 아래 모든 파일의 상대 경로 */
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
}

describe("diffLines", () => {
  it("같은 내용은 모두 유지 줄이다", () => {
    assert.deepEqual(diffLines("a\nb", "a\nb").map(d => d.op), [" ", " "]);
  });

  it("빈 원본은 모두 추가 줄이다", () => {
    assert.deepEqual(diffLines("", "a\nb").map(d => d.op), ["+", "+"]);
  });

  it("바뀐 줄만 삭제와 추가로 나타난다", () => {
    const ops = diffLines("a\nb\nc", "a\nx\nc").map(d => `${d.op}${d.line}`);
    assert.deepEqual(ops, [" a", "-b", "+x", " c"]);
  });

  it("삽입과 삭제를 구분한다", () => {
    assert.deepEqual(diffLines("a\nc", "a\nb\nc").filter(d => d.op !== " ").map(d => `${d.op}${d.line}`), ["+b"]);
    assert.deepEqual(diffLines("a\nb\nc", "a\nc").filter(d => d.op !== " ").map(d => `${d.op}${d.line}`), ["-b"]);
  });
});

describe("planInit 파일 목록 구조", () => {
  for (const target of Object.keys(INIT_TARGETS)) {
    it(`${target}: 상대 경로만, 중복 없이, 대상 디렉터리 안에 둔다`, () => {
      const plan  = planInit({ target, dir: "/scratch/x" });
      const paths = plan.files.map(f => f.path);
      assert.ok(paths.length >= 3);
      assert.equal(new Set(paths).size, paths.length);
      for (const p of paths) {
        assert.ok(!path.isAbsolute(p) && !p.split("/").includes(".."), p);
        assert.equal(typeof plan.files.find(f => f.path === p).content, "string");
      }
    });
  }

  it("claude: 마켓플레이스와 플러그인 매니페스트, MCP, 훅, 스킬을 만든다", () => {
    const paths = new Set(planInit({ target: "claude", dir: "/scratch/x" }).files.map(f => f.path));
    for (const p of [
      ".claude-plugin/marketplace.json",
      "plugins/anchormind/.claude-plugin/plugin.json",
      "plugins/anchormind/.mcp.json",
      "plugins/anchormind/hooks/hooks.json",
      "plugins/anchormind/skills/anchormind/SKILL.md"
    ]) assert.ok(paths.has(p), p);
  });

  it("codex: 마켓플레이스와 플러그인 매니페스트, 훅을 만든다", () => {
    const paths = new Set(planInit({ target: "codex", dir: "/scratch/x" }).files.map(f => f.path));
    for (const p of [".agents/plugins/marketplace.json", "plugins/anchormind/plugin.json", "plugins/anchormind/hooks/hooks.json"]) {
      assert.ok(paths.has(p), p);
    }
  });

  it("마켓플레이스의 플러그인 경로가 생성되는 플러그인 매니페스트 디렉터리를 가리킨다", () => {
    const claude = planInit({ target: "claude", dir: "/scratch/x" });
    const cm     = JSON.parse(claude.files.find(f => f.path === ".claude-plugin/marketplace.json").content);
    const cdir   = path.posix.normalize(cm.plugins[0].source);
    assert.ok(claude.files.some(f => f.path === `${cdir}/.claude-plugin/plugin.json`));

    const codex = planInit({ target: "codex", dir: "/scratch/x" });
    const xm    = JSON.parse(codex.files.find(f => f.path === ".agents/plugins/marketplace.json").content);
    const xdir  = path.posix.normalize(xm.plugins[0].source.path);
    assert.ok(codex.files.some(f => f.path === `${xdir}/plugin.json`));
  });

  it("integrations의 플러그인 파일이 모두 계획에 들어간다", () => {
    for (const [target, src] of [["claude", "claude-code"], ["codex", "codex"]]) {
      const planned = new Set(planInit({ target, dir: "/scratch/x" }).files.map(f => f.path));
      for (const rel of listFiles(path.join(ROOT, "integrations", src))) {
        assert.ok(planned.has(`plugins/anchormind/${rel}`), `${target}: ${rel}`);
      }
    }
  });

  it("codex 다음 단계 안내는 주어진 주소와 키 환경 변수 이름을 쓴다", () => {
    const steps = planInit({ target: "codex", dir: "/scratch/x", url: "https://mem.example.org/mcp" }).nextSteps.join("\n");
    assert.match(steps, /https:\/\/mem\.example\.org\/mcp/);
    assert.match(steps, /bearer_token_env_var = "MEMENTO_CLI_KEY"/);
  });

  it("잘못된 대상과 자격 증명이 든 주소를 거부한다", () => {
    assert.throws(() => planInit({ target: "cursor", dir: "/x" }), InitError);
    assert.throws(() => planInit({ target: "codex", dir: "/x", url: "https://user:pw@mem.example.org/mcp" }), InitError);
    assert.throws(() => planInit({ target: "codex", dir: "/x", url: "ftp://mem.example.org/mcp" }), InitError);
  });
});

describe("anchormind init 실행", () => {
  let run;
  beforeEach(() => { run = makeRun(); });
  afterEach(() => fs.rmSync(run.base, { recursive: true, force: true }));

  it("기본은 dry-run이다: 파일을 쓰지 않고 만들 파일과 diff를 출력한다", async () => {
    await init({ _: [], target: "claude", dir: run.dir }, run.deps);
    assert.equal(fs.existsSync(run.dir), false);
    const text = run.text();
    for (const f of planInit({ target: "claude", dir: run.dir }).files) {
      assert.match(text, new RegExp(`create\\s+${f.path.replace(/\./g, "\\.")}`));
      assert.ok(text.includes(`+++ ${f.path}`), f.path);
    }
    assert.match(text, /--write/);
  });

  it("--write는 계획한 파일을 모두 만들고, 다시 실행하면 바뀐 것이 없다", async () => {
    await init({ _: [], target: "codex", dir: run.dir, write: true }, run.deps);
    const planned = planInit({ target: "codex", dir: run.dir }).files.map(f => f.path).sort();
    assert.deepEqual(listFiles(run.dir), planned);

    run.out.length = 0;
    await init({ _: [], target: "codex", dir: run.dir, write: true }, run.deps);
    assert.match(run.text(), /unchanged/);
    assert.doesNotMatch(run.text(), /^\s*create\s/m);
  });

  it("내용이 다른 기존 파일은 --force 없이 덮어쓰지 않고 아무 파일도 쓰지 않는다", async () => {
    const target = path.join(run.dir, "plugins", "anchormind", "plugin.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{\"name\":\"mine\"}\n");

    await assert.rejects(init({ _: [], target: "codex", dir: run.dir, write: true }, run.deps), InitError);
    assert.equal(fs.readFileSync(target, "utf8"), "{\"name\":\"mine\"}\n");
    assert.deepEqual(listFiles(run.dir), ["plugins/anchormind/plugin.json"]);
    assert.match(run.text(), /conflict\s+plugins\/anchormind\/plugin\.json/);
    assert.match(run.text(), /^-\{"name":"mine"\}$/m);

    await init({ _: [], target: "codex", dir: run.dir, write: true, force: true }, run.deps);
    assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).name, "anchormind");
  });

  it("일반 파일이 아닌 경로는 --force로도 쓰지 않는다", async () => {
    fs.mkdirSync(path.join(run.dir, "plugins", "anchormind", "plugin.json"), { recursive: true });
    await assert.rejects(init({ _: [], target: "codex", dir: run.dir, write: true, force: true }, run.deps), InitError);
    assert.deepEqual(listFiles(run.dir), []);
  });

  it("--dir이 없으면 홈 아래 대상별 디렉터리를 쓴다", async () => {
    await init({ _: [], target: "codex" }, run.deps);
    assert.match(run.text(), new RegExp(path.join(run.base, "home", ".anchormind", "codex").replace(/[.\\]/g, "\\$&")));
  });

  it("API 키를 인자로 받지 않는다", async () => {
    await assert.rejects(init({ _: [], target: "claude", dir: run.dir, key: SENTINEL }, run.deps), InitError);
  });

  it("환경의 키가 생성 파일과 출력에 들어가지 않는다", async () => {
    const saved = { a: process.env.MEMENTO_CLI_KEY, b: process.env.CLAUDE_PLUGIN_OPTION_API_KEY };
    process.env.MEMENTO_CLI_KEY              = SENTINEL;
    process.env.CLAUDE_PLUGIN_OPTION_API_KEY = SENTINEL;
    try {
      for (const target of ["claude", "codex"]) {
        const dir = path.join(run.base, target);
        await init({ _: [], target, dir, write: true }, run.deps);
        for (const rel of listFiles(dir)) {
          assert.ok(!fs.readFileSync(path.join(dir, rel), "utf8").includes(SENTINEL), rel);
        }
      }
      assert.ok(!run.text().includes(SENTINEL));
    } finally {
      for (const [name, value] of [["MEMENTO_CLI_KEY", saved.a], ["CLAUDE_PLUGIN_OPTION_API_KEY", saved.b]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});

describe("init 쓰기의 경로와 실패 처리", () => {
  let run;
  beforeEach(() => { run = makeRun(); });
  afterEach(() => fs.rmSync(run.base, { recursive: true, force: true }));

  it("대상 아래 중간 디렉터리가 심볼릭 링크면 그 아래 파일을 쓰지 않는다", async () => {
    const outside = path.join(run.base, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(run.dir);
    fs.symlinkSync(outside, path.join(run.dir, "plugins"), "dir");

    await init({ _: [], target: "claude", dir: run.dir }, run.deps);
    assert.match(run.text(), /blocked\s+plugins\/anchormind\/\.mcp\.json/);

    await assert.rejects(init({ _: [], target: "claude", dir: run.dir, write: true, force: true }, run.deps), InitError);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.existsSync(path.join(run.dir, ".claude-plugin")), false);
  });

  it("쓸 수 없는 위치가 있으면 아무것도 쓰기 전에 실패한다", async () => {
    const denied = { ...fs, accessSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
    await assert.rejects(
      init({ _: [], target: "codex", dir: run.dir, write: true }, { ...run.deps, fs: denied }),
      (err) => err instanceof InitError && /not writable/.test(err.message)
    );
    assert.deepEqual(listFiles(run.base), []);
  });

  it("쓰는 도중 실패하면 이번 실행이 만든 파일을 지우고 바꾼 파일을 되돌린 뒤 InitError를 던진다", async () => {
    const mine = path.join(run.dir, "plugins", "anchormind", ".mcp.json");
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, "mine\n");
    let renames = 0;
    const flaky = {
      ...fs,
      renameSync: (from, to) => {
        renames++;
        if (renames === 4) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return fs.renameSync(from, to);
      }
    };

    await assert.rejects(
      init({ _: [], target: "claude", dir: run.dir, write: true, force: true }, { ...run.deps, fs: flaky }),
      (err) => err instanceof InitError && /ENOSPC/.test(err.message) && /run the command again/.test(err.message)
    );
    assert.deepEqual(listFiles(run.dir), ["plugins/anchormind/.mcp.json"]);
    assert.equal(fs.readFileSync(mine, "utf8"), "mine\n");
  });

  it("PATH에 anchormind가 없으면 경고하고, 있으면 경고하지 않는다", async () => {
    const bin = path.join(run.base, "bin");
    fs.mkdirSync(bin);
    await init({ _: [], target: "codex", dir: run.dir }, { ...run.deps, searchPath: bin, pathExt: "" });
    assert.match(run.text(), /anchormind was not found on PATH/);

    run.out.length = 0;
    fs.writeFileSync(path.join(bin, "anchormind"), "#!/bin/sh\n", { mode: 0o755 });
    await init({ _: [], target: "codex", dir: run.dir }, { ...run.deps, searchPath: bin, pathExt: "" });
    assert.doesNotMatch(run.text(), /not found on PATH/);
  });
});

describe("닫힌 표준 출력", () => {
  it("EPIPE 뒤의 쓰기는 버리고 던지지 않는다. 다른 출력 오류는 다음 쓰기에서 던진다", () => {
    const stream = new EventEmitter();
    const sent   = [];
    stream.write = (t) => sent.push(t);
    const out    = createOutput(stream, { onError: () => {} });
    out.write("a");
    stream.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
    out.write("b");
    assert.deepEqual(sent, ["a"]);
    assert.equal(out.isClosed(), true);

    const other = new EventEmitter();
    other.write = () => {};
    const out2  = createOutput(other, { onError: () => {} });
    other.emit("error", Object.assign(new Error("no space"), { code: "ENOSPC" }));
    assert.throws(() => out2.write("x"), /no space/);
  });

  it("init --write의 출력을 받는 쪽이 닫혀도 파일을 모두 쓰고 종료 코드 0으로 끝난다", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "anchormind-init-pipe-"));
    try {
      const dir   = path.join(base, "target");
      const child = spawn(process.execPath, [path.join(ROOT, "bin", "memento.js"), "init", "--target", "claude", "--dir", dir, "--write"], {
        env: { ...process.env, UPDATE_CHECK_DISABLED: "true" }
      });
      child.stdout.destroy();
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      const code = await new Promise(resolve => child.on("close", resolve));
      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stderr, /EPIPE/);
      assert.deepEqual(listFiles(dir), planInit({ target: "claude", dir }).files.map(f => f.path).sort());
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("init과 .env", () => {
  /** lib 안에서 init.js가 정적으로 가져오는 모듈 전체 */
  function importClosure(entry) {
    const seen  = new Set();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)) {
        if (m[1] === "dotenv" || m[1].startsWith("dotenv/")) throw new Error(`${file} imports ${m[1]}`);
        if (m[1].startsWith(".")) stack.push(path.resolve(path.dirname(file), m[1]));
      }
    }
    return [...seen].map(f => path.relative(ROOT, f));
  }

  it("init이 가져오는 모듈에 lib/config.js와 dotenv가 없다", () => {
    const closure = importClosure(path.join(ROOT, "lib", "cli", "init.js"));
    assert.ok(!closure.includes(path.join("lib", "config.js")), closure.join(", "));
  });

  it("CLI 진입점은 init에서 dotenv를 불러오지 않는다", () => {
    const src = fs.readFileSync(path.join(ROOT, "bin", "memento.js"), "utf8");
    assert.doesNotMatch(src, /^import\s+["']dotenv\/config["']/m);
    assert.match(src, /DOTENV_EXEMPT_COMMANDS\s*=\s*new Set\(\[[^\]]*["']init["']/);
    assert.match(src, /if \(!DOTENV_EXEMPT_COMMANDS\.has\(process\.argv\[2\]\)\) await import\(["']dotenv\/config["']\)/);
  });
});
