/**
 * WriteGate - 의미 쓰기 단일 관문
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 파편의 의미 열(content, topic, keywords, context_summary, goal, outcome, is_anchor,
 * workspace, key_id)을 쓰는 진입점은 기록 전에 check()를 거친다. 관문은 순서가 정해진
 * 단계를 차례로 적용한다.
 *
 *   normalize  수신 길이 상한, 본문 필수와 최소 품질(생성), 키워드 정규화
 *   sensitive  비밀과 개인정보 탐지, 마스킹, 규칙 이름 경고(SensitiveScanner)
 *   length     유형별 저장 상한 절삭
 *   policy     PolicyRules 구조 제약
 *   workspace  키의 workspace 허가 집합
 *   anchor     앵커 권한 (기본 구현은 통과)
 *
 * 앞의 세 단계는 본문 단계로 쓰기 값(fields)을 바꾸고, 뒤의 세 단계는 판정 단계로 기록될
 * 파편 후보(draft)를 보고 위반을 모은다. 생성(create)은 본문 단계를 마친 입력으로 호출자가
 * 준 build를 불러 후보를 만들고, 갱신(update)은 현재 행(base)에 바뀐 값을 겹쳐 후보로 삼는다.
 *
 * 단계는 (state, deps) => state 형태이며 DB에 쓰지 않는다. 관문 전체가 쓰기 트랜잭션 밖에서
 * 실행된다. 위반은 경고로 남고, hard gate 키에서만 SymbolicPolicyViolationError로 거부한다.
 *
 * MEMENTO_WRITE_GATE=off이면 진입점별 기본 단계(LEGACY_STEPS)만 적용한다.
 *
 * 판정 단계 뒤에 생성 후보에 출처 세 값(origin, observed_client, trust_tier)을 싣는다. 이 일은 관문
 * 스위치와 무관하게 MEMENTO_PROVENANCE를 따른다(lib/memory/provenance.js).
 *
 * 마지막으로 검토 단계(lib/memory/write/ReviewQueue.js)가 검토 규칙에 걸린 쓰기에 review_state='pending'을
 * 싣고 사유를 review.* 경고로 남긴다. 이 경고는 hard gate 거부 대상이 아니다. MEMENTO_REVIEW_QUEUE를 따른다.
 */

import {
  writeGateEnabled,
  workspaceGateEnforced,
  sensitiveScanMode,
  provenanceEnabled,
  reviewQueueEnabled
} from "../../config.js";
import { logWarn, logError }                       from "../../logger.js";
import { SYMBOLIC_CONFIG }                         from "../../../config/symbolic.js";
import { symbolicMetrics }                         from "../../symbolic/SymbolicMetrics.js";
import { SymbolicPolicyViolationError }            from "../../symbolic/errors.js";
import { PolicyRules }                             from "../../symbolic/PolicyRules.js";
import { validateContentInput }                    from "../contentGuard.js";
import {
  FragmentFactory,
  normalizeKeywords,
  keywordText,
  limitContentLength
} from "./FragmentFactory.js";
import {
  scanFields,
  scanText,
  SCANNED_TEXT_FIELDS,
  SENSITIVE_RULE_PREFIX
} from "../../security/SensitiveScanner.js";
import { recordWriteGate, recordReviewFlag }       from "./write-gate-metrics.js";
import { approveGateValue, isGateApproved }        from "./gateApproval.js";
import { ORIGINS, CLAIM_ENTRIES, isOrigin, provenanceStamp } from "../provenance.js";
import { reviewStep, isReviewNotice }               from "./ReviewQueue.js";

/** 의미 쓰기 진입점 이름. 지표 라벨과 LEGACY_STEPS의 키로 쓴다. */
export const WRITE_ENTRIES = Object.freeze({
  REMEMBER         : "remember",
  AMEND            : "amend",
  BATCH            : "batch_remember",
  REFLECT          : "reflect",
  AUTO_REFLECT     : "auto_reflect",
  ADMIN_IMPORT     : "admin_import",
  CLI_IMPORT       : "cli_import",
  CLI_REMEMBER     : "cli_remember",
  CONSOLIDATE_SPLIT: "consolidate_split"
});

/** 본문 단계와 판정 단계. 이 순서로 적용한다. */
export const CONTENT_STEPS = Object.freeze(["normalize", "sensitive", "length"]);
export const VERDICT_STEPS = Object.freeze(["policy", "workspace", "anchor"]);
export const STEP_ORDER    = Object.freeze([...CONTENT_STEPS, ...VERDICT_STEPS]);

