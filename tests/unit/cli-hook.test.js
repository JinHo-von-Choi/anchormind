/**
 * anchormind hook CLI 시험(stub 의존성)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 하네스 입력(stdin JSON)에서 요청 본문을 만들고, transcript에서 발췌를 만들고, 서버 응답을 하네스 출력으로
 * 옮기는지 본다. 원격 주소의 자격 증명과 API 키가 요청 본문, 출력, 오류 문구에 들어가지 않는지 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import hook, { hookUrl, hookTimeoutMs, buildHookBody } from "../../lib/cli/hook.js";
import { HOOK_LIMITS }                                 from "../../lib/hooks/hook-contract.js";

const SID    = "0b8f6c4e-1d2a-4c51-9a77-3f1e2d4c5b6a";
const KEY    = "mmcp_test_key_value_1234567890";
const REMOTE = "https://memento.example.com/mcp";

const transcriptLines = [
  JSON.stringify({ type: "user", message: { role: "user", content: "로그 회전을 설정해 줘" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "logrotate 설정을 추가했다." }] } })
];

/** stub 의존성과 기록 */
function makeDeps({ stdin, status = 200, json = null, lines = transcriptLines, remote = "https://bot:ghp_x@github.com/o/r.git" } = {}) {
  const sent = [];
  const out  = [];
  const err  = [];
  return {
    sent, out, err,
    deps: {
      readStdin     : async () => stdin,
      readTranscript: async (p) => (p ? lines : null),
      gitRemote     : async () => remote,
      fetch         : async (url, init) => {
        sent.push({ url, init, body: JSON.parse(init.body) });
        return { status, text: async () => (json === null ? "" : JSON.stringify(json)) };
      },
      stdout        : (text) => out.push(text),
      stderr        : (text) => err.push(text),
      remoteSettings: () => ({ remote: null, key: null })
    }
  };
}

const baseArgs = (event, extra = {}) => ({ _: [event], client: "claude-code", remote: REMOTE, key: KEY, ...extra });

describe("hookUrl과 hookTimeoutMs", () => {
  it("MCP 주소의 끝 /mcp를 훅 경로로 바꾼다", () => {
    assert.equal(hookUrl("https://h.example.com/mcp", "codex", "Stop"), "https://h.example.com/hooks/codex/Stop");
    assert.equal(hookUrl("https://h.example.com/base/mcp/", "codex", "Stop"), "https://h.example.com/base/hooks/codex/Stop");
    assert.equal(hookUrl("http://127.0.0.1:9999", "claude-code", "SessionStart"), "http://127.0.0.1:9999/hooks/claude-code/SessionStart");
  });

  it("SessionEnd 기본 제한 시간은 하네스 예산 1.5초보다 짧고 --timeout이 우선한다", () => {
    assert.ok(hookTimeoutMs("SessionEnd", {}) < 1500);
    assert.equal(hookTimeoutMs("Stop", { timeout: "2500" }), 2500);
    assert.equal(hookTimeoutMs("Stop", { timeout: "abc" }), hookTimeoutMs("Stop", {}));
  });
});

describe("buildHookBody", () => {
  it("원격 주소의 자격 증명을 지우고 SessionStart에는 발췌를 넣지 않는다", () => {
    const body = buildHookBody("SessionStart", { session_id: SID, cwd: "/w", source: "resume", transcript_path: "/t" },
      { gitRemote: "https://bot:ghp_x@github.com/o/r.git", excerpt: null });
    assert.deepEqual(body, { hook_event_name: "SessionStart", session_id: SID, cwd: "/w", source: "resume", git_remote: "https://github.com/o/r" });
  });
});

