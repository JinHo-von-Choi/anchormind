/**
 * 민감 정보 패턴 표
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 저장 경로 마스킹(SensitiveScanner)과 로그 마스킹(lib/logger.js)이 같은 표를 쓴다.
 * 다른 모듈을 가져오지 않는 잎 모듈이며 환경 변수와 설정 파일을 읽지 않는다.
 *
 * 항목 속성
 *   id            규칙 이름. 경고에는 이름만 남는다
 *   severity      "high"(자격 증명, 개인 식별 번호) | "low"(이메일, 전화번호)
 *   pattern       전역 정규식. 모든 패턴은 입력 길이에 선형으로 동작한다. apply가 있으면 null이다
 *   store         저장 경로의 대체 값(문자열 또는 replace 콜백). null이면 저장 경로에 쓰지 않는다
 *   log           로그 경로의 대체 값(문자열). null이면 로그에 쓰지 않는다. 로그는 validate와 apply를 쓰지 않는다
 *   legacy        true이면 레거시 규칙(API 키, 이메일, 비밀번호 필드, 휴대전화 번호)이다
 *   caseSensitive true이면 대소문자 무시 판을 만들지 않는다
 *   validate      (match, offset, text)를 받아 대체 여부를 판정한다(체크섬, 접두, 주변 단어 확인)
 *   masked        일치 문자열이 이미 표식이면 true. 대체는 하되 탐지로 세지 않는다(재검사에서 경고가 생기지 않는다)
 *   apply         정규식으로 선형을 보장할 수 없는 규칙의 구현 (text, replacement, onHit) => string
 *
 * 적용 순서는 표의 순서다. 저장 경로는 URL 자격 증명 규칙 다음에 레거시 규칙을 적용한다.
 */

/** 규칙 이름 접두. 경고와 판정이 이 접두로 민감 정보 규칙을 알아본다. */
export const SENSITIVE_RULE_PREFIX = "sensitive.";

/**
 * Luhn 검사.
 *
 * @param {string} digits
 * @returns {boolean}
 */
export function luhnValid(digits) {
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * 카드 번호 앞자리가 주요 발급사 범위인지 본다. 13자리 안팎의 일반 숫자열(시각, 일련번호)을 거른다.
 *
 * @param {string} digits
 * @returns {boolean}
 */
export function cardPrefixPlausible(digits) {
  const p2 = Number(digits.slice(0, 2));
  const p3 = Number(digits.slice(0, 3));
  const p4 = Number(digits.slice(0, 4));
  return digits[0] === "4"
    || (p2 >= 51 && p2 <= 55)
    || (p4 >= 2221 && p4 <= 2720)
    || p2 === 34 || p2 === 37 || p2 === 35 || p2 === 36
    || (p3 >= 300 && p3 <= 305)
    || p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649)
    || p2 === 62;
}

const RRN_WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];

/**
 * 주민등록번호 검증 자릿수 일치 여부.
 *
 * @param {string} digits 13자리 숫자
 * @returns {boolean}
 */
export function rrnChecksumValid(digits) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (digits.charCodeAt(i) - 48) * RRN_WEIGHTS[i];
  return (11 - (sum % 11)) % 10 === digits.charCodeAt(12) - 48;
}

/** 임의 번호 체계(검증 자릿수 없음)로 발급된 번호의 생년월일 하한 YYMMDD. 2020-10-01 */
const RRN_RANDOM_ISSUE_FROM = 201001;

