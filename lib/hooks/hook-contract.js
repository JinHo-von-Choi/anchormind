/**
 * 훅 엔드포인트 입력 계약
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * POST /hooks/{client}/{event}의 경로, 헤더, 본문 검사와 workspace 후보 정규화, 멱등 키, 하네스 출력 형식을
 * 담은 순수 함수 모음이다. 설정, DB, 로거에 접근하지 않으므로 서버 처리기와 로컬 CLI(anchormind hook)가
 * 함께 쓴다.
 *
 * 클라이언트와 이벤트는 허용 목록으로만 받는다. 지표 라벨도 이 목록 안의 값만 쓴다.
 */

import crypto from "node:crypto";

/** 지원 클라이언트. 경로 조각 그대로다. */
export const HOOK_CLIENTS = Object.freeze(["claude-code", "codex"]);

/** 지원 이벤트. 하네스의 hook_event_name 표기 그대로다. */
export const HOOK_EVENTS = Object.freeze(["SessionStart", "Stop", "SessionEnd"]);

/** SessionStart의 source(Claude Code와 Codex의 matcher 값) */
export const SESSION_START_SOURCES = Object.freeze(["startup", "resume", "compact", "clear", "fork"]);

/** 회고 이벤트. 요약 후보를 받아 outbox에 기록한다. */
const REFLECT_EVENTS = new Set(["Stop", "SessionEnd"]);

/** 입력 상한 */
export const HOOK_LIMITS = Object.freeze({
  excerptMaxBytes   : 65_536,
  bodyMaxBytes      : 196_608,
  headerMaxBytes    : 8_192,
  jsonMaxDepth      : 8,
  sessionIdMaxLength: 128,
  cwdMaxLength      : 4_096,
  remoteMaxLength   : 2_048
});

/**
 * 클라이언트별 context 토큰 예산. Codex는 훅 출력이 약 2,500 토큰을 넘으면 본문 대신 파일 경로를 넘기므로
 * 그보다 작게 둔다.
 */
const CLIENT_TOKEN_BUDGET = Object.freeze({
  "claude-code": 2000,
  "codex"      : 1500
});

const ROUTE_PATTERN      = /^\/hooks\/([a-z-]+)\/([A-Za-z]+)$/;
const JSON_CONTENT_TYPE  = /^application\/json\s*(;.*)?$/i;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTROL_CHARS      = /[\u0000-\u001f\u007f]/;
const SCP_REMOTE         = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;
const URL_SCHEMES        = new Set(["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"]);

/** 입력 계약 위반. code는 응답 본문의 error, status는 HTTP 상태다. 입력 값은 담지 않는다. */
export class HookInputError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   * @param {string} [field]
   */
  constructor(code, status, field) {
    super(`hook input rejected: ${code}`);
    this.name   = "HookInputError";
    this.code   = code;
    this.status = status;
    this.field  = field ?? null;
  }
}

/**
 * 경로에서 클라이언트와 이벤트를 읽는다. 허용 목록 밖이면 null.
 *
 * @param {string} pathname URL의 pathname(복호화하지 않은 값)
 * @returns {{ client: string, event: string }|null}
 */
export function parseHookRoute(pathname) {
  const m = ROUTE_PATTERN.exec(typeof pathname === "string" ? pathname : "");
  if (!m || !HOOK_CLIENTS.includes(m[1]) || !HOOK_EVENTS.includes(m[2])) return null;
  return { client: m[1], event: m[2] };
}

/**
 * @param {string} event
 * @returns {boolean} 요약 후보를 받아 회고로 넘기는 이벤트인가
 */
export function isReflectEvent(event) {
  return REFLECT_EVENTS.has(event);
}

/**
 * @param {string} client
 * @returns {number} 클라이언트의 SessionStart context 토큰 예산
 */
export function hookTokenBudget(client) {
  return CLIENT_TOKEN_BUDGET[client] ?? CLIENT_TOKEN_BUDGET["claude-code"];
}

/**
 * @param {unknown} header Content-Type 헤더 값
 * @returns {boolean}
 */
export function isJsonContentType(header) {
  return typeof header === "string" && JSON_CONTENT_TYPE.test(header.trim());
}