describe("anchormind hook", () => {
  it("SessionStart는 서버의 하네스 출력을 표준 출력에 그대로 쓴다", async () => {
    const output = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "[CORE MEMORY]" } };
    const t = makeDeps({ stdin: JSON.stringify({ session_id: SID, hook_event_name: "SessionStart", cwd: "/w", source: "startup" }), json: output });
    await hook(baseArgs("SessionStart"), t.deps);
    assert.equal(t.sent[0].url, "https://memento.example.com/hooks/claude-code/SessionStart");
    assert.equal(t.sent[0].init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(t.sent[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(t.out.join("")), output);
    assert.ok(!JSON.stringify(t.sent[0].body).includes("ghp_x"));
  });

  it("Stop은 transcript에서 발췌를 만들어 보내고 표준 출력에 아무것도 쓰지 않는다", async () => {
    const t = makeDeps({ stdin: JSON.stringify({ session_id: SID, hook_event_name: "Stop", cwd: "/w", transcript_path: "/t.jsonl" }), status: 202, json: { accepted: true } });
    await hook(baseArgs("Stop", { client: "codex" }), t.deps);
    const body = t.sent[0].body;
    assert.equal(t.sent[0].url, "https://memento.example.com/hooks/codex/Stop");
    assert.ok(body.excerpt.includes("[assistant]\nlogrotate 설정을 추가했다."));
    assert.ok(Buffer.byteLength(body.excerpt, "utf8") <= HOOK_LIMITS.excerptMaxBytes);
    assert.equal("transcript_path" in body, false);
    assert.deepEqual(t.out, []);
  });

  it("transcript를 읽지 못하면 last_assistant_message로 발췌를 만든다", async () => {
    const t = makeDeps({ stdin: JSON.stringify({ session_id: SID, last_assistant_message: "정리를 끝냈다" }), status: 202, lines: null });
    await hook(baseArgs("SessionEnd"), t.deps);
    assert.equal(t.sent[0].body.excerpt, "[assistant]\n정리를 끝냈다");
  });

  it("보낼 발췌가 없으면 요청하지 않고 정상 종료한다", async () => {
    const t = makeDeps({ stdin: JSON.stringify({ session_id: SID }), lines: [] });
    await hook(baseArgs("SessionEnd"), t.deps);
    assert.equal(t.sent.length, 0);
    assert.equal(t.err.length, 1);
  });

  it("서버가 2xx가 아니면 오류 코드만 담은 오류를 던지고 키를 드러내지 않는다", async () => {
    const t = makeDeps({ stdin: JSON.stringify({ session_id: SID, last_assistant_message: "끝" }), status: 401, json: { error: "unauthorized" } });
    await assert.rejects(hook(baseArgs("Stop"), t.deps), (err) => /401/.test(err.message) && /unauthorized/.test(err.message) && !err.message.includes(KEY));
  });

  it("이벤트, 클라이언트, 원격 주소, 키, 하네스 입력을 확인한다", async () => {
    const stdin = JSON.stringify({ session_id: SID });
    await assert.rejects(hook(baseArgs("PreToolUse"), makeDeps({ stdin }).deps), /event/);
    await assert.rejects(hook(baseArgs("Stop", { client: "cursor" }), makeDeps({ stdin }).deps), /--client/);
    await assert.rejects(hook({ _: ["Stop"], client: "codex", key: KEY }, makeDeps({ stdin }).deps), /remote/);
    await assert.rejects(hook({ _: ["Stop"], client: "codex", remote: REMOTE }, makeDeps({ stdin }).deps), /key/);
    await assert.rejects(hook(baseArgs("Stop"), makeDeps({ stdin: "[1]" }).deps), /JSON object/);
    await assert.rejects(hook(baseArgs("Stop"), makeDeps({ stdin: JSON.stringify({ hook_event_name: "SessionEnd" }) }).deps), /hook_event_name/);
  });

  it("원격 주소와 키는 환경 변수 MEMENTO_CLI_REMOTE, MEMENTO_CLI_KEY에서도 읽는다", async () => {
    const t = makeDeps({ stdin: JSON.stringify({ cwd: "/w" }), json: { hookSpecificOutput: { hookEventName: "SessionStart" } } });
    t.deps.remoteSettings = () => ({ remote: REMOTE, key: KEY });
    await hook({ _: ["SessionStart"], client: "codex" }, t.deps);
    assert.equal(t.sent[0].init.headers.Authorization, `Bearer ${KEY}`);
  });
});
