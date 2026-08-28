import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, COMMON_OPTS, COMMAND_COUNT } from "../../lib/cli/completion.js";

// completion() 은 process.stdout.write / process.exit 를 호출하므로
// 출력만 캡처하는 helper로 테스트한다.

/**
 * completion(args)를 실행하고 stdout 출력을 반환한다.
 * process.exit(1) 을 throw 로 대체하여 테스트 프로세스가 종료되지 않도록 한다.
 */
async function captureCompletion(shellArg) {
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalExit  = process.exit.bind(process);

  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  process.exit         = (code) => { throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code }); };

  try {
    const { default: completion } = await import("../../lib/cli/completion.js");
    completion({ _: [shellArg] });
    return { output: chunks.join(""), exitCode: 0 };
  } catch (err) {
    return { output: chunks.join(""), exitCode: err.exitCode ?? 1, error: err.message };
  } finally {
    process.stdout.write = originalWrite;
    process.exit         = originalExit;
  }
}

describe("completion — L6 shell completion", () => {
  // ── 서브명령 / 플래그 메타데이터 ──────────────────────────────
  it("COMMANDS 배열에 15개 서브명령이 포함된다", () => {
    assert.strictEqual(COMMAND_COUNT, 15);
    assert.strictEqual(COMMANDS.length, 15);
  });

  it("자동완성 목록이 bin/memento.js 디스패치 목록과 일치한다", () => {
    const required = [
      "serve", "migrate", "cleanup", "backfill", "stats", "health", "recall",
      "remember", "inspect", "update", "export", "import", "completion",
      "session", "benchmark",
    ];
    for (const cmd of required) {
      assert.ok(COMMANDS.includes(cmd), `COMMANDS에 ${cmd} 누락`);
    }
  });

  it("COMMANDS 에 completion 자신이 포함된다", () => {
    assert.ok(COMMANDS.includes("completion"));
  });

  it("COMMON_OPTS 에 핵심 플래그가 포함된다", () => {
    const required = ["--help", "-h", "--format", "--json", "--remote", "--key", "--timeout"];
    for (const opt of required) {
      assert.ok(COMMON_OPTS.includes(opt), `COMMON_OPTS에 ${opt} 누락`);
    }
  });

  // ── bash 스크립트 ─────────────────────────────────────────────
  it("bash 인자 → _memento_mcp_complete 함수 정의가 포함된다", async () => {
    const { output, exitCode } = await captureCompletion("bash");
    assert.strictEqual(exitCode, 0);
    assert.ok(output.includes("_memento_mcp_complete"), "함수 정의 누락");
  });

  it("bash 인자 → complete -F 지시어가 포함된다", async () => {
    const { output, exitCode } = await captureCompletion("bash");
    assert.strictEqual(exitCode, 0);
    assert.ok(output.includes("complete -F _memento_mcp_complete memento-mcp"), "complete -F 지시어 누락");
  });

  it("bash 스크립트에 서브명령 목록이 포함된다", async () => {
    const { output } = await captureCompletion("bash");
    for (const cmd of ["serve", "migrate", "recall", "completion"]) {
      assert.ok(output.includes(cmd), `bash 스크립트에 서브명령 "${cmd}" 누락`);
    }
  });

  // ── zsh 스크립트 ─────────────────────────────────────────────
  it("zsh 인자 → bash 호환 스크립트가 출력된다", async () => {
    const { output, exitCode } = await captureCompletion("zsh");
    assert.strictEqual(exitCode, 0);
    assert.ok(output.includes("_memento_mcp_complete"), "함수 정의 누락");
    assert.ok(output.includes("complete -F _memento_mcp_complete memento-mcp"), "complete -F 지시어 누락");
  });

  it("zsh 스크립트에 bashcompinit 로드 지시어가 포함된다", async () => {
    const { output } = await captureCompletion("zsh");
    assert.ok(output.includes("bashcompinit"), "bashcompinit 누락");
  });

  // ── 잘못된 shell 인자 ─────────────────────────────────────────
  it("지원하지 않는 shell 인자를 전달하면 exitCode 1을 반환한다", async () => {
    const { exitCode } = await captureCompletion("fish");
    assert.strictEqual(exitCode, 1);
  });
});
