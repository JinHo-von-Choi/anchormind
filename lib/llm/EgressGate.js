/**
 * LLM 외부 전송 관문
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * llmJson이 호출 하나마다 관문을 연다. 관문은 세 가지를 한다.
 *   1. filter(chain): 키와 workspace 정책(EgressPolicy)으로 제공자 체인을 거른다. 남는 제공자가 없으면
 *      외부로 대체하지 않고 EgressSkippedError로 단계를 건너뛴다.
 *   2. prepare(provider, prompt, options): 제공자 호출 직전에 판정을 다시 확인한다(assertEgressAllowed).
 *      외부 제공자에게는 SensitiveScanner로 가린 프롬프트를 보내고, 보내기 전에 outbox에 감사 이벤트
 *      (키, 제공자, 단계, 바이트)를 남긴다. 감사 기록에 실패하면 그 제공자에게 보내지 않는다.
 *   3. 단계와 분류별 전송 건수, 바이트, 건너뜀, 마스킹 지표를 센다.
 *
 * 호출 문맥(options.egress)
 *   { stage, keyId?, workspace?, workspaces? }
 *   keyId: 문자열이면 그 키의 정책을 쓴다. null은 master 키, 생략은 키 문맥 없음이며 둘 다 정책 없이 단계 기본값을 쓴다.
 *   stage를 생략한 호출은 등록되지 않은 단계로 보고 로컬 제공자만 쓴다.
 *
 * MEMENTO_EGRESS_POLICY=off이면 관문은 아무것도 하지 않는다(정책 조회, 거르기, 마스킹, 감사, 지표 없음).
 * 정책 조회(ApiKeyStore)와 감사 기록(outbox)은 필요할 때 동적으로 불러온다. 키 문맥과 외부 제공자가 없는
 * 호출은 DB 모듈을 불러오지 않는다.
 */

import { egressPolicyEnabled, EGRESS_LOCAL_HOSTS } from "../config.js";
import { scanText }                                from "../security/SensitiveScanner.js";
import { logWarn }                                 from "../logger.js";
import {
  classifyProvider,
  evaluateEgress,
  assertEgressAllowed,
  validateEgressPolicy,
  stageLabel,
  EgressSkippedError,
  EgressDeniedError
}                                                  from "./EgressPolicy.js";
import {
  llmEgressCallsTotal,
  llmEgressBytesTotal,
  llmEgressSkippedTotal,
  llmEgressMaskedTotal
}                                                  from "./egress-metrics.js";

/** 외부 전송 감사 이벤트의 outbox topic */
export const EGRESS_AUDIT_TOPIC = "audit.llm.egress";

/** stage를 주지 않은 호출의 단계 이름 */
const UNLABELED_STAGE = "unlabeled";

/** 감사 이벤트를 기록하지 못해 제공자 호출을 멈출 때의 오류 */
export class EgressAuditError extends Error {
  /**
   * @param {string} stage
   * @param {string} provider
   * @param {Error}  cause
   */
  constructor(stage, provider, cause) {
    super(`LLM egress audit write failed for ${provider} (stage ${stage}): ${cause?.message ?? cause}`, { cause });
    this.name     = "EgressAuditError";
    this.code     = "LLM_EGRESS_AUDIT_FAILED";
    this.stage    = stage;
    this.provider = provider;
  }
}

/** 기본 정책 조회: api_keys.egress_policy(30초 캐시) */
async function loadKeyPolicy(keyId) {
  const { getEgressPolicy } = await import("../admin/ApiKeyStore.js");
  return getEgressPolicy(keyId);
}

/** 기본 감사 기록: outbox 독립 트랜잭션 */
async function writeAuditEvent(event) {
  const [{ enqueueStandalone }, { getPrimaryPool }] = await Promise.all([
    import("../outbox/Outbox.js"),
    import("../tools/db.js")
  ]);
  return enqueueStandalone(getPrimaryPool(), event);
}

/** 스위치가 꺼졌을 때의 관문: 체인과 프롬프트를 그대로 둔다. */
export const EGRESS_PASS_THROUGH = Object.freeze({
  filter : (chain) => chain,
  prepare: async (_provider, prompt, options) => ({ prompt, options })
});

/**
 * 문맥의 workspace 목록. workspace(하나)와 workspaces(여럿)를 합친다.
 *
 * @param {object} context
 * @returns {string[]}
 */
function contextWorkspaces(context) {
  const list = [context.workspace, ...(Array.isArray(context.workspaces) ? context.workspaces : [])];
  return [...new Set(list.filter((w) => typeof w === "string" && w !== ""))];
}

/** @param {string|null|undefined} keyId */
function keyContextOf(keyId) {
  if (typeof keyId === "string" && keyId !== "") return "key";
  return keyId === null ? "master" : "none";
}

/** @param {unknown} text */
function byteLength(text) {
  return typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
}

class EgressGate {
  /**
   * @param {{ stage: string, keyId: string|null|undefined, workspaces: string[], policy: object|null,
   *           localHosts: string[], audit: Function }} init
   */
  constructor({ stage, keyId, workspaces, policy, localHosts, audit }) {
    this.stage      = stage;
    this.label      = stageLabel(stage);
    this.keyId      = keyId;
    this.workspaces = workspaces;
    this.policy     = policy;
    this.localHosts = localHosts;
    this.audit      = audit;
  }