/**
 * 요청 헤더의 바이트 수. 이름과 값의 UTF-8 바이트에 줄마다 ": "와 CRLF 4바이트를 더한다.
 *
 * @param {string[]} rawHeaders IncomingMessage.rawHeaders(이름, 값이 번갈아 온다)
 * @returns {number}
 */
export function headerBytes(rawHeaders) {
  let total = 0;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    total += Buffer.byteLength(String(rawHeaders[i]), "utf8") + Buffer.byteLength(String(rawHeaders[i + 1]), "utf8") + 4;
  }
  return total;
}

/**
 * JSON 값의 중첩 깊이가 상한 이하인지 본다. 원시값은 깊이 0, 객체와 배열은 한 겹마다 1을 더한다.
 * 재귀하지 않으므로 아주 깊은 입력에서도 호출 스택을 쓰지 않는다.
 *
 * @param {unknown} value
 * @param {number}  maxDepth
 * @returns {boolean}
 */
export function withinJsonDepth(value, maxDepth) {
  const stack = [[value, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (depth + 1 > maxDepth) return false;
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) stack.push([child, depth + 1]);
  }
  return true;
}

/**
 * 경로 문자열을 workspace 후보 형식으로 다듬는다. 소문자, 연속 빗금 하나로, 앞뒤 빗금과 끝의 .git 제거.
 *
 * @param {string} host
 * @param {string} rawPath
 * @returns {string|null}
 */
function joinRemote(host, rawPath) {
  const pathPart = rawPath.toLowerCase().replace(/\/+/g, "/").replace(/^\/|\/$/g, "").replace(/\.git$/, "");
  if (!host || !pathPart || /\s/.test(pathPart) || CONTROL_CHARS.test(pathPart)) return null;
  return `${host.toLowerCase()}/${pathPart}`;
}

/**
 * git 원격 주소를 workspace 후보로 정규화한다. 자격 증명(사용자 정보)과 포트, 스킴, 끝의 .git을 지우고
 * 소문자로 바꾼다. 로컬 경로, file 스킴, 경로가 없는 주소는 null이다.
 *
 * @param {unknown} raw
 * @returns {string|null} 예: "github.com/org/repo"
 */
export function normalizeGitRemote(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > HOOK_LIMITS.remoteMaxLength || CONTROL_CHARS.test(text)) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (!URL_SCHEMES.has(url.protocol.toLowerCase())) return null;
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    return joinRemote(url.hostname, pathname);
  }

  const scp = SCP_REMOTE.exec(text);
  if (!scp || /^[a-z]$/i.test(scp[1])) return null;
  return joinRemote(scp[1], scp[2]);
}

/**
 * 작업 디렉터리를 workspace 후보로 정규화한다. 역빗금을 빗금으로, 소문자로, 끝 빗금 제거.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeCwd(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > HOOK_LIMITS.cwdMaxLength || CONTROL_CHARS.test(text)) return null;
  const normalized = text.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

/** 빗금으로 나눈 마지막 조각. 없으면 null. */
function lastSegment(value) {
  const seg = value.split("/").filter(Boolean).at(-1);
  return seg ?? null;
}

/**
 * workspace 후보 목록. 원격 전체, 원격 저장소 이름, cwd 전체, cwd 마지막 조각 순서이고 중복은 앞의 것만 남긴다.
 * 인자는 이미 정규화한 값이다.
 *
 * @param {{ cwd?: string|null, gitRemote?: string|null }} input
 * @returns {string[]}
 */
export function workspaceCandidates({ cwd = null, gitRemote = null } = {}) {
  const list = [];
  if (gitRemote) list.push(gitRemote, lastSegment(gitRemote));
  if (cwd) list.push(cwd, lastSegment(cwd));
  return [...new Set(list.filter(Boolean))];
}

/**
 * 후보 중 키의 allowed_workspaces 안에 있는 첫 값을 고른다. 비교는 소문자로 하고 결과는 저장된 표기다.
 * 허가 집합이 배열이 아니거나(제한 없음, 조회 실패) 맞는 후보가 없으면 키 기본 workspace를 쓴다.
 *
 * @param {string[]} candidates
 * @param {unknown}  allowed  allowed_workspaces 조회 결과
 * @param {string|null} defaultWorkspace
 * @returns {{ workspace: string|null, source: "derived"|"default" }}
 */
