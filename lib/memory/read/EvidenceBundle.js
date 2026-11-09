/**
 * EvidenceBundle - recall 결과의 질문 의도, 근거 상태, 의도별 근거 묶음
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 *
 * recall 결과는 순위 순서의 평면 목록이다. 여러 기록을 모으거나(집계), 사건 순서를 따지거나(시간),
 * 바뀐 값을 구분해야(상태) 하는 질문에서 리더가 목록을 다시 정리하다 틀린다. 이 모듈은 결과 위에
 * 세 가지를 만든다. LLM을 부르지 않으며 DB에 닿지 않는다.
 *
 *   의도      질의 문장으로 aggregate, temporal, state, lookup을 가린다(규칙 기반)
 *   근거 상태 no_evidence, conflicting, partial, supported. 결과가 질의의 핵심 낱말을 얼마나 덮는지와
 *             충돌 표지로 정한다. 답을 하지 말아야 할 때를 리더가 알 수 있게 한다
 *   묶음      aggregate, temporal, state 의도일 때 결과를 세계 시각순 행으로 펴고, 같은 본문은 하나로 세며,
 *             결과가 잘렸는지(coverage)를 알린다
 */

import { worldTimeMs, statedAtMs } from "../WorldTime.js";

/** 질문 의도 */
export const ANSWER_INTENTS = Object.freeze(["lookup", "aggregate", "temporal", "state"]);

const AGGREGATE_RE = new RegExp([
  "몇\\s*(?:번|개|명|회|시간|일|곳|권|편|가지|군데|차례|살|달|주|년)",
  "총\\s*(?:몇|얼마|합)", "모두\\s*(?:몇|얼마)", "전부\\s*(?:몇|얼마)", "합계", "합쳐", "합하면", "통틀어",
  "얼마나\\s*(?:많이|자주)",
  "\\bhow\\s+(?:many|much|often)\\b", "\\bin\\s+total\\b", "\\btotal\\b", "\\baltogether\\b", "\\bcombined\\b",
  "\\bsum\\s+of\\b", "\\bnumber\\s+of\\b", "\\blist\\s+(?:all|every)\\b", "\\bcount\\b"
].join("|"), "i");

const TEMPORAL_RE = new RegExp([
  "언제", "며칠", "몇\\s*(?:일|주|달|개월|년)\\s*(?:전|후|뒤|동안|만에)", "얼마\\s*(?:전|동안|만에)",
  "순서", "먼저", "나중", "처음으로", "마지막으로", "이전에", "이후에", "무렵",
  "\\bwhen\\b", "\\bhow\\s+long\\b", "\\bbefore\\b", "\\bafter\\b", "\\bfirst\\b", "\\blast\\s+time\\b",
  "\\bearlier\\b", "\\blater\\b", "\\border\\b", "\\bago\\b", "\\bsince\\b", "\\buntil\\b", "\\bwhich\\s+came\\b",
  "\\bwhat\\s+(?:date|day|month|year)\\b"
].join("|"), "i");

const STATE_RE = new RegExp([
  "지금", "현재", "아직", "요즘", "바뀌", "바꿨", "변경", "원래", "예전", "이제는",
  "\\bcurrently\\b", "\\bnow\\b", "\\bstill\\b", "\\banymore\\b", "\\bchanged?\\b", "\\bused\\s+to\\b",
  "\\bpreviously\\b", "\\boriginally\\b", "\\blatest\\b", "\\bmost\\s+recent(?:ly)?\\b", "\\bswitch(?:ed)?\\b"
].join("|"), "i");

/** 근거 상태 판정에서 덮였는지 보지 않는 의문사와 기능어 */
const COVERAGE_STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "whom", "whose", "why", "how", "many", "much", "did", "does", "do",
  "is", "are", "was", "were", "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "my", "me", "i",
  "you", "your", "it", "this", "that", "have", "has", "had", "be", "been", "with", "about", "at", "by", "from",
  "time", "times", "go", "goe", "went", "gone", "get", "got", "ever", "also", "ago", "last", "first", "much", "mani",
  "tell", "know", "rememb", "can", "could", "would", "should", "will", "there", "they", "them", "we", "our",
  "언제", "무엇", "뭐", "어디", "누구", "어떻게", "얼마", "얼마나", "몇", "어느", "무슨", "왜", "내가", "나는", "제가"
]);

/** 근거 상태가 partial이 되는 핵심 낱말 덮임 비율 하한 */
export const COVERAGE_PARTIAL_BELOW = 0.5;

/** 묶음 행 본문 미리보기 길이 */
const ROW_PREVIEW_CHARS = 160;

/**
 * 질의 문장의 의도. 집계 > 시간 > 상태 > 단순 조회 순으로 먼저 걸리는 쪽을 쓴다.
 *
 * @param {string|null|undefined} text
 * @returns {"lookup"|"aggregate"|"temporal"|"state"}
 */
export function classifyAnswerIntent(text) {
  if (typeof text !== "string" || text.trim() === "") return "lookup";
  if (AGGREGATE_RE.test(text)) return "aggregate";
  if (TEMPORAL_RE.test(text)) return "temporal";
  if (STATE_RE.test(text)) return "state";
  return "lookup";
}

/**
 * 요청 인자로 의도를 정한다. intent가 auto(기본)이면 text, 없으면 keywords로 가린다.
 *
 * @param {{intent?: string, text?: string, keywords?: string[]}} args
 * @returns {{intent: string, explicit: boolean}}
 */
export function resolveAnswerIntent(args = {}) {
  if (ANSWER_INTENTS.includes(args.intent)) return { intent: args.intent, explicit: true };
  const text = args.text ?? (Array.isArray(args.keywords) ? args.keywords.join(" ") : "");
  return { intent: classifyAnswerIntent(text), explicit: false };
}

