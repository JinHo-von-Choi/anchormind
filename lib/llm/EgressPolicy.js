/**
 * 외부 전송 정책 판정
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * LLM 제공자로 기억 내용을 보낼지 정하는 순수 함수 모음이다. DB, 설정, 네트워크에 접근하지 않는다.
 *
 * 정책 값(api_keys.egress_policy jsonb)
 *   {
 *     "local_only"        : boolean,              로컬 제공자만 쓴다
 *     "approved_providers": string[] | null,      외부로 보낼 수 있는 제공자 이름. null은 구성된 제공자 전부
 *     "workspaces"        : { "<workspace>": { "local_only"?: boolean, "approved_providers"?: string[] | null } }
 *   }
 *   모든 필드는 생략할 수 있다. 생략한 값은 workspace 재정의, 키 값, 단계 기본값 순으로 정한다.
 *
 * 단계 기본값: EXTERNAL_DEFAULT_STAGES의 여섯 단계(기존 LLM 기능, 소유자 결정 6)는 구성된 제공자를 그대로 쓴다.
 * KNOWN_STAGES의 그 밖의 단계와 등록되지 않은 단계는 로컬만 쓴다. 새 외부 전송 기능은 KNOWN_STAGES에
 * "local_only" 기본값으로 단계를 더하고, 키나 workspace의 명시 허용으로만 외부 제공자를 쓴다.
 * 로컬 제공자는 정책과 관계없이 허용한다. 로컬은 접속 대상 호스트가 루프백이거나 운영자가 지정한 호스트인 HTTP
 * 제공자다. CLI 제공자는 외부다.
 */

/**
 * 정책이 없을 때 구성된 제공자를 그대로 쓰는 단계(기존 LLM 기능 여섯 개). 이 목록은 늘리지 않는다.
 * 새 단계는 KNOWN_STAGES에 local_only 기본값으로 더한다.
 */
export const EXTERNAL_DEFAULT_STAGES = Object.freeze([
  "contradiction",
  "auto_reflect",
  "evaluate",
  "split",
  "synthetic_query",
  "morpheme"
]);

/** 단계 기본값 */
export const STAGE_DEFAULT = Object.freeze({ CONFIGURED: "configured", LOCAL_ONLY: "local_only" });

/**
 * 호출자가 쓸 수 있는 단계 이름과 정책이 없을 때의 기본값. EXTERNAL_DEFAULT_STAGES 밖의 항목은 모두 local_only다.
 * 구조 검사(tests/structure/llm-egress.test.js)는 호출자가 이 표의 단계 이름만 쓰는지 본다.
 */
export const KNOWN_STAGES = Object.freeze(Object.fromEntries(
  EXTERNAL_DEFAULT_STAGES.map((stage) => [stage, STAGE_DEFAULT.CONFIGURED])
));

/** 지표 표지에 쓰는, 등록되지 않은 단계의 이름 */
const OTHER_STAGE = "other";

/** 접속 주소와 관계없이 외부로 보는 CLI 제공자 */
const CLI_PROVIDERS = new Set(["gemini-cli", "agy-cli", "codex-cli", "copilot-cli", "qwen-cli", "opencode-cli"]);

/** approved_providers 항목 수 상한 */
export const MAX_APPROVED_PROVIDERS = 32;

/** workspaces 재정의 항목 수 상한 */
export const MAX_POLICY_WORKSPACES = 64;

/** workspace 이름과 제공자 이름의 길이 상한 */
const MAX_NAME_LENGTH = 128;

/** 키 수준에서 쓸 수 있는 필드와 workspace 재정의에서 쓸 수 있는 필드 */
const KEY_FIELDS       = Object.freeze(["local_only", "approved_providers", "workspaces"]);
const WORKSPACE_FIELDS = Object.freeze(["local_only", "approved_providers"]);

/** 정책 값이 규칙에 맞지 않을 때의 오류. path는 문제가 된 위치다(예: egress_policy.workspaces.a.local_only). */
export class EgressPolicyValidationError extends Error {
  /**
   * @param {string} path
   * @param {string} message
   */
  constructor(path, message) {
    super(message);
    this.name = "EgressPolicyValidationError";
    this.code = "invalid_egress_policy";
    this.path = path;
  }
}

/**
 * 정책에 따라 단계를 건너뛸 때의 오류. 외부 제공자로 대체하지 않았음을 뜻한다.
 * reason: local_only | not_approved | policy_unavailable | policy_invalid
 */
export class EgressSkippedError extends Error {
  /**
   * @param {string} stage
   * @param {string} reason
   */
  constructor(stage, reason) {
    super(`LLM stage ${stage} skipped by egress policy (${reason})`);
    this.name   = "EgressSkippedError";
    this.code   = "LLM_EGRESS_SKIPPED";
    this.stage  = stage;
    this.reason = reason;
  }
}