export function resolveHookWorkspace(candidates, allowed, defaultWorkspace) {
  if (Array.isArray(allowed) && allowed.length > 0) {
    const byLower = new Map();
    for (const entry of allowed) {
      if (typeof entry === "string" && !byLower.has(entry.toLowerCase())) byLower.set(entry.toLowerCase(), entry);
    }
    for (const candidate of candidates) {
      const hit = byLower.get(candidate.toLowerCase());
      if (hit !== undefined) return { workspace: hit, source: "derived" };
    }
  }
  return { workspace: defaultWorkspace ?? null, source: "default" };
}

/**
 * 세션 id 검사. 회고 이벤트에서는 필수다.
 *
 * @param {unknown} value
 * @param {boolean} required
 * @returns {string|null}
 */
function checkedSessionId(value, required) {
  if (value === undefined || value === null) {
    if (required) throw new HookInputError("invalid_session_id", 400, "session_id");
    return null;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > HOOK_LIMITS.sessionIdMaxLength
      || !SESSION_ID_PATTERN.test(value)) {
    throw new HookInputError("invalid_session_id", 400, "session_id");
  }
  return value;
}

/**
 * 요약 후보 검사. UTF-8 바이트 상한을 넘으면 413, 비었으면 422.
 *
 * @param {unknown} value
 * @returns {string}
 */
function checkedExcerpt(value) {
  if (typeof value !== "string" || value.trim() === "") throw new HookInputError("excerpt_required", 422, "excerpt");
  if (Buffer.byteLength(value, "utf8") > HOOK_LIMITS.excerptMaxBytes) {
    throw new HookInputError("excerpt_too_large", 413, "excerpt");
  }
  return value;
}

/**
 * 본문을 검사해 처리에 쓰는 값만 꺼낸다. 하네스가 보내는 나머지 필드(transcript_path 등)는 버린다.
 *
 * @param {string}  event 경로의 이벤트
 * @param {unknown} body  파싱한 JSON 본문
 *   cwd와 gitRemote는 정규화한 값이고, 형식이 맞지 않으면 거부하지 않고 null로 둔다.
 * @returns {{ sessionId: string|null, source: string|null, cwd: string|null, gitRemote: string|null, excerpt: string|null }}
 * @throws {HookInputError}
 */
export function validateHookBody(event, body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HookInputError("invalid_body", 400);
  }
  if (body.hook_event_name !== undefined && body.hook_event_name !== event) {
    throw new HookInputError("event_mismatch", 400, "hook_event_name");
  }

  const reflect = isReflectEvent(event);
  const sessionId = checkedSessionId(body.session_id, reflect);

  let source = null;
  if (event === "SessionStart" && body.source !== undefined) {
    if (!SESSION_START_SOURCES.includes(body.source)) throw new HookInputError("invalid_source", 400, "source");
    source = body.source;
  }

  return {
    sessionId,
    source,
    cwd      : normalizeCwd(body.cwd),
    gitRemote: normalizeGitRemote(body.git_remote),
    excerpt  : reflect ? checkedExcerpt(body.excerpt) : null
  };
}

/**
 * 회고 이벤트의 멱등 키. 같은 키(마스터는 빈 값), 클라이언트, 세션, 이벤트는 같은 값이다.
 *
 * @param {{ keyId: string|null, client: string, sessionId: string, event: string }} input
 * @returns {string} "hook:" + sha256 16진수(69자)
 */
export function hookIdempotencyKey({ keyId, client, sessionId, event }) {
  const digest = crypto.createHash("sha256")
    .update([keyId ?? "", client, sessionId, event].join("\n"))
    .digest("hex");
  return `hook:${digest}`;
}

/**
 * SessionStart 응답 본문. Claude Code와 Codex는 같은 hookSpecificOutput 형식을 읽는다.
 *
 * @param {string} _client
 * @param {string} text 주입할 context
 * @returns {{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext?: string } }}
 */
export function formatSessionStartOutput(_client, text) {
  const output = { hookEventName: "SessionStart" };
  if (typeof text === "string" && text.trim() !== "") output.additionalContext = text;
  return { hookSpecificOutput: output };
}
