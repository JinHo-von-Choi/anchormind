/**
 * LLM CLI 공급자의 도구 승인 방식 시험.
 * 실제 runGeminiCLI, runCopilotCLI, runOpenCodeCLI를 호출하고 child_process만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, mock, afterEach, beforeEach } from "node:test";
import assert                                        from "node:assert/strict";
import { EventEmitter }                              from "node:events";
import fs                                            from "node:fs";
import os                                            from "node:os";
import path                                          from "node:path";

const spawnMock    = mock.fn();
const execFileMock = mock.fn((_cmd, _args, _opts, callback) => callback(null, "--dir\n--pure\n", ""));

mock.module("child_process", {
  namedExports: {
    spawn   : (...args) => spawnMock(...args),
    execFile: (...args) => execFileMock(...args)
  }
});

const { runGeminiCLI }                          = await import("../../lib/gemini.js");
const { runCopilotCLI }                         = await import("../../lib/copilot.js");
const { runOpenCodeCLI }                        = await import("../../lib/opencode.js");
const { cliToolApprovalMode, cliWorkDir, cleanupCliWorkDir } = await import("../../lib/llm/util/cli-approval.js");

const DENY_FLAGS = ["--deny-tool=shell", "--deny-tool=write", "--deny-tool=url", "--disable-builtin-mcps", "--no-custom-instructions"];

function fakeProcess(stdoutText) {
  const proc  = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin  = { write: mock.fn(), end: mock.fn() };
  proc.kill   = mock.fn();
  setImmediate(() => {
    proc.stdout.emit("data", stdoutText);
    proc.emit("close", 0);
  });
  return proc;
}

beforeEach(() => {
  spawnMock.mock.resetCalls();
  spawnMock.mock.mockImplementation(() => fakeProcess("{\"ok\":true}"));
});

const PREVIOUS_APPROVAL = process.env.MEMENTO_LLM_CLI_TOOL_APPROVAL;
const PREVIOUS_TRUST    = process.env.GEMINI_CLI_TRUST_WORKSPACE;

afterEach(() => {
  mock.restoreAll();
  if (PREVIOUS_APPROVAL === undefined) delete process.env.MEMENTO_LLM_CLI_TOOL_APPROVAL;
  else process.env.MEMENTO_LLM_CLI_TOOL_APPROVAL = PREVIOUS_APPROVAL;
  if (PREVIOUS_TRUST === undefined) delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
  else process.env.GEMINI_CLI_TRUST_WORKSPACE = PREVIOUS_TRUST;
});

const lastSpawn = () => spawnMock.mock.calls.at(-1).arguments;

describe("승인 방식 해석", () => {
  it("미설정, 빈 값, 허용 밖의 값은 none이다", () => {
    assert.equal(cliToolApprovalMode(), "none");
    for (const raw of ["", "  ", "ALL", "yes", "true", "1", "none "]) {
      process.env.MEMENTO_LLM_CLI_TOOL_APPROVAL = raw;
      assert.equal(cliToolApprovalMode(), "none", JSON.stringify(raw));
    }
  });

  it("all과 none은 호출 시점의 값을 따른다", () => {
    process.env.MEMENTO_LLM_CLI_TOOL_APPROVAL = "all";
    assert.equal(cliToolApprovalMode(), "all");
    process.env.MEMENTO_LLM_CLI_TOOL_APPROVAL = "none";
    assert.equal(cliToolApprovalMode(), "none");
  });

  it("작업 디렉터리는 비어 있는 임시 디렉터리이고 호출마다 같은 경로를 돌려준다", () => {
    const dir = cliWorkDir();
    assert.ok(path.basename(dir).startsWith("memento-llm-cli-"));
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(cliWorkDir(), dir);
  });
});

describe("기본(none)", () => {
  it("gemini는 -y 없이 빈 작업 디렉터리에서 실행한다", async () => {
    await runGeminiCLI("ctx", "p");
    const [cmd, args, opts] = lastSpawn();
    assert.equal(cmd, "gemini");
    assert.equal(args.includes("-y"), false);
    assert.equal(opts.cwd, cliWorkDir());
  });

  it("gemini는 임시 작업 디렉터리를 신뢰 작업 공간으로 지정하고 인자로 신뢰 옵션을 넘기지 않는다", async () => {
    await runGeminiCLI("ctx", "p");
    const [, args, opts] = lastSpawn();
    assert.equal(opts.env.GEMINI_CLI_TRUST_WORKSPACE, "true");
    assert.equal(args.includes("--skip-trust"), false);
  });

  it("copilot은 쓰기, 셸, URL 도구를 거부하는 규칙을 붙인다", async () => {
    await runCopilotCLI("p");
    const [, args, opts] = lastSpawn();
    for (const flag of DENY_FLAGS) {
      assert.ok(args.includes(flag), flag);
    }
    assert.equal(opts.cwd, cliWorkDir());
  });

  it("copilot의 비대화형 실행 인자는 유지하고 거부 규칙이 허용 규칙보다 우선하도록 함께 넘긴다", async () => {
    await runCopilotCLI("p", { effort: "medium" });
    const args = lastSpawn()[1];
    assert.deepEqual(args.slice(0, 6), ["-p", "p", "--output-format", "text", "--effort", "medium"]);
    assert.ok(args.includes("--allow-all-tools"));
  });

  it("opencode는 모든 권한을 거부하는 OPENCODE_PERMISSION을 넘긴다", async () => {
    await runOpenCodeCLI("p", {});
    const [, args, opts] = lastSpawn();
    assert.deepEqual(JSON.parse(opts.env.OPENCODE_PERMISSION), { "*": "deny" });
    assert.equal(args[args.indexOf("--dir") + 1], cliWorkDir());
  });

  it("opencode는 호출자가 지정한 작업 디렉터리를 그대로 쓰고 권한 거부는 유지한다", async () => {
    await runOpenCodeCLI("p", { cwd: "/tmp/explicit" });
    const [, args, opts] = lastSpawn();
    assert.equal(args[args.indexOf("--dir") + 1], "/tmp/explicit");
    assert.deepEqual(JSON.parse(opts.env.OPENCODE_PERMISSION), { "*": "deny" });
    assert.equal(opts.cwd, cliWorkDir());
  });

  it("opencode의 자식 프로세스 작업 디렉터리는 --dir 지원 여부와 무관하게 임시 디렉터리다", async () => {
    await runOpenCodeCLI("p", {});
    assert.equal(lastSpawn()[2].cwd, cliWorkDir());
  });

  it("사용자 입력은 프롬프트 인자 한 곳에만 들어가고 작업 디렉터리는 고정이다", async () => {
    const hostile = "--allow-all-tools;$(id)";
    await runGeminiCLI(hostile, hostile);
    await runCopilotCLI(hostile);
    await runOpenCodeCLI(hostile, {});
    assert.equal(spawnMock.mock.calls.length, 3);
    for (const call of spawnMock.mock.calls) {
      const [, args, opts] = call.arguments;
      assert.equal(args.filter((a) => a === hostile).length, 1);
      assert.equal(opts.cwd, cliWorkDir());
    }
  });
});

describe("MEMENTO_LLM_CLI_TOOL_APPROVAL=all", () => {
  beforeEach(() => { process.env.MEMENTO_LLM_CLI_TOOL_APPROVAL = "all"; });

  it("gemini는 -y와 서버 작업 디렉터리로 실행하고 신뢰 변수를 더하지 않는다", async () => {
    delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
    await runGeminiCLI("ctx", "p", { model: "m" });
    const [, args, opts] = lastSpawn();
    assert.deepEqual(args, ["-p", "p", "--output-format", "text", "-y", "--model", "m"]);
    assert.equal(opts.cwd, undefined);
    assert.equal(opts.env.GEMINI_CLI_TRUST_WORKSPACE, undefined);
  });

  it("copilot은 거부 규칙 없이 서버 작업 디렉터리로 실행한다", async () => {
    await runCopilotCLI("p", { effort: "low" });
    const [, args, opts] = lastSpawn();
    assert.deepEqual(args, ["-p", "p", "--output-format", "text", "--effort", "low", "--allow-all-tools"]);
    assert.equal(opts.cwd, undefined);
  });

  it("opencode는 권한 환경 변수 없이 서버 작업 디렉터리로 실행한다", async () => {
    await runOpenCodeCLI("p", {});
    const [, args, opts] = lastSpawn();
    assert.deepEqual(args, ["run", "--format", "default", "--dir", process.cwd(), "--pure", "p"]);
    assert.equal(opts.env.OPENCODE_PERMISSION, undefined);
    assert.equal(opts.cwd, undefined);
  });
});

describe("작업 디렉터리 정리", () => {
  it("정리 중 삭제가 실패해도 예외를 던지지 않는다", () => {
    const dir = cliWorkDir();
    mock.method(fs, "rmSync", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    const write = mock.method(process.stderr, "write", () => true);
    assert.doesNotThrow(() => cleanupCliWorkDir());
    assert.equal(write.mock.calls.length, 1);
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("정리하면 디렉터리가 사라지고 다음 호출은 새 디렉터리를 만든다", () => {
    const dir = cliWorkDir();
    cleanupCliWorkDir();
    assert.equal(fs.existsSync(dir), false);
    const next = cliWorkDir();
    assert.ok(fs.existsSync(next));
    cleanupCliWorkDir();
  });
});