/**
 * MEMENTO_WRITE_GATE=off일 때 진입점별로 적용하는 기본 단계. remember는 모든 판정을, amend는
 * 수신 상한과 키워드 정규화를, 일괄 저장과 reflect와 CLI remember는 본문 단계를 적용한다.
 * 목록에 없는 진입점(가져오기, 통합 분할)은 아무 단계도 적용하지 않는다.
 */
export const LEGACY_STEPS = Object.freeze({
  [WRITE_ENTRIES.REMEMBER]    : Object.freeze(["normalize", "sensitive", "length", "policy", "workspace"]),
  [WRITE_ENTRIES.AMEND]       : Object.freeze(["normalize"]),
  [WRITE_ENTRIES.BATCH]       : Object.freeze(["normalize", "sensitive", "length"]),
  [WRITE_ENTRIES.REFLECT]     : Object.freeze(["normalize", "sensitive", "length"]),
  [WRITE_ENTRIES.AUTO_REFLECT]: Object.freeze(["normalize", "sensitive", "length"]),
  [WRITE_ENTRIES.CLI_REMEMBER]: Object.freeze(["normalize", "sensitive", "length"])
});

/**
 * 진입점별 본문 필드 이름. 생성은 호출자 입력(camelCase), 갱신은 열 이름(snake_case)을 쓴다.
 * 민감 정보 단계처럼 여러 본문 필드를 다루는 단계가 참조한다.
 */
export const TEXT_FIELDS = SCANNED_TEXT_FIELDS;

/**
 * 쓰기 입력이 받아들일 수 없는 형태일 때 관문이 던지는 오류. 메시지는 입력 검증 문구 그대로이고,
 * 수신 길이 상한 위반은 code -32602를 싣는다.
 */
export class WriteInputError extends Error {
  /**
   * @param {string} message
   * @param {number} [code]
   */
  constructor(message, code) {
    super(message);
    this.name = "WriteInputError";
    if (code !== undefined) this.code = code;
  }
}

export { isGateApproved };

/**
 * 위반 규칙 객체를 이름으로 바꾼다.
 *
 * @param {Object|string} v
 * @returns {string}
 */
export function ruleName(v) {
  return typeof v === "object" && v !== null && v.rule ? String(v.rule) : String(v);
}

/** 상태에 위반을 덧붙인 새 상태를 돌려준다. */
function withViolations(state, violations) {
  if (violations.length === 0) return state;
  return { ...state, violations: [...state.violations, ...violations] };
}

/**
 * normalize 본체. 수신 길이 상한을 확인하고, 생성이면 본문을 다듬고(checkQuality이면 최소 품질도
 * 검사하고), 키워드 배열을 소문자로 정규화한다.
 *
 * @param {Object}  state
 * @param {boolean} checkQuality
 * @returns {Object}
 */
function normalizeFields(state, checkQuality) {
  const fields = { ...state.fields };
  try {
    validateContentInput(fields.content);
  } catch (err) {
    throw new WriteInputError(err.message, err.code);
  }

  if (state.op === "create") {
    if (fields.content != null && typeof fields.content !== "string") {
      throw new WriteInputError("content must be a string", -32602);
    }
    const content = (fields.content || "").trim();
    if (!content) throw new WriteInputError("Fragment content is required");

    if (checkQuality) {
      const validation = FragmentFactory.validateContent(content, fields.type ?? null, fields.topic ?? null);
      if (!validation.valid) throw new WriteInputError(validation.reason);
    }
    fields.content = content;
  }

  let rawKeywords = null;
  if (Array.isArray(fields.keywords)) {
    rawKeywords = fields.keywords;
    try {
      fields.keywords = normalizeKeywords(fields.keywords);
    } catch (err) {
      throw new WriteInputError(err.message, err.code);
    }
  }
  return { ...state, fields, rawKeywords };
}

/**
 * normalize: 수신 길이 상한을 확인하고, 생성이면 본문을 다듬어 최소 품질을 검사하며,
 * 키워드 배열을 소문자로 정규화한다.
 *
 * @param {Object} state
 * @returns {Object}
 */
export function normalizeStep(state) {
  return normalizeFields(state, true);
}

