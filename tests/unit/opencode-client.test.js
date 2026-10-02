/**
 * Unit tests: low-level OpenCode CLI client.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const execFileMock = mock.fn();
const spawnMock    = mock.fn();

mock.module("child_process", {
  namedExports: {
    execFile: (...args) => execFileMock(...args),
    spawn   : (...args) => spawnMock(...args)
  }
});

const { runOpenCodeCLI } = await import("../../lib/opencode.js");

function createProcess(stdoutText, exitCode = 0) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = mock.fn();
  setImmediate(() => {
    if (stdoutText) proc.stdout.emit("data", stdoutText);
    proc.emit("close", exitCode);
  });
  return proc;
}

describe("runOpenCodeCLI", () => {
  it("opencode run --help로 확인한 flag만 CLI 호출에 포함하고 미지원 variant는 생략한다", async () => {
    execFileMock.mock.mockImplementationOnce((_cmd, _args, _opts, callback) => {
      callback(null, "--agent\n--dir\n--pure\n", "");
    });
    spawnMock.mock.mockImplementationOnce(() => createProcess("{\"ok\":true}"));

    const result = await runOpenCodeCLI("payload", {
      cwd    : "/tmp/memento",
      model  : "github-copilot/claude-sonnet-4.5",
      agent  : "general",
      variant: "high"
    });

    assert.equal(result, "{\"ok\":true}");
    const [cmd, args, options] = spawnMock.mock.calls[0].arguments;
    assert.equal(cmd, "opencode");
    assert.deepEqual(args, [
      "run",
      "--format", "default",
      "--dir", "/tmp/memento",
      "--pure",
      "--model", "github-copilot/claude-sonnet-4.5",
      "--agent", "general",
      "payload"
    ]);
    assert.match(options.cwd, /memento-llm-cli-/);
  });
});
