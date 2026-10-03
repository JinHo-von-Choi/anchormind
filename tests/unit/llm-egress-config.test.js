/**
 * 외부 전송 정책 설정 판독 시험(자식 프로세스 환경)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { spawnSync }    from "node:child_process";
import path             from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** 주어진 환경으로 lib/config.js를 읽어 로컬 호스트 목록과 설정 문제 이름을 돌려준다. */
function probe(env) {
  const script = `
    const cfg = await import(${JSON.stringify(path.join(ROOT, "lib/config.js"))});
    const issues = cfg.getConfigIssues().filter((i) => i.name === "MEMENTO_EGRESS_LOCAL_HOSTS");
    process.stdout.write(JSON.stringify({ hosts: cfg.EGRESS_LOCAL_HOSTS, issues: issues.map((i) => i.problem) }));`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/nonexistent/egress.env", DOTENV_CONFIG_QUIET: "true", MEMENTO_METRICS_DEFAULT: "off", ...env },
    encoding: "utf8"
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

describe("MEMENTO_EGRESS_LOCAL_HOSTS", () => {
  it("맞을 수 있는 항목만 소문자로 남긴다", () => {
    const { hosts, issues } = probe({ MEMENTO_EGRESS_LOCAL_HOSTS: "GPU-Box, 10.0.0.5 ,[FD00::1]" });
    assert.deepEqual(hosts, ["gpu-box", "10.0.0.5", "[fd00::1]"]);
    assert.deepEqual(issues, []);
  });

  it("포트, 스킴, 대괄호 없는 IPv6 항목은 빼고 설정 문제로 한 번 기록한다", () => {
    const { hosts, issues } = probe({ MEMENTO_EGRESS_LOCAL_HOSTS: "gpu-box:11434,http://ollama,fd00::1,ok-host,[fd00::1]:8000" });
    assert.deepEqual(hosts, ["ok-host"]);
    assert.deepEqual(issues, ["entry_never_matches"]);
  });

  it("미설정이면 빈 목록이고 문제가 없다", () => {
    const { hosts, issues } = probe({});
    assert.deepEqual(hosts, []);
    assert.deepEqual(issues, []);
  });
});