/** 판정이 거부한 제공자에게 보내려 할 때의 오류. 호출 직전 확인(assertEgressAllowed)이 던진다. */
export class EgressDeniedError extends Error {
  /**
   * @param {string} stage
   * @param {string} provider
   * @param {string} reason
   */
  constructor(stage, provider, reason) {
    super(`LLM provider ${provider} denied for stage ${stage} by egress policy (${reason})`);
    this.name     = "EgressDeniedError";
    this.code     = "LLM_EGRESS_DENIED";
    this.stage    = stage;
    this.provider = provider;
    this.reason   = reason;
  }
}

/**
 * 지표 표지용 단계 이름. 등록되지 않은 단계는 other로 묶어 표지 수를 고정한다.
 *
 * @param {unknown} stage
 * @returns {string}
 */
export function stageLabel(stage) {
  return Object.hasOwn(KNOWN_STAGES, stage) ? stage : OTHER_STAGE;
}

/**
 * URL의 hostname이 루프백 주소인지 본다. URL 해석기가 정규화한 형태(소문자, IPv6 대괄호, IPv4 점 표기)를 받는다.
 *
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  if (host === "localhost") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === "[::1]") return true;
  return /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

/**
 * 제공자를 로컬과 외부로 나눈다. 접속 주소를 해석할 수 없으면 외부다.
 *
 * @param {{ name: string, baseUrl?: string|null, config?: { baseUrl?: string|null } }} provider
 * @param {string[]} [localHosts] - 로컬로 볼 호스트 이름(소문자로 비교)
 * @returns {"local"|"external"}
 */
export function classifyProvider(provider, localHosts = []) {
  if (CLI_PROVIDERS.has(provider?.name)) return "external";
  const baseUrl = provider?.baseUrl ?? provider?.config?.baseUrl ?? null;
  if (typeof baseUrl !== "string" || baseUrl === "") return "external";

  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "external";
  }
  if (isLoopbackHost(host)) return "local";
  return localHosts.some((h) => String(h).toLowerCase() === host) ? "local" : "external";
}

/** 일반 객체 여부 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 제어 문자(U+0000 부터 U+001F, U+007F) 포함 여부 */
function hasControlChar(text) {
  return Array.from(text).some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

/** 이름 형식: 빈 값, 앞뒤 공백, 제어 문자, 길이 초과를 거부한다. */
function isValidName(name) {
  return typeof name === "string" && name !== "" && name === name.trim()
    && name.length <= MAX_NAME_LENGTH && !hasControlChar(name);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]|null} knownProviders
 * @returns {string[]|null}
 */
function validateApprovedProviders(value, path, knownProviders) {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new EgressPolicyValidationError(path, `${path} must be null or an array of provider names`);
  }
  for (const name of value) {
    if (!isValidName(name)) {
      throw new EgressPolicyValidationError(path, `${path} entries must be non-empty provider names`);
    }
    if (knownProviders && !knownProviders.includes(name)) {
      throw new EgressPolicyValidationError(path, `${path} has an unknown provider: ${name}`);
    }
  }
  const unique = [...new Set(value)];
  if (unique.length > MAX_APPROVED_PROVIDERS) {
    throw new EgressPolicyValidationError(path, `${path} must have at most ${MAX_APPROVED_PROVIDERS} entries`);
  }
  return unique;
}

/**
 * local_only, approved_providers 필드를 검사해 결과 객체에 담는다.
 *
 * @param {object} source
 * @param {string} path
 * @param {string[]} allowedFields
 * @param {string[]|null} knownProviders
 * @returns {object}
 */
function validateRuleFields(source, path, allowedFields, knownProviders) {
  for (const field of Object.keys(source)) {
    if (!allowedFields.includes(field)) {
      throw new EgressPolicyValidationError(`${path}.${field}`, `unknown egress policy field: ${path}.${field}`);
    }
  }
  const out = {};
  if (Object.hasOwn(source, "local_only")) {
    if (typeof source.local_only !== "boolean") {
      throw new EgressPolicyValidationError(`${path}.local_only`, `${path}.local_only must be a boolean`);
    }
    out.local_only = source.local_only;
  }
  if (Object.hasOwn(source, "approved_providers")) {
    out.approved_providers = validateApprovedProviders(source.approved_providers, `${path}.approved_providers`, knownProviders);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]|null} knownProviders
 * @returns {Object<string, object>}
 */
function validateWorkspaces(value, path, knownProviders) {
  if (!isPlainObject(value)) {
    throw new EgressPolicyValidationError(path, `${path} must be an object keyed by workspace`);
  }
  const names = Object.keys(value);
  if (names.length > MAX_POLICY_WORKSPACES) {
    throw new EgressPolicyValidationError(path, `${path} must have at most ${MAX_POLICY_WORKSPACES} entries`);
  }
  const out = {};
  for (const name of names) {
    if (!isValidName(name)) {
      throw new EgressPolicyValidationError(path, `${path} keys must be workspace names without surrounding whitespace or control characters`);
    }
    const entryPath = `${path}.${name}`;
    if (!isPlainObject(value[name])) {
      throw new EgressPolicyValidationError(entryPath, `${entryPath} must be an object`);
    }
    out[name] = validateRuleFields(value[name], entryPath, WORKSPACE_FIELDS, knownProviders);
  }
  return out;
}