/**
 * 명시 의도가 바꾸는 recall 기본값. 호출자가 직접 준 값은 바꾸지 않는다.
 *   aggregate  pageSize 하한 30(흩어진 기록을 더 모은다)
 *   temporal   order=chronological
 *   state      includeHistory=true
 *
 * @param {Object} args - recall 인자 (바꾸지 않는다)
 * @returns {Object} 기본값을 채운 인자 사본
 */
export function applyIntentDefaults(args = {}) {
  if (!ANSWER_INTENTS.includes(args.intent)) return args;
  const out = { ...args };
  if (args.intent === "aggregate" && args.pageSize === undefined) out.pageSize = 30;
  if (args.intent === "temporal" && args.order === undefined) out.order = "chronological";
  if (args.intent === "state" && args.includeHistory === undefined) out.includeHistory = true;
  return out;
}

/**
 * 근거 상태를 정한다.
 *
 *   no_evidence  결과가 없다
 *   conflicting  상위 결과에 아직 유효한 충돌 상대가 있다
 *   partial      질의의 핵심 낱말 가운데 결과 본문이나 키워드에 나온 비율이 COVERAGE_PARTIAL_BELOW 미만이다
 *   supported    그 밖
 *
 * @param {object[]} fragments - 순위 순서의 결과
 * @param {string[]} queryTerms - 질의 토큰(소문자)
 * @param {string[][]} fragmentTerms - 결과 파편별 본문 토큰과 키워드(소문자), fragments와 같은 순서
 * @returns {{status: string, coverage: number|null, uncovered_terms: string[]}}
 */
export function evidenceStatus(fragments, queryTerms = [], fragmentTerms = []) {
  if (!Array.isArray(fragments) || fragments.length === 0) {
    return { status: "no_evidence", coverage: 0, uncovered_terms: [...new Set(keyTerms(queryTerms))] };
  }
  const terms   = [...new Set(keyTerms(queryTerms))];
  const present = new Set(fragmentTerms.flat());
  const covered = terms.filter(t => present.has(t) || [...present].some(p => p.includes(t) || t.includes(p)));
  const ratio   = terms.length > 0 ? covered.length / terms.length : null;
  const uncovered = terms.filter(t => !covered.includes(t));

  if (fragments.slice(0, 10).some(f => Array.isArray(f.conflicts_with) && f.conflicts_with.length > 0)) {
    return { status: "conflicting", coverage: ratio, uncovered_terms: uncovered };
  }
  if (ratio !== null && ratio < COVERAGE_PARTIAL_BELOW) {
    return { status: "partial", coverage: ratio, uncovered_terms: uncovered };
  }
  return { status: "supported", coverage: ratio, uncovered_terms: uncovered };
}

function keyTerms(terms) {
  return (terms ?? []).map(t => String(t).toLowerCase()).filter(t => t.length >= 2 && !COVERAGE_STOPWORDS.has(t));
}

/**
 * 파편의 시각 근거. event, mention, stored 중 세계 시각을 정한 열.
 *
 * @param {object} f
 * @returns {"event"|"mention"|"stored"|null}
 */
function timeBasisOf(f) {
  if (f.event_time) return "event";
  if (f.mention_time) return "mention";
  return f.created_at ? "stored" : null;
}

/**
 * 같은 본문으로 볼 열쇠. 공백과 대소문자, 날짜 머리("[2023/05/20 ...] ")를 무시한다.
 *
 * @param {object} f
 * @returns {string}
 */
function duplicateKey(f) {
  return String(f.content ?? "")
    .replace(/^\[[^\]]{4,40}\]\s*/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 의도별 근거 묶음. lookup 의도는 묶음을 만들지 않는다.
 *
 * @param {object[]} fragments - 순위 순서의 결과
 * @param {{intent: string, truncated?: boolean}} options - truncated는 예산이나 페이지로 후보가 잘렸는지
 * @returns {null|{intent: string, order: string, rows: object[], distinct_count: number,
 *   duplicate_ids: string[][], coverage: "truncated"|"within_results"}}
 */
export function buildEvidenceBundle(fragments, { intent, truncated = false } = {}) {
  if (!intent || intent === "lookup" || !Array.isArray(fragments)) return null;

  const indexed = fragments.map((f, index) => ({ f, index, t: worldTimeMs(f) }));
  indexed.sort((a, b) => {
    const af = Number.isFinite(a.t);
    const bf = Number.isFinite(b.t);
    if (af !== bf) return af ? -1 : 1;
    if (af && a.t !== b.t) return a.t - b.t;
    return a.index - b.index;
  });

  const groups = new Map();
  for (const { f } of indexed) {
    const key = duplicateKey(f);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f.id);
  }

  const rows = indexed.map(({ f, t }) => ({
    id        : f.id,
    time      : Number.isFinite(t) ? new Date(t).toISOString() : null,
    time_basis: timeBasisOf(f),
    ...(f.event_time_precision ? { precision: f.event_time_precision } : {}),
    ...(Number.isFinite(statedAtMs(f)) && f.mention_time ? { mentioned: new Date(statedAtMs(f)).toISOString().slice(0, 10) } : {}),
    ...(f.state ? { state: f.state } : {}),
    ...(f.conflicts_with?.length ? { conflicts_with: f.conflicts_with } : {}),
    preview   : String(f.content ?? "").slice(0, ROW_PREVIEW_CHARS)
  }));

  return {
    intent,
    order         : "chronological",
    rows,
    distinct_count: groups.size,
    duplicate_ids : [...groups.values()].filter(ids => ids.length > 1),
    coverage      : truncated ? "truncated" : "within_results"
  };
}
