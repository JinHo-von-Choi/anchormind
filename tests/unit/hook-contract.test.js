/**
 * 훅 입력 계약 순수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 경로 허용 목록, 본문 상한, JSON 깊이, 헤더 크기, Content-Type, workspace 정규화 표,
 * allowed_workspaces 판정, 멱등 키, 하네스 출력 형식을 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  HOOK_CLIENTS, HOOK_EVENTS, HOOK_LIMITS, HookInputError,
  parseHookRoute, isJsonContentType, headerBytes, withinJsonDepth,
  normalizeGitRemote, normalizeCwd, workspaceCandidates, resolveHookWorkspace,
  validateHookBody, hookIdempotencyKey, formatSessionStartOutput, hookTokenBudget, isReflectEvent
} from "../../lib/hooks/hook-contract.js";

/** HookInputError의 code와 status를 확인하는 판정 함수 */
const inputError = (code, status) => (err) =>
  err instanceof HookInputError && err.code === code && err.status === status;

describe("parseHookRoute", () => {
  it("허용 목록의 클라이언트와 이벤트만 인식한다", () => {
    for (const client of HOOK_CLIENTS) {
      for (const event of HOOK_EVENTS) {
        assert.deepEqual(parseHookRoute(`/hooks/${client}/${event}`), { client, event });
      }
    }
  });

  it("목록 밖의 값과 형식이 다른 경로는 null이다", () => {
    const table = [
      "/hooks/cursor/SessionStart", "/hooks/claude-code/PreToolUse", "/hooks/claude-code/sessionstart",
      "/hooks/claude-code", "/hooks/claude-code/Stop/extra", "/hooks//Stop", "/hooks/CLAUDE-CODE/Stop",
      "/hook/claude-code/Stop", "/hooks/claude-code/Stop/", "/hooks/%63odex/Stop"
    ];
    for (const pathname of table) assert.equal(parseHookRoute(pathname), null, pathname);
  });
});