  /** 판정 입력 */
  _input(provider) {
    return {
      enabled      : true,
      policy       : this.policy,
      stage        : this.stage,
      workspaces   : this.workspaces,
      providerName : provider.name,
      providerClass: classifyProvider(provider, this.localHosts)
    };
  }

  /**
   * 정책이 허용하는 제공자만 남긴다. 순서는 유지한다.
   *
   * @param {Array<{ name: string }>} chain
   * @returns {Array<{ name: string }>}
   * @throws {EgressSkippedError} 체인이 비어 있지 않은데 남는 제공자가 없을 때
   */
  filter(chain) {
    if (chain.length === 0) return chain;
    const allowed    = [];
    let   skipReason = null;
    for (const provider of chain) {
      const input    = this._input(provider);
      const decision = evaluateEgress(input);
      if (decision.allow) {
        allowed.push(provider);
        continue;
      }
      skipReason ??= decision.reason;
      llmEgressCallsTotal.inc({ stage: this.label, provider: provider.name, provider_class: input.providerClass, outcome: "denied" });
    }
    if (allowed.length === 0) {
      llmEgressSkippedTotal.inc({ stage: this.label, reason: skipReason });
      throw new EgressSkippedError(this.stage, skipReason);
    }
    return allowed;
  }

  /**
   * 제공자 호출 직전 단계. 판정을 다시 확인하고, 외부 제공자이면 가린 프롬프트로 바꾸고 감사 이벤트를 먼저 남긴다.
   *
   * @param {{ name: string }} provider
   * @param {string} prompt
   * @param {object} options
   * @returns {Promise<{ prompt: string, options: object }>}
   * @throws {EgressDeniedError|EgressAuditError}
   */
  async prepare(provider, prompt, options) {
    const input = this._input(provider);
    try {
      assertEgressAllowed(input);
    } catch (err) {
      if (err instanceof EgressDeniedError) {
        llmEgressCallsTotal.inc({ stage: this.label, provider: provider.name, provider_class: input.providerClass, outcome: "denied" });
      }
      throw err;
    }

    const external = input.providerClass === "external";
    const scanned  = external ? scanText(prompt) : { text: prompt, rules: [] };
    const bytes    = byteLength(scanned.text) + byteLength(options?.systemPrompt);

    if (external) {
      try {
        await this.audit({
          topic      : EGRESS_AUDIT_TOPIC,
          aggregateId: keyContextOf(this.keyId) === "key" ? this.keyId : null,
          payload    : {
            key_id        : keyContextOf(this.keyId) === "key" ? this.keyId : null,
            key_context   : keyContextOf(this.keyId),
            stage         : this.stage,
            provider      : provider.name,
            provider_class: input.providerClass,
            workspaces    : this.workspaces,
            bytes,
            masked_rules  : scanned.rules.length
          }
        });
      } catch (err) {
        llmEgressCallsTotal.inc({ stage: this.label, provider: provider.name, provider_class: input.providerClass, outcome: "audit_failed" });
        logWarn(`[llm] egress audit write failed, not sending to ${provider.name}: ${err.message}`);
        throw new EgressAuditError(this.stage, provider.name, err);
      }
    }

    llmEgressCallsTotal.inc({ stage: this.label, provider: provider.name, provider_class: input.providerClass, outcome: "sent" });
    llmEgressBytesTotal.inc({ stage: this.label, provider_class: input.providerClass }, bytes);
    if (scanned.rules.length > 0) llmEgressMaskedTotal.inc({ stage: this.label }, scanned.rules.length);
    return { prompt: scanned.text, options };
  }
}

/**
 * 호출 하나의 관문을 연다.
 *
 * @param {{ stage?: string, keyId?: string|null, workspace?: string|null, workspaces?: Array<string|null> }|undefined} context
 * @param {{ enabled?: boolean, localHosts?: string[], loadPolicy?: Function, audit?: Function }} [deps]
 * @returns {Promise<{ filter: Function, prepare: Function }>}
 * @throws {EgressSkippedError} 정책을 읽지 못했거나 저장된 정책이 규칙에 맞지 않을 때
 */
export async function openEgressGate(context, deps = {}) {
  const {
    enabled    = egressPolicyEnabled(),
    localHosts = EGRESS_LOCAL_HOSTS,
    loadPolicy = loadKeyPolicy,
    audit      = writeAuditEvent
  } = deps;
  if (!enabled) return EGRESS_PASS_THROUGH;

  const ctx   = context ?? {};
  const stage = typeof ctx.stage === "string" && ctx.stage !== "" ? ctx.stage : UNLABELED_STAGE;
  const keyId = ctx.keyId;

  let policy = null;
  if (keyContextOf(keyId) === "key") {
    let raw;
    try {
      raw = await loadPolicy(keyId);
    } catch (err) {
      logWarn(`[llm] egress policy lookup failed, skipping stage ${stage}: ${err.message}`);
      llmEgressSkippedTotal.inc({ stage: stageLabel(stage), reason: "policy_unavailable" });
      throw new EgressSkippedError(stage, "policy_unavailable");
    }
    try {
      policy = validateEgressPolicy(raw ?? null);
    } catch (err) {
      logWarn(`[llm] stored egress policy is invalid, skipping stage ${stage}: ${err.message}`);
      llmEgressSkippedTotal.inc({ stage: stageLabel(stage), reason: "policy_invalid" });
      throw new EgressSkippedError(stage, "policy_invalid");
    }
  }

  return new EgressGate({ stage, keyId, workspaces: contextWorkspaces(ctx), policy, localHosts, audit });
}
