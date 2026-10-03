/**
 * RecallEvalSet - 검색 평가 세트 형식, 검증, 적재
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 평가 세트는 부분집합별 JSONL 파일 한 벌이다. 한 줄이 질의 하나이며, 정답은
 * 대상 DB에 이미 있는 파편의 id와 관련도 등급이다. 저장문을 적재해 정답을 만드는
 * 골드셋(RecallBenchmark)과 달리 질의 작성과 정답 라벨링을 분리할 수 있다.
 * 라벨이 아직 없는 줄은 미라벨로 세고 지표에서 뺀다.
 */

import { readFile, readdir } from "node:fs/promises";
import path                  from "node:path";

/** 부분집합. 파일 이름이 `<부분집합>.jsonl` 이다. */
export const SUBSETS = Object.freeze([
  "human_ko",
  "identifier",
  "temporal_holdout",
  "paraphrase_blind",
  "hard_negative",
  "synthetic"
]);

/** 질의 표기 층화 태그. */
export const TAGS = Object.freeze(["spacing", "particle", "en_identifier", "mixed_ko_en"]);

/** 사람 작성 질의의 영역. */
export const DOMAINS = Object.freeze(["research", "coding", "ops", "schedule"]);

/** 정답 관련도 등급. 높을수록 직접 답이 되는 파편이다. */
export const GRADES = Object.freeze([1, 2, 3]);

/** 사람 작성 한국어 질의 목표 건수. */
export const HUMAN_QUERY_TARGET = 150;

/** 지표 요약에서 따로 보고하는 부분집합. */
export const AUXILIARY_SUBSETS = Object.freeze(["synthetic"]);

/** 실제 질의를 두는 하위 디렉터리. 버전 관리에서 제외하는 경로이며 같은 부분집합 파일 이름을 쓴다. */
export const PRIVATE_DIR = "private";

/** 예시 파일 이름. 어느 부분집합의 줄이든 담을 수 있고 기본 적재에서 제외된다. */
export const EXAMPLE_FILE = "example.jsonl";

const ALLOWED_KEYS = new Set([
  "id", "subset", "query", "keywords", "tags", "domain", "relevant", "distractors",
  "workspace", "referenceDate", "author", "example"
]);

const ID_PATTERN   = /^[A-Za-z0-9._-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HANGUL       = /[가-힣]/;
const LATIN        = /[A-Za-z]/;
const MAX_QUERY    = 500;
const MAX_KEYWORDS = 20;

/** 평가 세트 형식 위반. details에 위반 사유 배열을 담는다. */
export class EvalSetError extends Error {
  /**
   * @param {string}   message
   * @param {string[]} [details]
   */
  constructor(message, details = []) {
    super(message);
    this.name    = "EvalSetError";
    this.details = details;
  }
}

/**
 * JSONL 본문을 객체 배열로 파싱한다. 빈 줄과 `//` 로 시작하는 줄은 건너뛴다.
 *
 * @param {string} raw
 * @param {string} label 오류 메시지에 쓰는 이름
 * @returns {Object[]}
 */
export function parseJsonl(raw, label) {
  return raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("//"))
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`${label} ${i + 1}번째 줄 파싱 실패: ${err.message}`, { cause: err });
      }
    });
}

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * tags 필드를 검증한다.
 *
 * @param {Object} entry
 * @param {string} at
 * @returns {string[]}
 */
function validateTags(entry, at) {
  if (entry.tags === undefined) return [];
  if (!Array.isArray(entry.tags)) return [`${at}: tags는 배열이어야 한다`];

  const errors = [];
  const query  = typeof entry.query === "string" ? entry.query : "";
  for (const tag of entry.tags) {
    if (!TAGS.includes(tag)) errors.push(`${at}: 알 수 없는 tag "${tag}" (${TAGS.join("|")})`);
  }
  if (new Set(entry.tags).size !== entry.tags.length) errors.push(`${at}: tags에 중복이 있다`);
  if (entry.tags.includes("en_identifier") && !LATIN.test(query)) {
    errors.push(`${at}: en_identifier tag인데 질의에 영문자가 없다`);
  }
  if (entry.tags.includes("mixed_ko_en") && !(LATIN.test(query) && HANGUL.test(query))) {
    errors.push(`${at}: mixed_ko_en tag인데 질의에 한글과 영문자가 함께 없다`);
  }
  return errors;
}

/**
 * keywords 필드를 검증한다. 클라이언트가 질의와 함께 보내는 키워드를 그대로 재현할 때 쓴다.
 *
 * @param {Object} entry
 * @param {string} at
 * @returns {string[]}
 */
function validateKeywords(entry, at) {
  if (entry.keywords === undefined) return [];
  const ok = Array.isArray(entry.keywords) && entry.keywords.length <= MAX_KEYWORDS && entry.keywords.every(isNonEmptyString);
  return ok ? [] : [`${at}: keywords는 비어 있지 않은 문자열 ${MAX_KEYWORDS}개 이하의 배열이어야 한다`];
}