/**
 * 저장된 값을 되살리는 normalize. 최소 품질 검사를 하지 않는 점만 normalizeStep과 다르다.
 *
 * @param {Object} state
 * @returns {Object}
 */
export function restoreNormalizeStep(state) {
  return normalizeFields(state, false);
}

/**
 * 아무것도 바꾸지 않는 단계.
 *
 * @param {Object} state
 * @returns {Object}
 */
export function passthroughStep(state) {
  return state;
}

/**
 * 저장된 값을 그대로 되살리는 가져오기에서 쓰는 단계 교체표. 본문 최소 품질 검사와 저장 상한 절삭을
 * 건너뛴다. 민감 정보 마스킹과 판정 단계는 그대로 적용된다.
 */
export const RESTORE_STEPS = Object.freeze({
  normalize: restoreNormalizeStep,
  length   : passthroughStep
});

/**
 * 탐지 결과를 경고 위반으로 바꾼다. 규칙 이름과 필드 이름만 싣는다.
 *
 * @param {{rule: string, severity: string, fields: string[]}} finding
 * @returns {Object}
 */
function sensitiveViolation({ rule, severity, fields }) {
  return {
    rule       : `${SENSITIVE_RULE_PREFIX}${rule}`,
    severity,
    detail     : `fields: ${fields.join(", ")}`,
    ruleVersion: "v1"
  };
}

/**
 * sensitive: 본문 필드(content, topic, contextSummary, goal, outcome)와 keywords의 비밀과 개인정보를
 * 표식으로 바꾼다. 저신뢰 탐지(이메일, 전화번호)는 가리기만 하고, 그 밖의 탐지는 규칙 이름을 경고로 남긴다.
 * keywords는 소문자로 정규화되기 전의 입력(rawKeywords)을 찾고 가린 뒤 다시 정규화한다.
 * off이면 레거시 규칙을 content에만 적용하고 경고를 남기지 않는다.
 *
 * @param {Object} state
 * @param {Object} [deps]
 * @returns {Object}
 */
export function sensitiveStep(state, deps) {
  const mode = (deps?.sensitiveScanMode ?? sensitiveScanMode)();
  if (mode === "off") {
    if (typeof state.fields.content !== "string") return state;
    const { text } = scanText(state.fields.content, { legacyOnly: true });
    return { ...state, fields: { ...state.fields, content: text } };
  }

  const raw   = Array.isArray(state.rawKeywords) ? state.rawKeywords.map(keywordText) : null;
  const input = raw ? { ...state.fields, keywords: raw } : state.fields;
  const scan  = scanFields(input, TEXT_FIELDS[state.op], { foldCaseArrays: raw === null });
  if (scan.fields === input) return state;

  const fields = raw ? { ...scan.fields, keywords: normalizeKeywords(scan.fields.keywords) } : scan.fields;
  const warned = scan.findings.filter(({ severity }) => severity !== "low");
  return withViolations({ ...state, fields }, warned.map(sensitiveViolation));
}

/**
 * length: 본문을 유형별 저장 상한으로 자른다. 갱신에서 유형을 바꾸지 않으면 현재 행의 유형을 쓴다.
 *
 * @param {Object} state
 * @returns {Object}
 */
export function lengthStep(state) {
  if (typeof state.fields.content !== "string") return state;
  const type = state.fields.type ?? state.base?.type ?? null;
  return { ...state, fields: { ...state.fields, content: limitContentLength(state.fields.content, type) } };
}

/**
 * PolicyRules 평가. 평가 자체가 실패하면 policyCheckFailed 위반으로 다룬다.
 *
 * @param {Object|null} fragment
 * @param {Object}      policyRules
 * @returns {Array<Object>}
 */
function evaluatePolicy(fragment, policyRules) {
  if (!fragment) return [];
  try {
    return policyRules.check(fragment) || [];
  } catch (err) {
    logWarn(`[WriteGate] policy rules check failed: ${err.message}`);
    return [{ rule: "policyCheckFailed", severity: "high", detail: "policy rules evaluation failed", ruleVersion: "v1" }];
  }
}

/**
 * policy: 후보 파편에 PolicyRules를 적용한다. 갱신은 현재 행에 이미 있던 위반을 빼고
 * 이번 변경으로 새로 생긴 위반만 남긴다.
 *
 * @param {Object} state
 * @param {Object} deps
 * @returns {Object}
 */
