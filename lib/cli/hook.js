/**
 * CLI: hook - 하네스 훅 실행체
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * Claude Code와 Codex의 command 훅에서 실행한다. 하네스가 표준 입력으로 넘긴 훅 JSON을 읽어 서버의
 * POST /hooks/{client}/{event}로 보낸다.
 *
 *   SessionStart       서버 응답(hookSpecificOutput.additionalContext)을 표준 출력에 그대로 쓴다.
 *   Stop, SessionEnd   transcript_path의 JSONL 끝부분에서 최근 대화 발췌(64 KB 이하)를 만들어 보낸다.
 *                      transcript를 읽지 못하면 last_assistant_message를 쓴다. 표준 출력에는 쓰지 않는다.
 *
 * 서버는 클라이언트의 transcript 파일을 읽을 수 없으므로 발췌는 이 명령이 만든다. transcript 경로와 원격
 * 주소의 자격 증명은 서버로 보내지 않는다. 실패하면 오류를 던지고 진입점이 종료 코드 1로 끝낸다(두
 * 하네스 모두 비차단 오류로 다룬다. 종료 코드 2는 쓰지 않는다).
 */

import { open }          from "node:fs/promises";
import { execFile }      from "node:child_process";

import { readStdin }     from "./_stdin.js";
import { cliRemoteSettings } from "../config.js";
import { HOOK_CLIENTS, HOOK_EVENTS, HOOK_LIMITS, isReflectEvent, normalizeGitRemote } from "../hooks/hook-contract.js";
import { extractTranscriptMessages, formatExcerpt } from "../hooks/hook-excerpt.js";

export const usage = [
  "Usage: anchormind hook <SessionStart|Stop|SessionEnd> --client <claude-code|codex> [options]",
  "",
  "Run as a Claude Code or Codex command hook. Reads the hook JSON from stdin and calls",
  "POST /hooks/<client>/<event> on the server.",
  "  SessionStart       prints the server's hookSpecificOutput JSON to stdout",
  "  Stop, SessionEnd   sends a recent conversation excerpt (up to 64 KB) built from transcript_path",
  "",
  "Options:",
  "  --client <name>     claude-code | codex",
  "  --remote <URL>      MCP server URL (env: MEMENTO_CLI_REMOTE), e.g. https://memento.example.com/mcp",
  "  --key <KEY>         API key (env: MEMENTO_CLI_KEY; prefer the env var over the flag)",
  "  --timeout <ms>      request timeout (default: SessionEnd 1200, others 5000)",
  "",
  "Example (~/.claude/settings.json command):",
  "  anchormind hook SessionEnd --client claude-code",
].join("\n");

/** 이벤트별 기본 제한 시간. Claude Code의 SessionEnd 훅 예산은 1.5초다. */
const DEFAULT_TIMEOUT_MS = Object.freeze({ SessionStart: 5000, Stop: 5000, SessionEnd: 1200 });

/** transcript 끝에서 읽는 최대 바이트 */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/** git 원격 조회 제한 시간 */
const GIT_TIMEOUT_MS = 1000;

/**
 * 훅 요청 주소. MCP 주소 끝의 /mcp를 /hooks/{client}/{event}로 바꾼다.
 *
 * @param {string} remote
 * @param {string} client
 * @param {string} event
 * @returns {string}
 */
export function hookUrl(remote, client, event) {
  const url  = new URL(remote);
  const base = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  return `${url.origin}${base}/hooks/${client}/${event}`;
}

/**
 * @param {string} event
 * @param {{ timeout?: string|number }} args
 * @returns {number}
 */
export function hookTimeoutMs(event, args) {
  const value = Number(args.timeout);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS[event];
}

/**
 * 서버로 보낼 본문. 원격 주소는 자격 증명과 포트를 지운 https 형식으로 보낸다.
 *
 * @param {string} event
 * @param {object} input 하네스 훅 JSON
 * @param {{ gitRemote: string|null, excerpt: string|null }} extra
 * @returns {object}
 */
export function buildHookBody(event, input, { gitRemote, excerpt }) {
  const body   = { hook_event_name: event };
  const remote = normalizeGitRemote(gitRemote);
  if (typeof input.session_id === "string") body.session_id = input.session_id;
  if (typeof input.cwd === "string")        body.cwd        = input.cwd;
  if (event === "SessionStart" && typeof input.source === "string") body.source = input.source;
  if (remote)  body.git_remote = `https://${remote}`;
  if (excerpt) body.excerpt    = excerpt;
  return body;
}

/**
 * transcript 파일 끝부분을 줄 배열로 읽는다. 읽지 못하면 null.
 *
 * @param {unknown} transcriptPath
 * @returns {Promise<string[]|null>}
 */