/**
 * relevant 필드를 검증한다. 없거나 비어 있으면 미라벨이다.
 *
 * @param {Object} entry
 * @param {string} at
 * @returns {string[]}
 */
function validateRelevant(entry, at) {
  if (entry.relevant === undefined) return [];
  if (!Array.isArray(entry.relevant)) return [`${at}: relevant는 배열이어야 한다`];

  const errors = [];
  const seen   = new Set();
  for (const item of entry.relevant) {
    if (!item || !isNonEmptyString(item.id)) {
      errors.push(`${at}: relevant 항목에 id가 없다`);
      continue;
    }
    if (!GRADES.includes(item.grade)) errors.push(`${at}: relevant "${item.id}" grade는 ${GRADES.join("|")} 중 하나여야 한다`);
    if (seen.has(item.id))            errors.push(`${at}: relevant id 중복 "${item.id}"`);
    seen.add(item.id);
  }
  return errors;
}

/**
 * distractors 필드를 검증한다.
 *
 * @param {Object} entry
 * @param {string} at
 * @returns {string[]}
 */
function validateDistractors(entry, at) {
  if (entry.distractors === undefined) return [];
  if (!Array.isArray(entry.distractors) || !entry.distractors.every(isNonEmptyString)) {
    return [`${at}: distractors는 파편 id 문자열 배열이어야 한다`];
  }
  const relevantIds = new Set((Array.isArray(entry.relevant) ? entry.relevant : []).map(r => r?.id));
  const overlap     = entry.distractors.filter(id => relevantIds.has(id));
  return overlap.length > 0 ? [`${at}: distractors가 relevant와 겹친다 (${overlap.join(", ")})`] : [];
}

/**
 * 부분집합별 필수 필드를 검증한다.
 *
 * @param {Object} entry
 * @param {string} at
 * @returns {string[]}
 */
function validateSubsetFields(entry, at) {
  const errors = [];

  if (entry.domain !== undefined && !DOMAINS.includes(entry.domain)) {
    errors.push(`${at}: domain이 ${DOMAINS.join("|")} 중 하나가 아니다`);
  }
  if (entry.subset === "human_ko") {
    if (entry.domain === undefined) errors.push(`${at}: human_ko는 domain이 필요하다`);
    if (isNonEmptyString(entry.query) && !HANGUL.test(entry.query)) errors.push(`${at}: human_ko 질의에 한글이 없다`);
  }
  if (entry.subset === "temporal_holdout") {
    if (!DATE_PATTERN.test(String(entry.referenceDate)) || Number.isNaN(Date.parse(entry.referenceDate))) {
      errors.push(`${at}: temporal_holdout는 referenceDate(YYYY-MM-DD)가 필요하다`);
    }
  } else if (entry.referenceDate !== undefined) {
    errors.push(`${at}: referenceDate는 temporal_holdout에서만 쓴다`);
  }
  return errors;
}

/**
 * 평가 항목 하나의 형식을 검증한다. 위반 사유 배열을 돌려주며 비어 있으면 유효하다.
 *
 * @param {Object} entry
 * @param {number} index
 * @param {string} [fileSubset] 파일이 가리키는 부분집합. 주어지면 entry.subset과 같아야 한다
 * @returns {string[]}
 */
export function validateEvalEntry(entry, index, fileSubset = undefined) {
  const at = `#${index + 1}`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [`${at}: 객체가 아니다`];

  const errors = Object.keys(entry)
    .filter(key => !ALLOWED_KEYS.has(key))
    .map(key => `${at}: 알 수 없는 필드 "${key}"`);

  if (!isNonEmptyString(entry.id) || !ID_PATTERN.test(entry.id)) errors.push(`${at}: id 누락 또는 형식 오류 (${ID_PATTERN})`);
  if (!SUBSETS.includes(entry.subset))                          errors.push(`${at}: subset이 ${SUBSETS.join("|")} 중 하나가 아니다`);
  if (fileSubset && entry.subset !== fileSubset)                errors.push(`${at}: subset "${entry.subset}"이 파일의 부분집합 "${fileSubset}"과 다르다`);
  if (!isNonEmptyString(entry.query))                           errors.push(`${at}: query 누락`);
  else if (entry.query.length > MAX_QUERY)                      errors.push(`${at}: query가 ${MAX_QUERY}자를 넘는다`);
  if (entry.workspace !== undefined && !isNonEmptyString(entry.workspace)) errors.push(`${at}: workspace가 빈 문자열이다`);
  if (entry.example !== undefined && typeof entry.example !== "boolean")   errors.push(`${at}: example은 불리언이다`);

  return [
    ...errors,
    ...validateTags(entry, at),
    ...validateKeywords(entry, at),
    ...validateRelevant(entry, at),
    ...validateDistractors(entry, at),
    ...validateSubsetFields(entry, at)
  ];
}

/**
 * 평가 세트 전체를 검증한다. id 중복과 질의 중복을 함께 잡는다.
 *
 * @param {Object[]} entries
 * @param {string}   [fileSubset]
 * @returns {string[]}
 */
