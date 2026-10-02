/**
 * 액세스 로그의 세션 ID 표기 시험.
 * 실제 logAccess가 기록한 파일을 읽어 세션 ID가 앞 8자로만 남는지 확인한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path             from "node:path";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const { logAccess } = await import("../../lib/logging/audit.js");
const { LOG_DIR }   = await import("../../lib/config.js");

async function readAccessLine(reqPath) {
  const file = path.join(LOG_DIR, `access-${new Date().toISOString().split("T")[0]}.log`);
  const text = await fsp.readFile(file, "utf8");
  return text.split("\n").find((line) => line.includes(reqPath));
}

describe("logAccess 세션 ID 표기", () => {
  it("세션 ID는 앞 8자만 기록한다", async () => {
    const sid     = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
    const reqPath = `/mcp?access-log-test=${process.hrtime.bigint()}`;
    await logAccess("POST", reqPath, sid, 200, 5);
    const line = await readAccessLine(reqPath);
    assert.ok(line, "기록된 줄이 있어야 한다");
    assert.ok(line.includes("| 3f2a1b4c... |"));
    assert.ok(!line.includes(sid));
  });

  it("세션 ID가 없으면 N/A로 기록한다", async () => {
    const reqPath = `/mcp?access-log-none=${process.hrtime.bigint()}`;
    await logAccess("GET", reqPath, null, 400, 1);
    assert.ok((await readAccessLine(reqPath)).includes("| N/A |"));
  });
});