async function readTranscriptTail(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return null;
  let handle;
  try {
    handle = await open(transcriptPath, "r");
    const { size } = await handle.stat();
    const start    = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buffer   = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines    = buffer.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } catch {
    /** 읽기 실패는 발췌 대체 경로(last_assistant_message)로 넘긴다. */
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * cwd 저장소의 origin 원격 주소. 없거나 git이 실패하면 null.
 *
 * @param {unknown} cwd
 * @returns {Promise<string|null>}
 */
function readGitRemote(cwd) {
  if (typeof cwd !== "string" || cwd === "") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
}

/** 기본 의존성 */
const DEFAULT_DEPS = Object.freeze({
  readStdin,
  readTranscript: readTranscriptTail,
  gitRemote     : readGitRemote,
  fetch         : (url, init) => globalThis.fetch(url, init),
  stdout        : (text) => process.stdout.write(text),
  stderr        : (text) => process.stderr.write(text),
  remoteSettings: cliRemoteSettings
});

/**
 * 인자를 검사해 이벤트, 클라이언트, 원격 주소, 키를 정한다.
 *
 * @returns {{ event: string, client: string, remote: string, key: string }}
 */
function resolveTarget(args, settings) {
  const event  = args._?.[0];
  const client = args.client;
  const remote = args.remote || settings.remote;
  const key    = args.key || settings.key;
  if (!HOOK_EVENTS.includes(event))   throw new Error(`event must be one of ${HOOK_EVENTS.join(", ")}`);
  if (!HOOK_CLIENTS.includes(client)) throw new Error(`--client must be one of ${HOOK_CLIENTS.join(", ")}`);
  if (typeof remote !== "string" || !remote) throw new Error("--remote or MEMENTO_CLI_REMOTE is required");
  if (typeof key !== "string" || !key)       throw new Error("--key or MEMENTO_CLI_KEY is required");
  return { event, client, remote, key };
}

/**
 * 하네스 입력 JSON을 읽는다.
 *
 * @returns {Promise<object>}
 */
async function readHookInput(deps, event) {
  let input;
  try {
    input = JSON.parse(await deps.readStdin());
  } catch {
    throw new Error("stdin must be the hook JSON object");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("stdin must be the hook JSON object");
  if (input.hook_event_name !== undefined && input.hook_event_name !== event) {
    throw new Error(`hook_event_name ${String(input.hook_event_name).slice(0, 40)} does not match ${event}`);
  }
  return input;
}

/**
 * 회고 이벤트의 발췌. transcript가 없거나 메시지가 없으면 last_assistant_message를 쓴다.
 *
 * @returns {Promise<string>}
 */
async function buildExcerpt(deps, input) {
  const lines    = await deps.readTranscript(input.transcript_path);
  const messages = lines ? extractTranscriptMessages(lines) : [];
  if (messages.length === 0 && typeof input.last_assistant_message === "string") {
    messages.push({ role: "assistant", text: input.last_assistant_message.trim() });
  }
  return formatExcerpt(messages.filter(m => m.text), HOOK_LIMITS.excerptMaxBytes);
}

/**
 * 서버 오류 본문의 error 코드. JSON이 아니거나 코드가 없으면 unknown이다.
 *
 * @param {string} text
 * @returns {string}
 */
function errorCode(text) {
  try {
    return String(JSON.parse(text)?.error ?? "unknown").slice(0, 64);
  } catch {
    return "unknown";
  }
}

/**
 * anchormind hook <event> --client <client>
 *
 * @param {object} args
 * @param {Partial<typeof DEFAULT_DEPS>} [overrides] 시험용 의존성
 */
export default async function hook(args, overrides = {}) {
  const deps   = { ...DEFAULT_DEPS, ...overrides };
  const target = resolveTarget(args, deps.remoteSettings());
  const input  = await readHookInput(deps, target.event);

  const excerpt = isReflectEvent(target.event) ? await buildExcerpt(deps, input) : null;
  if (isReflectEvent(target.event) && !excerpt) {
    deps.stderr("[hook] no conversation excerpt to send\n");
    return;
  }

  const body = buildHookBody(target.event, input, { gitRemote: await deps.gitRemote(input.cwd), excerpt });
  const res  = await deps.fetch(hookUrl(target.remote, target.client, target.event), {
    method : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.key}` },
    body   : JSON.stringify(body),
    signal : AbortSignal.timeout(hookTimeoutMs(target.event, args))
  });
  const text = await res.text();

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`server responded ${res.status} (${errorCode(text)})`);
  }

  if (target.event === "SessionStart") {
    const output = JSON.parse(text);
    if (!output?.hookSpecificOutput) throw new Error("server response has no hookSpecificOutput");
    deps.stdout(JSON.stringify(output));
  }
}