export function validateEvalSet(entries, fileSubset = undefined) {
  if (!Array.isArray(entries)) return ["평가 세트가 배열이 아니다"];

  const errors  = entries.flatMap((e, i) => validateEvalEntry(e, i, fileSubset));
  const ids     = new Set();
  const queries = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.id) {
      if (ids.has(entry.id)) errors.push(`id 중복: ${entry.id}`);
      ids.add(entry.id);
    }
    if (typeof entry.query === "string") {
      const key = `${entry.workspace ?? ""}\u0000${entry.query.trim()}`;
      if (queries.has(key)) errors.push(`질의 중복: ${entry.id} 와 ${queries.get(key)}`);
      else                  queries.set(key, entry.id);
    }
  }
  return errors;
}

/**
 * 라벨이 있는 항목과 없는 항목으로 나눈다.
 *
 * @param {Object[]} entries
 * @returns {{labeled: Object[], unlabeled: Object[]}}
 */
export function splitLabeled(entries) {
  const labeled   = [];
  const unlabeled = [];
  for (const entry of entries) {
    (Array.isArray(entry.relevant) && entry.relevant.length > 0 ? labeled : unlabeled).push(entry);
  }
  return { labeled, unlabeled };
}

/**
 * 부분집합과 태그별 건수, 사람 작성 질의 목표 대비 현황을 만든다.
 *
 * @param {Object[]} entries
 * @returns {{subsets: Object, tags: Object, human_ko: {labeled: number, target: number, met: boolean}}}
 */
export function coverageReport(entries) {
  const subsets = {};
  for (const name of SUBSETS) subsets[name] = { total: 0, labeled: 0, unlabeled: 0 };
  const tags = Object.fromEntries(TAGS.map(tag => [tag, 0]));

  for (const entry of entries) {
    const bucket = subsets[entry.subset];
    if (!bucket) continue;
    const labeled = Array.isArray(entry.relevant) && entry.relevant.length > 0;
    bucket.total += 1;
    bucket[labeled ? "labeled" : "unlabeled"] += 1;
    for (const tag of entry.tags ?? []) if (tag in tags) tags[tag] += 1;
  }

  const labeledHuman = subsets.human_ko.labeled;
  return {
    subsets,
    tags,
    human_ko: { labeled: labeledHuman, target: HUMAN_QUERY_TARGET, met: labeledHuman >= HUMAN_QUERY_TARGET }
  };
}

/**
 * 파일 하나를 읽어 검증한다. 형식 위반은 EvalSetError로 던진다.
 *
 * @param {string}  file
 * @param {string}  [fileSubset]
 * @returns {Promise<Object[]>}
 */
async function readEvalFile(file, fileSubset) {
  const entries = parseJsonl(await readFile(file, "utf-8"), path.basename(file));
  const errors  = validateEvalSet(entries, fileSubset);
  if (errors.length > 0) throw new EvalSetError(`평가 세트 ${path.basename(file)} 검증 실패 (${errors.length}건)`, errors);
  return entries;
}

/**
 * 디렉터리의 파일 이름 목록. 디렉터리가 없으면 빈 목록이다.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listDir(dir) {
  try {
    return await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * 디렉터리와 그 아래 private 디렉터리에서 부분집합 파일을 읽는다. 없는 파일은 건너뛰며 그 사실은 coverage에 건수 0으로
 * 드러난다. 파일 사이의 id 중복도 검사한다.
 *
 * @param {string} dir
 * @param {{subsets?: string[], includeExamples?: boolean}} [opts]
 * @returns {Promise<{entries: Object[], files: string[]}>}
 */
export async function loadEvalDir(dir, opts = {}) {
  const wanted = opts.subsets ?? SUBSETS;
  const unknown = wanted.filter(name => !SUBSETS.includes(name));
  if (unknown.length > 0) throw new EvalSetError(`알 수 없는 부분집합: ${unknown.join(", ")}`);

  const files   = [];
  const entries = [];

  for (const sub of ["", PRIVATE_DIR]) {
    const present = new Set(await listDir(path.join(dir, sub)));
    for (const name of SUBSETS) {
      if (!wanted.includes(name) || !present.has(`${name}.jsonl`)) continue;
      files.push(path.join(sub, `${name}.jsonl`));
      entries.push(...await readEvalFile(path.join(dir, sub, `${name}.jsonl`), name));
    }
  }
  const topLevel = new Set(await readdir(dir));
  if (opts.includeExamples === true && topLevel.has(EXAMPLE_FILE)) {
    files.push(EXAMPLE_FILE);
    entries.push(...(await readEvalFile(path.join(dir, EXAMPLE_FILE))).filter(e => wanted.includes(e.subset)));
  }

  const seen = new Set();
  const dup  = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) dup.push(`id 중복(파일 간): ${entry.id}`);
    seen.add(entry.id);
  }
  if (dup.length > 0) throw new EvalSetError("평가 세트 파일 간 id 중복", dup);

  return { entries, files };
}