export function policyStep(state, deps) {
  if (!deps.policyGatingEnabled()) return state;

  const violations = evaluatePolicy(state.draft, deps.policyRules);
  if (state.op !== "update") return withViolations(state, violations);

  const before = new Set(evaluatePolicy(state.base, deps.policyRules).map(ruleName));
  return withViolations(state, violations.filter(v => !before.has(ruleName(v))));
}

/**
 * workspace: 기록될 workspace가 키의 허가 집합 안에 있는지 본다. 갱신은 workspace를 바꿀 때만
 * 판정한다. 판정 자체가 실패하면 workspace를 주장한 쓰기를 workspaceLookupFailed로 다룬다.
 *
 * @param {Object} state
 * @param {Object} deps
 * @returns {Promise<Object>}
 */
export async function workspaceStep(state, deps) {
  if (state.op === "update" && !Object.hasOwn(state.fields, "workspace")) return state;

  const workspace = state.draft?.workspace ?? null;
  try {
    const violation = await deps.checkWorkspaceAllowed(state.ctx.keyId, workspace);
    return violation ? withViolations(state, [violation]) : state;
  } catch (err) {
    logError(`[WriteGate] workspace 허가 판정 실패: ${err.message}`);
    if (!workspace) return state;
    return withViolations(state, [{
      rule       : "workspaceLookupFailed",
      severity   : "high",
      detail     : "workspace 허가 판정에 실패했다",
      ruleVersion: "v1"
    }]);
  }
}

/**
 * anchor: 앵커 권한 단계. 기본 구현은 통과시킨다. 키별 앵커 권한 판정은 이 자리에 들어간다.
 *
 * @param {Object} state
 * @returns {Object}
 */
export function anchorStep(state) {
  return state;
}

/**
 * 생성 후보에 출처 세 값을 싣는다. 주장을 받는 진입점(remember, batch_remember)에서 허용 밖의
 * origin은 -32602로 거부한다. MEMENTO_PROVENANCE=off이거나 갱신이면 아무것도 하지 않는다.
 * 갱신(amend)은 출처와 등급을 바꾸지 않는다.
 *
 * @param {Object} state
 * @param {Object} deps
 * @returns {Object}
 */
export function provenanceStep(state, deps) {
  if (state.op !== "create" || !deps.provenanceEnabled()) return state;
  const claim = state.fields.origin ?? null;
  if (claim !== null && CLAIM_ENTRIES.includes(state.entry) && !isOrigin(claim)) {
    throw new WriteInputError(`origin must be one of: ${ORIGINS.join(", ")}`, -32602);
  }
  const { clientName = null, trustCap } = state.ctx.provenance ?? {};
  return { ...state, draft: Object.assign(state.draft, provenanceStamp({ entry: state.entry, claim, clientName, trustCap })) };
}

/** 기본 단계 구현. */
export const DEFAULT_STEPS = Object.freeze({
  normalize: normalizeStep,
  sensitive: sensitiveStep,
  length   : lengthStep,
  policy   : policyStep,
  workspace: workspaceStep,
  anchor   : anchorStep
});

/** 민감 정보 탐지 경고인지 본다. */
function isSensitiveViolation(v) {
  return typeof v.rule === "string" && v.rule.startsWith(SENSITIVE_RULE_PREFIX);
}

/**
 * hard gate 대상 위반인지 판정한다.
 * workspaceLookupFailed는 허가를 판정하지 못한 상태라 항상 대상이다.
 * workspaceNotAllowed와 fragmentHasWorkspace는 MEMENTO_WORKSPACE_GATE=true일 때만 대상이다.
 * 민감 정보 탐지는 고신뢰(severity high) 규칙만 대상이다. 검토 대기열 경고(review.*)는 대상이 아니다.
 *
 * @param {Object} v
 * @returns {boolean}
 */
export function isGateEligible(v) {
  if (isReviewNotice(v))       return false;
  if (isSensitiveViolation(v)) return v.severity === "high";
  if (v.rule === "workspaceNotAllowed" || v.rule === "fragmentHasWorkspace") return workspaceGateEnforced();
  return true;
}

/** 위반마다 symbolic warning 지표를 남긴다. */
function recordWarnings(violations) {
  for (const v of violations) symbolicMetrics.recordWarning(`policy.${v.rule}`, v.severity || "low");
}

/**
 * 생성은 build로, 갱신은 현재 행에 바뀐 값을 겹쳐 판정 대상 후보를 만든다.
 *
 * @param {Object}   state
 * @param {Function} [build]
 * @returns {Object}
 */