describe("isJsonContentType", () => {
  it("application/json과 매개변수만 허용한다", () => {
    assert.equal(isJsonContentType("application/json"), true);
    assert.equal(isJsonContentType("application/json; charset=utf-8"), true);
    assert.equal(isJsonContentType("Application/JSON;charset=UTF-8"), true);
    for (const bad of [undefined, "", "text/plain", "application/jsonx", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      assert.equal(isJsonContentType(bad), false, String(bad));
    }
  });
});

describe("headerBytes", () => {
  it("이름과 값의 바이트에 구분 문자를 더해 센다", () => {
    assert.equal(headerBytes(["a", "bc"]), 1 + 2 + 4);
    assert.equal(headerBytes(["키", "값"]), 3 + 3 + 4);
    assert.equal(headerBytes([]), 0);
  });
});

describe("withinJsonDepth", () => {
  it("상한 이하의 깊이만 허용한다", () => {
    let nested = 1;
    for (let i = 0; i < HOOK_LIMITS.jsonMaxDepth; i++) nested = { a: nested };
    assert.equal(withinJsonDepth(nested, HOOK_LIMITS.jsonMaxDepth), true);
    assert.equal(withinJsonDepth({ a: nested }, HOOK_LIMITS.jsonMaxDepth), false);
    assert.equal(withinJsonDepth([[[[1]]]], 3), false);
    assert.equal(withinJsonDepth([[[1]]], 3), true);
    assert.equal(withinJsonDepth("text", 0), true);
  });

  it("아주 깊은 배열도 재귀 없이 판정한다", () => {
    const deep = JSON.parse("[".repeat(100_000) + "]".repeat(100_000));
    assert.equal(withinJsonDepth(deep, 8), false);
  });
});

describe("normalizeGitRemote 정규화 표", () => {
  const table = [
    ["https://github.com/Org/Repo.git",                        "github.com/org/repo"],
    ["https://user:token@GitHub.com/Org/Repo.git",             "github.com/org/repo"],
    ["https://x-access-token:ghp_abc@github.com/org/repo",     "github.com/org/repo"],
    ["http://gitlab.example.com:8080/group/sub/proj.git/",     "gitlab.example.com/group/sub/proj"],
    ["git@github.com:Org/Repo.git",                            "github.com/org/repo"],
    ["ssh://git@git.example.com:2222/Team/Proj.git",           "git.example.com/team/proj"],
    ["git+ssh://git@host.example.com/a/b",                     "host.example.com/a/b"],
    ["git://host.example.com/a/b.GIT",                         "host.example.com/a/b"],
    ["  https://github.com/org/repo.git\n",                    "github.com/org/repo"]
  ];
  for (const [raw, expected] of table) {
    it(`${raw.trim()} → ${expected}`, () => assert.equal(normalizeGitRemote(raw), expected));
  }

  it("경로가 없거나 지원하지 않는 형식과 상한 초과는 null이다", () => {
    const rejected = [
      null, undefined, 42, "", "   ", "https://github.com", "https://github.com/",
      "file:///home/user/repo.git", "/home/user/repo", "../repo", "C:\\repo",
      "https://github.com/org/re po", "https://github.com/org/\u0000repo",
      `https://github.com/${"a".repeat(HOOK_LIMITS.remoteMaxLength)}`
    ];
    for (const raw of rejected) assert.equal(normalizeGitRemote(raw), null, String(raw));
  });
});

describe("normalizeCwd 정규화 표", () => {
  const table = [
    ["/home/User/Projects/Memento-MCP",   "/home/user/projects/memento-mcp"],
    ["/home/user/repo/",                  "/home/user/repo"],
    ["C:\\Users\\Dev\\Repo",              "c:/users/dev/repo"],
    ["/",                                 "/"]
  ];
  for (const [raw, expected] of table) {
    it(`${raw} → ${expected}`, () => assert.equal(normalizeCwd(raw), expected));
  }

  it("문자열이 아니거나 제어 문자, 상한 초과는 null이다", () => {
    for (const raw of [null, 1, "", "  ", "/home/a\u0007b", `/${"a".repeat(HOOK_LIMITS.cwdMaxLength)}`]) {
      assert.equal(normalizeCwd(raw), null, String(raw));
    }
  });
});

describe("workspaceCandidates", () => {
  it("원격 전체, 원격 저장소 이름, cwd 전체, cwd 마지막 조각 순서이고 중복이 없다", () => {
    assert.deepEqual(
      workspaceCandidates({ cwd: normalizeCwd("/home/u/Repo"), gitRemote: normalizeGitRemote("git@github.com:Org/Repo.git") }),
      ["github.com/org/repo", "repo", "/home/u/repo"]
    );
    assert.deepEqual(workspaceCandidates({ cwd: "/srv/app", gitRemote: null }), ["/srv/app", "app"]);
    assert.deepEqual(workspaceCandidates({}), []);
  });
});

describe("resolveHookWorkspace", () => {
  const candidates = ["github.com/org/repo", "repo", "/home/u/repo"];

  it("allowed_workspaces 안의 첫 후보를 저장된 표기로 고른다", () => {
    assert.deepEqual(resolveHookWorkspace(candidates, ["Other", "Repo"], "dflt"), { workspace: "Repo", source: "derived" });
    assert.deepEqual(resolveHookWorkspace(candidates, ["github.com/org/repo", "repo"], null),
      { workspace: "github.com/org/repo", source: "derived" });
  });

  it("허가 집합 밖이거나 집합이 없으면 키 기본 workspace를 쓴다", () => {
    assert.deepEqual(resolveHookWorkspace(candidates, ["other"], "dflt"), { workspace: "dflt", source: "default" });
    assert.deepEqual(resolveHookWorkspace(candidates, null, "dflt"), { workspace: "dflt", source: "default" });
    assert.deepEqual(resolveHookWorkspace(candidates, [], null), { workspace: null, source: "default" });
    assert.deepEqual(resolveHookWorkspace(candidates, Symbol("lookup_failed"), null), { workspace: null, source: "default" });
  });
});

describe("validateHookBody", () => {
  const sid = "0b8f6c4e-1d2a-4c51-9a77-3f1e2d4c5b6a";

  it("SessionStart는 세션 id와 발췌 없이도 통과하고 source를 확인한다", () => {
    const out = validateHookBody("SessionStart", { cwd: "/home/u/repo", source: "compact", transcript_path: "/x" });
    assert.equal(out.source, "compact");
    assert.equal(out.sessionId, null);
    assert.equal(out.excerpt, null);
    assert.equal(out.cwd, "/home/u/repo");
    assert.throws(() => validateHookBody("SessionStart", { source: "boot" }), inputError("invalid_source", 400));
  });

  it("Stop과 SessionEnd는 세션 id와 발췌가 필요하다", () => {
    for (const event of ["Stop", "SessionEnd"]) {
      assert.throws(() => validateHookBody(event, { excerpt: "[assistant]\n완료했다" }), inputError("invalid_session_id", 400));
      assert.throws(() => validateHookBody(event, { session_id: sid }), inputError("excerpt_required", 422));
      assert.throws(() => validateHookBody(event, { session_id: sid, excerpt: "  \n " }), inputError("excerpt_required", 422));
      const ok = validateHookBody(event, { session_id: sid, excerpt: "[assistant]\n완료했다", git_remote: "git@h.example.com:a/b.git" });
      assert.equal(ok.sessionId, sid);
      assert.equal(ok.gitRemote, "h.example.com/a/b");
    }
  });

  it("발췌 상한은 UTF-8 바이트로 잰다", () => {
    const atLimit = "가".repeat(Math.floor(HOOK_LIMITS.excerptMaxBytes / 3));
    assert.ok(validateHookBody("Stop", { session_id: sid, excerpt: atLimit }));
    const over = "가".repeat(Math.floor(HOOK_LIMITS.excerptMaxBytes / 3) + 1);
    assert.throws(() => validateHookBody("Stop", { session_id: sid, excerpt: over }), inputError("excerpt_too_large", 413));
  });

  it("세션 id 형식과 길이, 이벤트 이름 불일치, 본문 형태를 거부한다", () => {
    for (const bad of ["", "a b", "x".repeat(HOOK_LIMITS.sessionIdMaxLength + 1), "-lead", 7, "a/b"]) {
      assert.throws(() => validateHookBody("Stop", { session_id: bad, excerpt: "e" }), inputError("invalid_session_id", 400), String(bad));
    }
    assert.throws(() => validateHookBody("Stop", { hook_event_name: "SessionEnd", session_id: sid, excerpt: "e" }),
      inputError("event_mismatch", 400));
    for (const body of [null, [], "text", 3]) {
      assert.throws(() => validateHookBody("Stop", body), inputError("invalid_body", 400));
    }
    assert.throws(() => validateHookBody("Stop", { session_id: sid, excerpt: 12 }), inputError("excerpt_required", 422));
  });

  it("발췌의 NUL 문자는 400이고 짝 없는 서로게이트는 U+FFFD로 바꾼다", () => {
    assert.throws(() => validateHookBody("Stop", { session_id: sid, excerpt: "a\u0000b" }), inputError("invalid_excerpt", 400));
    const out = validateHookBody("Stop", { session_id: sid, excerpt: "앞\ud800뒤\udc00끝" });
    assert.equal(out.excerpt, "앞\ufffd뒤\ufffd끝");
    assert.equal(out.excerpt.isWellFormed(), true);
  });

  it("잘못된 cwd와 git 원격은 거부하지 않고 버린다", () => {
    const out = validateHookBody("Stop", { session_id: sid, excerpt: "e", cwd: 3, git_remote: "file:///x" });
    assert.equal(out.cwd, null);
    assert.equal(out.gitRemote, null);
  });
});

describe("hookIdempotencyKey", () => {
  it("키, 클라이언트, 세션, 이벤트가 같으면 같고 하나라도 다르면 다르며 aggregate 상한 안이다", () => {
    const base = { keyId: "k1", client: "codex", sessionId: "s1", event: "Stop" };
    const key  = hookIdempotencyKey(base);
    assert.equal(key, hookIdempotencyKey({ ...base }));
    assert.match(key, /^hook:[0-9a-f]{64}$/);
    for (const change of [{ keyId: "k2" }, { keyId: null }, { client: "claude-code" }, { sessionId: "s2" }, { event: "SessionEnd" }]) {
      assert.notEqual(hookIdempotencyKey({ ...base, ...change }), key, JSON.stringify(change));
    }
  });
});

describe("formatSessionStartOutput", () => {
  it("두 클라이언트 모두 hookSpecificOutput.additionalContext 형식이다", () => {
    for (const client of HOOK_CLIENTS) {
      const out = formatSessionStartOutput(client, "ctx");
      assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
      assert.equal(out.hookSpecificOutput.additionalContext, "ctx");
    }
  });

  it("주입할 내용이 없으면 additionalContext를 넣지 않는다", () => {
    assert.deepEqual(formatSessionStartOutput("codex", ""), { hookSpecificOutput: { hookEventName: "SessionStart" } });
  });
});

describe("hookTokenBudget과 isReflectEvent", () => {
  it("클라이언트별 예산은 양의 정수이고 Codex는 2500 토큰 미만이다", () => {
    for (const client of HOOK_CLIENTS) assert.ok(Number.isInteger(hookTokenBudget(client)) && hookTokenBudget(client) > 0);
    assert.ok(hookTokenBudget("codex") < 2500);
  });

  it("회고 이벤트는 Stop과 SessionEnd다", () => {
    assert.deepEqual(HOOK_EVENTS.filter(isReflectEvent), ["Stop", "SessionEnd"]);
  });
});
