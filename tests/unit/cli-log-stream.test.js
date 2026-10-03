/**
 * CLI 표준 출력 분리 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * CLI 명령은 서버 로거를 불러와도 로그를 표준 오류로 보내 표준 출력에는 명령 결과만 남긴다.
 * 로거의 콘솔 수준 설정은 순수 함수로, 실제 CLI 경로는 하위 프로세스로 확인한다.
 * 하위 프로세스는 DB에 닿지 않는 경로(dry-run 가져오기, 닫힌 포트로의 로컬 remember)만 쓴다.
 */

import { describe, it }      from "node:test";
import assert                from "node:assert/strict";
import { spawnSync }         from "node:child_process";
import fs                    from "node:fs";
import os                    from "node:os";
import path                  from "node:path";
import { fileURLToPath }     from "node:url";

import { consoleStderrLevels } from "../../lib/logger.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN  = path.join(ROOT, "bin", "memento.js");

/** CLI를 하위 프로세스로 실행한다. MEMENTO_LOG_STDERR는 CLI가 정하도록 비워 둔다. */
function runCli(args, extraEnv = {}) {
  const env = {
    ...process.env,
    DOTENV_CONFIG_PATH     : path.join(ROOT, ".env.test"),
    MEMENTO_METRICS_DEFAULT: "off",
    REDIS_ENABLED          : "false",
    UPDATE_CHECK_DISABLED  : "true",
    LOG_LEVEL              : "info",
    ...extraEnv
  };
  delete env.MEMENTO_LOG_STDERR;
  return spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 30_000 });
}

describe("consoleStderrLevels", () => {
  it("켜면 모든 수준을 표준 오류로 보낸다", () => {
    assert.deepEqual(new Set(consoleStderrLevels(true)), new Set(["error", "warn", "info", "http", "verbose", "debug", "silly"]));
  });

  it("끄면 표준 오류로 보내는 수준이 없다", () => {
    assert.deepEqual(consoleStderrLevels(false), []);
  });
});

describe("CLI 표준 출력", () => {
  it("import --dry-run --json은 표준 출력에 JSON만 쓰고 로그는 표준 오류로 보낸다", () => {
    const file = path.join(os.tmpdir(), `memento-cli-log-${process.pid}-${Date.now()}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ content: "담당자 메일은 ops-team@example.com 이다", topic: "ops" })}\n`);
    try {
      const out = runCli(["import", "--dry-run", "--json", "--input", file]);
      assert.equal(out.status, 0, out.stderr);
      const summary = JSON.parse(out.stdout);
      assert.equal(summary.imported, 1);
      assert.match(out.stderr, /Winston logger initialized/, "로거가 실제로 적재되었는지 확인한다");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("remember 로컬 모드는 기록에 실패해도 로그를 표준 출력에 쓰지 않는다", () => {
    const out = runCli(
      ["remember", "Redis 포트는 6380으로 운영한다", "--topic", "ops", "--json"],
      { DB_HOST: "127.0.0.1", DB_PORT: "1" }
    );
    assert.equal(out.status, 1);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /Winston logger initialized/);
  });
});