function materialize(state, build) {
  if (state.op === "create") return { ...state, draft: build(state.fields) };
  return { ...state, draft: { ...(state.base || {}), ...state.fields } };
}

export class WriteGate {
  /**
   * @param {Object}   [deps]
   * @param {Object}   [deps.policyRules]           - check(fragment) => violations
   * @param {boolean|null} [deps.policyGatingEnabled] - null이면 SYMBOLIC_CONFIG 값
   * @param {(keyId: string) => Promise<boolean>} [deps.getHardGate]
   * @param {(keyId: string|null, workspace: string|null) => Promise<Object|null>} [deps.checkWorkspaceAllowed]
   * @param {Object}   [deps.steps]                 - 단계 이름별 구현. 지정하지 않은 단계는 기본 구현
   * @param {() => boolean} [deps.enabled]          - 관문 스위치
   * @param {() => string}  [deps.sensitiveScanMode] - 민감 정보 탐지 방식(mask, reject, off). 관문 스위치가 off이면 off로 본다
   * @param {() => boolean} [deps.provenance]       - 출처 스위치
   * @param {() => boolean} [deps.reviewQueue]      - 검토 대기열 스위치
   */
  constructor({
    policyRules           = new PolicyRules(),
    policyGatingEnabled   = null,
    getHardGate           = async () => false,
    checkWorkspaceAllowed = async () => null,
    steps                 = {},
    enabled               = writeGateEnabled,
    sensitiveScanMode     : scanMode = sensitiveScanMode,
    provenance            = provenanceEnabled,
    reviewQueue           = reviewQueueEnabled
  } = {}) {
    this.steps   = { ...DEFAULT_STEPS, ...steps };
    this.enabled = enabled;
    this.deps    = {
      policyRules,
      getHardGate,
      checkWorkspaceAllowed,
      sensitiveScanMode  : () => (this.enabled() ? scanMode() : "off"),
      provenanceEnabled  : provenance,
      reviewQueueEnabled : reviewQueue,
      policyGatingEnabled: () => (policyGatingEnabled !== null
        ? policyGatingEnabled
        : (SYMBOLIC_CONFIG.enabled && SYMBOLIC_CONFIG.policyRules))
    };
  }

  /**
   * 이번 호출에 적용할 단계 이름 집합.
   *
   * @param {string} entry
   * @returns {Set<string>}
   */
  activeSteps(entry) {
    if (this.enabled()) return new Set(STEP_ORDER);
    return new Set(LEGACY_STEPS[entry] ?? []);
  }

  /**
   * 의미 쓰기 하나를 관문에 통과시킨다.
   *
   * @param {Object}   request
   * @param {string}   request.entry   - WRITE_ENTRIES 값
   * @param {"create"|"update"} request.op
   * @param {Object}   request.fields  - create: 호출자 입력, update: 바뀐 열
   * @param {Object}   [request.base]  - update 대상의 현재 행
   * @param {Function} [request.build] - create: 본문 단계를 마친 입력으로 파편 후보를 만든다
   * @param {"production"|"dryRun"} [request.mode]
   * @param {"all"|"reject"|"none"} [request.metrics] - reject이면 거부만 지표에 남긴다. 같은 입력이 뒤에
   *   다시 관문을 거치는 선검증(batch_remember async)에서 통과와 경고를 두 번 세지 않게 한다.
   *   none이면 지표를 남기지 않는다(기록하지 않는 가져오기 dryRun)
   * @param {{keyId?: string|null, agentId?: string, provenance?: {clientName?: string|null, trustCap?: number}}} [request.ctx]
   *   provenance는 출처 판정 문맥(provenanceContext 결과). 없으면 관측 클라이언트 이름 없음, 키 상한 2다
   * @returns {Promise<{fields: Object, draft: Object, warnings: string[]}>}
   */
  async check({ entry, op, fields, base = null, build, mode = "production", metrics = "all", ctx = {} }) {
    const active = this.activeSteps(entry);
    let state    = {
      entry, op, mode, base, metrics,
      fields    : { ...fields },
      draft     : null,
      ctx       : { keyId: ctx.keyId ?? null, agentId: ctx.agentId ?? "default", provenance: ctx.provenance ?? {} },
      violations: []
    };

    for (const name of CONTENT_STEPS) {
      if (active.has(name)) state = await this.steps[name](state, this.deps);
    }
    state = materialize(state, build);
    for (const name of VERDICT_STEPS) {
      if (active.has(name)) state = await this.steps[name](state, this.deps);
    }
    state = provenanceStep(state, this.deps);
    state = reviewStep(state, this.deps);

    const warnings = await this._decide(state);
    this._recordReview(state);
    /** 생성은 후보, 갱신은 바뀐 열을 관문 통과 값으로 등록한다. 갱신 값은 관문 뒤에 바뀌지 않도록 얼린다. */
    if (state.op === "create") {
      return { fields: state.fields, draft: approveGateValue(state.draft), warnings };
    }
    return { fields: approveGateValue(Object.freeze({ ...state.fields })), draft: state.draft, warnings };
  }