/** 오늘 날짜를 YYMMDD 숫자로 돌려준다. */
function todayYymmdd(now = new Date()) {
  return (now.getFullYear() % 100) * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

/**
 * 주민등록번호 후보 판정 함수를 만든다. 시계를 주입할 수 있다.
 * 날짜 형태는 정규식이 확인한다. 검증 자릿수가 맞으면 대체한다.
 * 검증 자릿수의 예외는 하이픈 형식에서 성별 자리가 3 또는 4이고 생년월일이 2020-10-01 이후인 번호다.
 * 이 시점부터 발급된 번호는 임의 숫자라 검증 자릿수를 계산하지 못한다. 생년월일이 오늘 이후인 번호는 제외한다.
 * 그 밖의 번호는 검증 자릿수가 맞을 때만 대체한다.
 *
 * @param {() => Date} [clock]
 * @returns {(match: string) => boolean}
 */
export function createRrnValidator(clock = () => new Date()) {
  return (match) => {
    const digits = match.replace("-", "");
    if (rrnChecksumValid(digits)) return true;
    const gender = digits[6];
    if (!match.includes("-") || (gender !== "3" && gender !== "4")) return false;
    const born = Number(digits.slice(0, 6));
    return born >= RRN_RANDOM_ISSUE_FROM && born <= todayYymmdd(clock());
  };
}

export const rrnValid = createRrnValidator();

const CARD_KEYWORD = /card|카드|visa|mastercard|amex|cvc|cvv|신용/i;

/** 카드 번호 후보 앞뒤로 이 길이 안에 카드 단어가 있으면 문맥이 있다고 본다. */
const CARD_CONTEXT_WINDOW = 24;

/** EAN-13 검증 자릿수. */
function ean13Valid(digits) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (digits.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(12) - 48;
}

/**
 * 카드 번호 후보 판정. 숫자 13~19개, 발급사 앞자리, Luhn을 만족해야 한다.
 * 구분자 없는 연속 숫자는 앞뒤 24자 안에 카드 단어가 있어야 하고, 13자리 연속 숫자 중
 * 880으로 시작하거나 EAN-13 검증 자릿수가 맞는 값(바코드)은 제외한다.
 *
 * @param {string} match
 * @param {number} offset
 * @param {string} text
 * @returns {boolean}
 */
export function cardValid(match, offset = 0, text = match) {
  const digits = match.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19 || !cardPrefixPlausible(digits) || !luhnValid(digits)) return false;
  if (digits.length !== match.length) return true;
  if (digits.length === 13 && (digits.startsWith("880") || ean13Valid(digits))) return false;

  const before = text.slice(Math.max(0, offset - CARD_CONTEXT_WINDOW), offset);
  const after  = text.slice(offset + match.length, offset + match.length + CARD_CONTEXT_WINDOW);
  return CARD_KEYWORD.test(before) || CARD_KEYWORD.test(after);
}

/** 숫자를 4개 이상 포함하고 영문자를 포함하는 토큰인지 본다. 하이픈 구분 식별자를 거른다. */
function looksLikeKeyMaterial(match) {
  const digits = match.replace(/\D/g, "").length;
  return digits >= 4 && /[A-Za-z]/.test(match);
}

/** Bearer 뒤 토큰이 숫자를 포함하는지 본다. 일반 단어와 식별자를 거른다. */
function bearerTokenHasDigit(match) {
  return /\d/.test(match.replace(/^Bearer\s+/, ""));
}

