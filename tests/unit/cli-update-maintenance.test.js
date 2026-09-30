/**
 * CLI 인자 처리, 업데이터 단계 계획, 마이그레이션 점검 스크립트, OpenAPI 도구 목록 구조 검사.
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 */

import { describe, it, afterEach } from "node:test";
import assert            from "node:assert/strict";
import { readFileSync }  from "node:fs";
import { spawnSync }     from "node:child_process";
import path              from "node:path";
import { fileURLToPath } from "node:url";

import { UpdateExecutor } from "../../lib/updater/update-executor.js";
import { buildSpec }      from "../../lib/openapi.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

describe("CLI 인자 처리", () => {
  it("update 명령은 parseArgs 결과를 배열로 다루지 않는다", () => {
    assert.doesNotMatch(read("lib/cli/update.js"), /args\.includes\(/);
  });

  it("cleanup 은 파싱된 include-nli 옵션을 받는다", () => {
    assert.match(read("lib/cli/cleanup.js"), /args\["include-nli"\]/);
  });

  it("inspect 는 현행 컬럼 이름으로 조회한다", () => {
    const src = read("lib/cli/inspect.js");
    assert.match(src, /ema_activation AS ema_score/);
    assert.match(src, /accessed_at AS last_accessed_at/);
  });
});

describe("OpenAPI 도구 목록", () => {
  it("일반 키 목록에 session_rotate 가 있다", () => {
    const names = buildSpec(false, ["read", "write"]).paths["/mcp"].post["x-mcp-tools"].map(t => t.name);
    assert.ok(names.includes("session_rotate"));
  });
});

describe("UpdateExecutor 단계 계획", () => {
  const saved = process.env.UPDATE_REQUIRE_SIGNED_TAG;

  afterEach(() => {
    if (saved === undefined) delete process.env.UPDATE_REQUIRE_SIGNED_TAG;
    else process.env.UPDATE_REQUIRE_SIGNED_TAG = saved;
  });

  it("git status 조회가 실패하면 어떤 명령도 실행하지 않고 중단한다", async () => {
    const cmds = [];
    const ex   = new UpdateExecutor({
      installType: "git", targetVersion: "v2.3.0", projectRoot: "/fake",
      execCommand: (cmd, args) => {
        cmds.push(args);
        if (args.includes("--porcelain")) return Promise.reject(new Error("not a git repository"));
        return Promise.resolve("ok");
      }
    });
    const r = await ex.executeStep("install", { dryRun: false });
    assert.equal(r.success, false);
    assert.match(r.output, /git status/);
    assert.equal(cmds.some(a => a.includes("checkout")), false);
  });

  it("npm-local install 은 목표 버전을 지정한다", async () => {
    const ex = new UpdateExecutor({ installType: "npm-local", targetVersion: "v2.3.0", projectRoot: "/fake", execCommand: () => Promise.resolve("ok") });
    const r  = await ex.executeStep("install", { dryRun: true });
    assert.ok(r.commands.some(c => c.cmd === "npm" && c.args.includes("anchormind-mcp@2.3.0")));
  });

  it("UPDATE_REQUIRE_SIGNED_TAG=true 일 때만 태그 서명 확인 단계를 넣는다", async () => {
    const ex = new UpdateExecutor({ installType: "git", targetVersion: "v2.3.0", projectRoot: "/fake", execCommand: () => Promise.resolve("ok") });

    delete process.env.UPDATE_REQUIRE_SIGNED_TAG;
    let r = await ex.executeStep("install", { dryRun: true });
    assert.equal(r.commands.some(c => c.args.includes("verify-tag")), false);

    process.env.UPDATE_REQUIRE_SIGNED_TAG = "true";
    r = await ex.executeStep("install", { dryRun: true });
    const verify   = r.commands.findIndex(c => c.args.includes("verify-tag"));
    const checkout = r.commands.findIndex(c => c.args.includes("checkout"));
    assert.ok(verify >= 0 && verify < checkout);
  });
});

describe("마이그레이션 점검 스크립트", () => {
  it("기존 파일 전체를 검사하고 위반이 없다", () => {
    const r = spawnSync(process.execPath, ["scripts/lint-migrations.js"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^OK: \d+개 파일 검사 완료/);
  });
});