/**
 * 정책 값을 검증하고 정규화한다. null은 정책 없음이다.
 *
 * @param {unknown} value
 * @param {{ knownProviders?: string[]|null }} [options] - 주면 approved_providers 이름을 이 목록과 대조한다
 * @returns {object|null}
 * @throws {EgressPolicyValidationError}
 */
export function validateEgressPolicy(value, { knownProviders = null } = {}) {
  if (value === null) return null;
  const path = "egress_policy";
  if (!isPlainObject(value)) {
    throw new EgressPolicyValidationError(path, "egress_policy must be null or an object");
  }
  const out = validateRuleFields(value, path, KEY_FIELDS, knownProviders);
  if (Object.hasOwn(value, "workspaces")) {
    out.workspaces = validateWorkspaces(value.workspaces, `${path}.workspaces`, knownProviders);
  }
  return out;
}

/**
 * 정책이 없을 때 단계가 로컬만 쓰는지. EXTERNAL_DEFAULT_STAGES에 있고 KNOWN_STAGES 값도 configured일 때만 거짓이다.
 *
 * @param {string} stage
 * @returns {boolean}
 */
export function stageDefaultLocalOnly(stage) {
  return !(EXTERNAL_DEFAULT_STAGES.includes(stage) && KNOWN_STAGES[stage] === STAGE_DEFAULT.CONFIGURED);
}

/**
 * 단계와 workspace에 적용할 규칙을 정한다.
 *
 * @param {object|null|undefined} policy - validateEgressPolicy를 통과한 값
 * @param {string|null|undefined} workspace
 * @param {string} stage
 * @returns {{ localOnly: boolean, approvedProviders: string[]|null }}
 */
export function resolveEgressRule(policy, workspace, stage) {
  const keyRule = policy ?? {};
  const wsRule  = (typeof workspace === "string" && isPlainObject(keyRule.workspaces) && isPlainObject(keyRule.workspaces[workspace]))
    ? keyRule.workspaces[workspace]
    : {};
  const stageDefault = stageDefaultLocalOnly(stage);

  const localOnly = wsRule.local_only ?? keyRule.local_only ?? stageDefault;
  const approved  = Object.hasOwn(wsRule, "approved_providers") ? wsRule.approved_providers
                  : Object.hasOwn(keyRule, "approved_providers") ? keyRule.approved_providers
                  : null;
  return { localOnly, approvedProviders: approved ?? null };
}

/**
 * 판정 표. 스위치가 꺼져 있으면 허용, 로컬은 허용, local_only면 외부 거부,
 * 허용 목록이 null이면 구성된 외부 제공자 허용, 목록이 있으면 목록에 든 외부 제공자만 허용한다.
 *
 * @param {{ enabled: boolean, providerClass: "local"|"external", providerName: string,
 *           rule: { localOnly: boolean, approvedProviders: string[]|null } }} input
 * @returns {{ allow: boolean, reason: "switch_off"|"local"|"local_only"|"configured"|"approved"|"not_approved" }}
 */
export function decideEgress({ enabled, providerClass, providerName, rule }) {
  if (!enabled)                        return { allow: true,  reason: "switch_off" };
  if (providerClass === "local")       return { allow: true,  reason: "local" };
  if (rule.localOnly)                  return { allow: false, reason: "local_only" };
  if (rule.approvedProviders === null) return { allow: true,  reason: "configured" };
  return rule.approvedProviders.includes(providerName)
    ? { allow: true,  reason: "approved" }
    : { allow: false, reason: "not_approved" };
}

/**
 * 호출 하나에 걸린 모든 workspace에 대해 판정한다. 하나라도 거부하면 거부한다. workspace가 없으면 키 단위로 판정한다.
 *
 * @param {{ enabled: boolean, policy: object|null|undefined, stage: string, workspaces?: Array<string|null|undefined>,
 *           providerName: string, providerClass: "local"|"external" }} input
 * @returns {{ allow: boolean, reason: string }}
 */
export function evaluateEgress({ enabled, policy, stage, workspaces = [], providerName, providerClass }) {
  const named   = workspaces.filter((w) => typeof w === "string" && w !== "");
  const targets = named.length > 0 ? [...new Set(named)] : [null];
  let decision  = null;
  for (const workspace of targets) {
    decision = decideEgress({ enabled, providerClass, providerName, rule: resolveEgressRule(policy, workspace, stage) });
    if (!decision.allow) return decision;
  }
  return decision;
}

/**
 * evaluateEgress가 거부하면 EgressDeniedError를 던지고, 허용하면 판정을 돌려준다.
 *
 * @param {Parameters<typeof evaluateEgress>[0]} input
 * @returns {{ allow: true, reason: string }}
 * @throws {EgressDeniedError}
 */
export function assertEgressAllowed(input) {
  const decision = evaluateEgress(input);
  if (!decision.allow) throw new EgressDeniedError(input.stage, input.providerName, decision.reason);
  return decision;
}
