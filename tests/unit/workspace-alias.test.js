/**
 * workspace 별칭 해석과 입력 검사 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH ??= ".env.test";
process.env.REDIS_ENABLED      ??= "false";

const { resolveWorkspaceAliases }                        = await import("../../lib/keys/workspace-alias.js");
const { normalizeAliasInput, pathTail, WorkspaceAliasError } = await import("../../lib/admin/WorkspaceAliasStore.js");

const aliasesOf = async () => new Map([["/home/u/jobs/proj", "proj"]]);

describe("요청 workspace 별칭 해석", () => {
  it("인자와 일괄 저장 항목의 별칭을 정식 이름으로 바꾸고 바꾼 목록을 돌려준다", async () => {
    const args    = { workspace: "/home/u/jobs/proj", fragments: [{ workspace: "/home/u/jobs/proj" }, { workspace: "other" }, {}] };
    const changed = await resolveWorkspaceAliases(args, "k1", { aliasesOf });
    assert.equal(args.workspace, "proj");
    assert.deepEqual(args.fragments.map((f) => f.workspace), ["proj", "other", undefined]);
    assert.equal(changed.length, 2);
  });

  it("마스터 요청과 workspace 없는 요청은 별칭을 조회하지 않는다", async () => {
    let calls = 0;
    const counting = async () => { calls += 1; return new Map(); };
    await resolveWorkspaceAliases({ workspace: "/home/u/jobs/proj" }, null, { aliasesOf: counting });
    await resolveWorkspaceAliases({ text: "query" }, "k1", { aliasesOf: counting });
    assert.equal(calls, 0);
  });
});

describe("별칭 입력과 경로 판정", () => {
  it("경로형 이름의 마지막 조각만 돌려주고 일반 이름은 null이다", () => {
    assert.equal(pathTail("/home/u/jobs/proj/"), "proj");
    assert.equal(pathTail("C:\\work\\proj"), "proj");
    assert.equal(pathTail("team/proj"), null);
    assert.equal(pathTail("proj"), null);
  });

  it("같은 이름, 빈 이름, 너무 긴 정식 이름은 거부한다", () => {
    assert.deepEqual(normalizeAliasInput(" /a/proj ", "proj"), { alias: "/a/proj", workspace: "proj" });
    assert.deepEqual(normalizeAliasInput("/a/proj", null), { alias: "/a/proj", workspace: null });
    assert.throws(() => normalizeAliasInput("proj", "proj"), WorkspaceAliasError);
    assert.throws(() => normalizeAliasInput("", "proj"), WorkspaceAliasError);
    assert.throws(() => normalizeAliasInput("/a", "x".repeat(129)), WorkspaceAliasError);
  });
});