const EMAIL_LOCAL_CHAR = /[a-zA-Z0-9._%+-]/;
const EMAIL_DOMAIN     = /[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/y;

/**
 * 이메일 대체. `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` 정규식과 같은 일치를 선형 시간에 찾는다.
 * '@' 위치에서 좌우로 확장하므로 '@'가 없는 긴 문자열에서 시작 위치마다 다시 훑지 않는다.
 *
 * @param {string}   text
 * @param {string}   replacement
 * @param {Function} onHit
 * @returns {string}
 */
function maskEmails(text, replacement, onHit) {
  let out  = "";
  let last = 0;
  let from = 0;
  for (let at = text.indexOf("@", from); at !== -1; at = text.indexOf("@", from)) {
    from = at + 1;
    let start = at;
    while (start > last && EMAIL_LOCAL_CHAR.test(text[start - 1])) start--;
    if (start === at) continue;
    EMAIL_DOMAIN.lastIndex = from;
    const domain = EMAIL_DOMAIN.exec(text);
    if (!domain) continue;
    out += text.slice(last, start) + replacement;
    onHit();
    last = from = from + domain[0].length;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** 대입식 값이 자리 표시자(${VAR}, <값>, $VAR)이거나 이미 가린 표식인지 본다. */
const PLACEHOLDER_VALUE = /^(?:\$\{|\$[A-Za-z_]|<|%[A-Za-z_]+%$)|\[REDACTED/;

/**
 * 비밀 이름 대입식의 값이 비밀로 보이는지 본다. 숫자를 포함하거나 16자 이상이어야 하고 자리 표시자가 아니어야 한다.
 *
 * @param {string} match 이름, 구분자, 값을 포함한 일치 문자열
 * @returns {boolean}
 */
function assignmentValueLooksSecret(match) {
  const value = match.replace(SECRET_ASSIGNMENT_HEAD, "");
  if (PLACEHOLDER_VALUE.test(value)) return false;
  return /\d/.test(value) || value.length >= 16;
}

/** 표 한 줄을 만든다. */
const rule = (id, severity, pattern, { store = null, log = null, ...extra } = {}) =>
  Object.freeze({ id, severity, pattern, store, log, ...extra });

/** 대체 구현(apply)만 쓰는 규칙. 정규식 패턴이 없다. */
const applied = (id, severity, apply, options) => rule(id, severity, null, { ...options, apply });

/** PEM 줄 구분자: 줄바꿈 또는 이스케이프된 \n, \r\n. 줄바꿈이 공백으로 바뀐 한 줄 키는 공백을 구분자로 본다(아래 정규식). */
const PEM_BREAK = String.raw`(?:\r?\n|\\r\\n|\\n)`;
const PEM_LABEL = String.raw`[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?`;

const PRIVATE_KEY_BLOCK = new RegExp(
  String.raw`-----BEGIN ${PEM_LABEL}-----`
  + String.raw`[ \t]*(?:${PEM_BREAK})?`
  + String.raw`(?:[A-Za-z][A-Za-z-]*:[^\r\n]*\r?\n)*(?:\r?\n)?`
  + String.raw`[A-Za-z0-9+/=]{40,}`
  + String.raw`(?:${PEM_BREAK}[A-Za-z0-9+/=]+|[ \t]+[A-Za-z0-9+/=]{16,})*`
  + String.raw`(?:[ \t]+[A-Za-z0-9+/=]{1,15}(?=[ \t]*${PEM_BREAK}?-----END))?`
  + String.raw`(?:(?:${PEM_BREAK}|[ \t]+)?-----END ${PEM_LABEL}-----)?`,
  "g"
);

/** 값이 비밀인 대입식의 이름 꼬리: API 키, 비밀, 토큰, 비밀번호, 접근 키, 개인 키, 자격 증명(뒤에 _BASE, _VALUE, _B64 허용) */
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]{0,64}?(?:api[_-]?key|apikey|secret(?:[_-]?key)?|token|passw(?:or)?d|access[_-]?key|private[_-]?key|credentials?)(?:[_-]?(?:base|value|b64|base64))?`;
const SECRET_SEP  = String.raw`["']?[ \t]*[:=][ \t]*["']?`;

/** 비밀 이름 대입식. 이름과 구분자는 남기고 값만 가린다. 이름은 단어 경계에서 시작한다. */
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(${SECRET_NAME})(${SECRET_SEP})([^\s"'\x60,;]{8,256})`, "gi");

/** 일치 문자열에서 값 앞부분(이름과 구분자)을 떼는 정규식 */
const SECRET_ASSIGNMENT_HEAD = new RegExp(String.raw`^${SECRET_NAME}${SECRET_SEP}`, "i");

/** AWS 비밀 접근 키 대입식(40자 base64 값) */
const AWS_SECRET_ASSIGNMENT = new RegExp(
  String.raw`((?:aws_?)?secret_?access_?key|aws_?secret_?key)(${SECRET_SEP})[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])`, "gi");

/** URL 사용자 정보의 비밀번호(scheme://user:password@). 이메일 규칙보다 먼저 적용해 비밀번호 일부가 남지 않게 한다. */
const URL_CREDENTIALS = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/[^\s:/@]{1,256}:)[^\s/]{1,512}@/g;

const HIGH = "high";
const LOW  = "low";

const KEY_MARK   = "[REDACTED_API_KEY]";
const TOKEN_MARK = "[REDACTED_TOKEN]";

/**
 * 규칙 표. URL 자격 증명 규칙, 저장 경로 레거시 규칙, 로그 전용 규칙, 공용 규칙 순서로 둔다.
 * URL 자격 증명 규칙은 이메일 규칙이 비밀번호 뒷부분을 이메일로 읽어 앞부분을 남기지 않도록 맨 앞에 둔다.
 * 로그 전용 규칙은 표에 적힌 순서로 적용한다. Authorization 헤더가 Bearer 값 규칙보다 앞서고,
 * mmcp_session 쿠키가 mmcp_ 키 규칙보다 앞선다. 비밀 이름 대입식 규칙은 개별 형식 규칙 뒤에 둔다.
 */
export const SENSITIVE_PATTERNS = Object.freeze([
  rule("url_credentials", HIGH, URL_CREDENTIALS, {
    store : (match, prefix) => `${prefix}[REDACTED_PWD]@`,
    log   : "$1****@",
    masked: (match) => /:\[REDACTED_PWD\]@$/.test(match) || /:\*\*\*\*@$/.test(match)
  }),
  rule("api_key_legacy", HIGH, /(sk-[a-zA-Z0-9]{32,}|AIza[0-9A-Za-z-_]{35})/g,
    { store: KEY_MARK, legacy: true }),
  applied("email", LOW, maskEmails, { store: "[REDACTED_EMAIL]", legacy: true }),
  rule("password_field", HIGH, /(password|passwd|pwd|비밀번호|비번)\s*[:=]\s*[^\s,]+/gi,
    { store: (match, label) => `${label}: [REDACTED_PWD]`, legacy: true, masked: (match) => /\[redacted_pwd\]$/i.test(match) }),
  rule("phone_kr", LOW, /01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g,
    { store: "[REDACTED_PHONE]", legacy: true }),

  /** Authorization: Bearer <token> */
  rule("log_authorization_header", HIGH, /(Authorization\s*[:=]\s*Bearer\s+)\S+/gi, { log: "$1****" }),
  /** 값 자체가 "Bearer <token>" 형태인 경우 (헤더 객체 value) */
  rule("log_bearer_value", HIGH, /^(Bearer\s+)\S+$/i, { log: "$1****" }),
  /** Cookie 헤더의 mmcp_session 값. mmcp_ 키 규칙보다 먼저 처리한다 */
  rule("log_session_cookie", HIGH, /(mmcp_session\s*=\s*)[^;\s"]+/g, { log: "$1****" }),
  /** mmcp_ API 키 (mmcp_session= 뒤가 아닌 경우) */
  rule("log_mmcp_key", HIGH, /\bmmcp_(?!session\s*=)[A-Za-z0-9_-]+/g, { log: "mmcp_****" }),
  rule("log_oauth_code", HIGH, /("code"\s*:\s*")[^"]+"/g, { log: "$1****\"" }),
  rule("log_oauth_refresh_token", HIGH, /("refresh_token"\s*:\s*")[^"]+"/g, { log: "$1****\"" }),
  rule("log_oauth_access_token", HIGH, /("access_token"\s*:\s*")[^"]+"/g, { log: "$1****\"" }),

  rule("anthropic_key", HIGH, /sk-ant-[A-Za-z0-9_-]{20,}/g, { store: KEY_MARK, log: "sk-ant-****" }),
  rule("openai_project_key", HIGH, /sk-proj-[A-Za-z0-9_-]{20,}/g, { store: KEY_MARK, log: "sk-proj-****" }),
  rule("api_key_generic", HIGH, /(?<![A-Za-z0-9_])sk-[A-Za-z0-9][A-Za-z0-9_-]{31,}/g,
    { store: KEY_MARK, validate: looksLikeKeyMaterial }),
  rule("github_token", HIGH, /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g,
    { store: TOKEN_MARK, log: TOKEN_MARK }),
  rule("aws_access_key", HIGH, /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    { store: KEY_MARK, log: KEY_MARK, caseSensitive: true }),
  rule("slack_token", HIGH, /xox[abprs]-[A-Za-z0-9-]{10,}/g, { store: TOKEN_MARK, log: TOKEN_MARK }),
  rule("stripe_key", HIGH, /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, { store: KEY_MARK, log: KEY_MARK }),
  rule("gitlab_token", HIGH, /(?<![A-Za-z0-9_-])gl(?:pat|dt|rt|ptt|cbt|soat|ft|imt)-[A-Za-z0-9_-]{20,}/g,
    { store: TOKEN_MARK, log: TOKEN_MARK }),
  rule("npm_token", HIGH, /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, { store: TOKEN_MARK, log: TOKEN_MARK }),
  rule("aws_secret_key", HIGH, AWS_SECRET_ASSIGNMENT,
    { store: (match, name, sep) => `${name}${sep}[REDACTED_SECRET]` }),
  rule("jwt", HIGH, /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    { store: TOKEN_MARK, log: TOKEN_MARK }),
  /**
   * 머리말 뒤에 base64 40자 이상의 키 본문이 있을 때만 일치한다. 본문은 줄바꿈이나 이스케이프된 `\n`으로 이어진 base64 줄이고,
   * 줄바꿈이 공백으로 바뀐 한 줄 키는 16자 이상의 base64 토큰이 공백으로 이어진 형태다(마지막 짧은 토큰은 닫는 표지가 바로 뒤에 있을 때).
   * base64가 아닌 첫 줄에서 끝난다. 본문 바로 뒤에 닫는 표지가 있으면 표지까지 가린다. 머리말만 언급한 글은 일치하지 않는다.
   * 각 토큰 앞의 구분자가 필수이고 base64에 공백이 없어 토큰을 나누는 방법이 하나뿐이며 선형으로 끝난다.
   */
  rule("private_key", HIGH, PRIVATE_KEY_BLOCK, { store: "[REDACTED_PRIVATE_KEY]", log: "[REDACTED_PRIVATE_KEY]" }),
  rule("mmcp_key", HIGH, /(?<![A-Za-z0-9_])mmcp_(?!session\s*=)[A-Za-z0-9_-]{20,}/g, { store: "mmcp_[REDACTED_KEY]" }),
  rule("bearer_token", HIGH, /(?<![A-Za-z0-9])Bearer[ \t]+[A-Za-z0-9._~+/-]{16,}=*/g,
    { store: `Bearer ${TOKEN_MARK}`, validate: bearerTokenHasDigit }),
  rule("rrn_kr", HIGH, /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-?[1-8]\d{6}(?!\d)/g,
    { store: "[REDACTED_RRN]", validate: rrnValid }),
  rule("card_number", HIGH,
    /(?<!\d)(?:\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?:\1\d{1,3})?|\d{4}([ -])\d{6}\2\d{5}|\d{13,19})(?!\d)/g,
    { store: "[REDACTED_CARD]", validate: cardValid }),
  /** API_KEY=, *_SECRET=, *_TOKEN=, password: 같은 대입식의 값. 숫자를 포함하거나 16자 이상인 값만 가린다 */
  rule("secret_assignment", HIGH, SECRET_ASSIGNMENT,
    { store: (match, name, sep) => `${name}${sep}[REDACTED_SECRET]`, validate: assignmentValueLooksSecret })
]);

/**
 * 경로별 규칙 목록. 표의 순서를 유지한다.
 *
 * @param {"store"|"log"} scope
 * @returns {ReadonlyArray<Object>}
 */
export function patternsFor(scope) {
  return SENSITIVE_PATTERNS.filter((entry) => entry[scope] !== null);
}