  /**
   * 모은 위반으로 판정한다. dryRun은 이름만 돌려준다. 그 밖에는 생성 후보의
   * validation_warnings에 위반을 누적하고 지표를 남기며, hard gate 키면 거부한다.
   *
   * @param {Object} state
   * @returns {Promise<string[]>}
   */
  async _decide(state) {
    const { violations, mode } = state;
    const countAll = state.metrics === "all";
    if (mode === "dryRun") return violations.map(ruleName);
    if (violations.length === 0) {
      if (countAll) recordWriteGate(state.entry, "pass");
      return [];
    }

    if (state.op === "create") {
      const prior = Array.isArray(state.draft.validation_warnings) ? state.draft.validation_warnings : [];
      state.draft.validation_warnings = [...prior, ...violations];
    }
    if (countAll) recordWarnings(violations);

    await this._enforceHardGate(state, violations.filter(isGateEligible));
    if (countAll) recordWriteGate(state.entry, "warn");
    return violations.map(ruleName);
  }

  /**
   * 대상 위반이 있으면 거부한다. 민감 정보 탐지는 MEMENTO_SENSITIVE_SCAN=reject이면 키와 무관하게,
   * 그 밖에는 hard gate 키에서 거부한다. hard gate 조회 실패는 거부로 다룬다.
   *
   * @param {Object}        state
   * @param {Array<Object>} eligible
   */
  async _enforceHardGate(state, eligible) {
    const keyId = state.ctx.keyId;
    const meta  = { fragmentType: state.draft?.type, keyId };

    const sensitive = eligible.filter(isSensitiveViolation);
    if (sensitive.length > 0 && this.deps.sensitiveScanMode() === "reject") this._reject(state, sensitive, meta);

    if (keyId == null || eligible.length === 0) return;

    let hardGate;
    try {
      hardGate = await this.deps.getHardGate(keyId);
    } catch (err) {
      logError(`[WriteGate] hard gate lookup failed (fail-closed): ${err.message}`);
      this._recordReject(state, "hardGateLookupFailed");
      throw new SymbolicPolicyViolationError(
        [{ rule: "hardGateLookupFailed", severity: "high", detail: "hard gate lookup failed", ruleVersion: "v1" }, ...eligible],
        meta
      );
    }
    if (hardGate) this._reject(state, eligible, meta);
  }

  /**
   * 검토 표지를 단 쓰기를 사유별로 센다. dryRun과 지표를 남기지 않는 호출은 세지 않는다.
   *
   * @param {Object} state
   */
  _recordReview(state) {
    if (!state.review || state.mode === "dryRun" || state.metrics !== "all") return;
    for (const reason of state.review.reasons) recordReviewFlag(state.entry, reason);
  }

  /**
   * 위반을 거부 오류로 던진다. 지표를 남긴다.
   *
   * @param {Object}        state
   * @param {Array<Object>} rejected
   * @param {Object}        meta
   */
  _reject(state, rejected, meta) {
    this._recordReject(state, rejected[0]?.rule ?? "unknown");
    throw new SymbolicPolicyViolationError(rejected, meta);
  }

  /**
   * 거부를 지표에 남긴다. metrics가 none이면 아무것도 남기지 않는다. all이면 경고는 이미 셌으므로
   * reject 모드에서만 위반 경고를 함께 센다.
   *
   * @param {Object} state
   * @param {string} rule - 거부 사유 규칙 이름
   */
  _recordReject(state, rule) {
    if (state.metrics === "none") return;
    if (state.metrics === "reject") recordWarnings(state.violations);
    symbolicMetrics.recordGateBlock("policy", rule);
    recordWriteGate(state.entry, "reject");
  }
}
