/**
 * 훅 요약 후보(최근 대화 발췌)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 로컬 CLI(anchormind hook)가 하네스의 transcript JSONL에서 대화 메시지를 꺼내 바이트 상한 안의 발췌를
 * 만들고, 서버의 회고 소비자가 그 발췌에서 마지막 응답 블록을 고른다. 두 쪽이 같은 형식을 쓰도록 형식과
 * 해석을 이 모듈 하나에 둔다. 순수 함수만 있다.
 *
 * 발췌 형식: 메시지마다 역할 표지 줄([user] 또는 [assistant])과 본문을 쓰고, 메시지 사이는 빈 줄 하나다.
 * 도구 호출과 도구 결과는 담지 않는다.
 */

/** 역할 표지 줄 */
export const EXCERPT_ROLE_MARK = Object.freeze({
  user     : "[user]",
  assistant: "[assistant]"
});

const BLOCK_SEPARATOR = "\n\n";

/** Codex가 사용자 메시지 자리에 넣는 환경 주입 블록의 머리 */
const INJECTED_PREFIXES = ["<environment_context>", "<user_instructions>", "<permissions instructions>"];

/**
 * 메시지 content(문자열 또는 조각 배열)에서 텍스트만 모은다.
 *
 * @param {unknown} content
 * @param {Set<string>} textTypes 텍스트로 보는 조각 type
 * @returns {string}
 */
function contentText(content, textTypes) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(part => part && textTypes.has(part.type) && typeof part.text === "string")
    .map(part => part.text)
    .filter(text => !INJECTED_PREFIXES.some(prefix => text.trimStart().startsWith(prefix)))
    .join("\n");
}

const CLAUDE_TEXT_TYPES = new Set(["text"]);
const CODEX_TEXT_TYPES  = new Set(["input_text", "output_text", "text"]);

/** JSON 한 줄을 객체로 읽는다. 객체가 아니면 null. */
function parseLine(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 역할과 텍스트를 메시지로 만든다. 텍스트가 비면 null. */
function message(role, text) {
  if (role !== "user" && role !== "assistant") return null;
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed ? { role, text: trimmed } : null;
}

/**
 * transcript JSONL 줄에서 사용자와 응답 메시지를 시간 순으로 꺼낸다.
 * Claude Code 줄({type: user|assistant, message: {content}})과 Codex 줄({type: response_item, payload:
 * {type: message, role, content}})을 읽는다. Codex 줄에 response_item 메시지가 없으면 event_msg의
 * user_message와 agent_message를 쓴다.
 *
 * @param {string[]} lines
 * @returns {Array<{ role: "user"|"assistant", text: string }>}
 */
export function extractTranscriptMessages(lines) {
  const primary  = [];
  const fallback = [];
  for (const raw of lines) {
    const obj = parseLine(raw);
    if (!obj) continue;

    if ((obj.type === "user" || obj.type === "assistant") && obj.message && typeof obj.message === "object") {
      const m = message(obj.type, contentText(obj.message.content, CLAUDE_TEXT_TYPES));
      if (m) primary.push(m);
      continue;
    }
    const payload = obj.payload;
    if (!payload || typeof payload !== "object") continue;
    if (obj.type === "response_item" && payload.type === "message") {
      const m = message(payload.role, contentText(payload.content, CODEX_TEXT_TYPES));
      if (m) primary.push(m);
    } else if (obj.type === "event_msg" && (payload.type === "user_message" || payload.type === "agent_message")) {
      const m = message(payload.type === "user_message" ? "user" : "assistant", payload.message);
      if (m) fallback.push(m);
    }
  }
  return primary.length > 0 ? primary : fallback;
}

/**
 * 문자열 끝에서 UTF-8 바이트 상한 안에 드는 가장 긴 부분을 문자(코드 포인트) 경계로 자른다.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function utf8Tail(text, maxBytes) {
  if (maxBytes <= 0) return "";
  const chars = Array.from(text);
  let   bytes = 0;
  let   start = chars.length;
  while (start > 0) {
    const size = Buffer.byteLength(chars[start - 1], "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    start--;
  }
  return chars.slice(start).join("");
}

/** 메시지 하나의 블록 문자열 */
function block({ role, text }) {
  return `${EXCERPT_ROLE_MARK[role]}\n${text}`;
}

/**
 * 최근 메시지부터 바이트 상한 안에 드는 만큼 골라 시간 순 발췌를 만든다. 가장 최근 메시지 하나가 상한을
 * 넘으면 그 메시지의 끝부분만 담는다.
 *
 * @param {Array<{ role: "user"|"assistant", text: string }>} messages
 * @param {number} maxBytes
 * @returns {string}
 */
export function formatExcerpt(messages, maxBytes) {
  const picked = [];
  let   bytes  = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = block(messages[i]);
    const cost = Buffer.byteLength(text, "utf8") + (picked.length > 0 ? BLOCK_SEPARATOR.length : 0);
    if (bytes + cost <= maxBytes) {
      picked.unshift(text);
      bytes += cost;
      continue;
    }
    if (picked.length === 0) {
      const head = `${EXCERPT_ROLE_MARK[messages[i].role]}\n`;
      const tail = utf8Tail(messages[i].text, maxBytes - Buffer.byteLength(head, "utf8"));
      if (tail) picked.unshift(head + tail);
    }
    break;
  }
  return picked.join(BLOCK_SEPARATOR);
}

/**
 * 발췌의 마지막 응답 블록 본문. 응답 블록이 없으면 마지막 블록 본문(표지 제외), 표지가 없으면 발췌 전체다.
 *
 * @param {string} excerpt
 * @returns {string}
 */
export function lastAssistantBlock(excerpt) {
  const blocks = String(excerpt).split(BLOCK_SEPARATOR);
  const marks  = Object.values(EXCERPT_ROLE_MARK).map(mark => `${mark}\n`);
  const starts = [];
  for (let i = 0; i < blocks.length; i++) {
    if (marks.some(mark => blocks[i].startsWith(mark))) starts.push(i);
  }
  if (starts.length === 0) return String(excerpt).trim();

  const assistantStart = [...starts].reverse().find(i => blocks[i].startsWith(`${EXCERPT_ROLE_MARK.assistant}\n`));
  const from           = assistantStart ?? starts.at(-1);
  const next           = starts.find(i => i > from) ?? blocks.length;
  const body           = blocks.slice(from, next).join(BLOCK_SEPARATOR);
  return body.slice(body.indexOf("\n") + 1).trim();
}

/**
 * 공백을 한 칸으로 접고 상한 문자 수 안에서 자른다. 상한 안에 공백이 있으면 마지막 공백 앞에서 자른다.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function clipText(text, maxChars) {
  const folded = String(text).replace(/\s+/g, " ").trim();
  if (folded.length <= maxChars) return folded;
  const cut   = folded.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}
