/**
 * 대형 표 색인 작업 목록
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 대형 표(fragments, fragment_links, case_events, search_events)의 색인은 마이그레이션이
 * 아니라 scripts/ops/online-index.mjs 가 CONCURRENTLY 로 만든다. 이 모듈은 그 대상을
 * 적은 scripts/ops/index-manifest.json 을 읽고 검증한다. 마이그레이션 lint 와 색인
 * 작업 스크립트가 같은 검증을 쓴다.
 *
 * 항목 형식:
 *   baseline 항목  { name, table, baseline: true }                    이미 마이그레이션이 만든 색인
 *   작업 항목      { name, table, unique?, definition }                스크립트가 만들 색인
 * definition 은 색인 이름 뒤에 오는 절이다(예: "ON agent_memory.fragments (workspace)").
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INDEX_SCHEMA  = "agent_memory";
export const LARGE_TABLES  = Object.freeze(["fragments", "fragment_links", "case_events", "search_events"]);
export const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index-manifest.json");

const NAME_PATTERN       = /^[a-z_][a-z0-9_]{0,62}$/;
const DEFINITION_FORBID  = /;|--|\/\*|\*\//;

/** 작업 목록 형식 위반. */
export class IndexManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "IndexManifestError";
  }
}

/**
 * 색인 이름 형식 검사. SQL 식별자로 그대로 쓰이므로 소문자 영숫자와 밑줄만 허용한다.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidIndexName(name) {
  return typeof name === "string" && NAME_PATTERN.test(name);
}

/**
 * 항목 하나를 검사하고 위반 설명을 배열로 돌려준다.
 *
 * @param {unknown} entry
 * @param {number}  position
 * @returns {string[]}
 */
function entryProblems(entry, position) {
  const label = `indexes[${position}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [`${label}: 객체가 아니다`];

  const problems = [];
  if (!isValidIndexName(entry.name))         problems.push(`${label}: name 형식이 맞지 않는다`);
  if (!LARGE_TABLES.includes(entry.table))   problems.push(`${label}: table 은 ${LARGE_TABLES.join(", ")} 중 하나여야 한다`);
  if (entry.baseline === true) {
    if (entry.definition !== undefined) problems.push(`${label}: baseline 항목은 definition 을 갖지 않는다`);
    return problems;
  }
  if (entry.unique !== undefined && typeof entry.unique !== "boolean") problems.push(`${label}: unique 는 불리언이다`);
  problems.push(...definitionProblems(entry, label));
  return problems;
}

/**
 * 작업 항목의 definition 검사. 대상 표를 가리키는 ON 절로 시작해야 하고 문장 구분자나
 * 주석을 담을 수 없다.
 *
 * @param {{table: string, definition?: unknown}} entry
 * @param {string} label
 * @returns {string[]}
 */
function definitionProblems(entry, label) {
  const { definition, table } = entry;
  if (typeof definition !== "string" || definition.trim() === "") return [`${label}: definition 이 필요하다`];
  const problems = [];
  if (DEFINITION_FORBID.test(definition)) problems.push(`${label}: definition 에 ; 또는 주석을 쓸 수 없다`);
  const head = new RegExp(`^ON\\s+${INDEX_SCHEMA}\\.${table}\\b`);
  if (!head.test(definition.trim())) problems.push(`${label}: definition 은 "ON ${INDEX_SCHEMA}.${table}" 로 시작해야 한다`);
  return problems;
}

/**
 * 작업 목록 객체를 검사한다. 위반이 있으면 모두 모아 던진다.
 *
 * @param {unknown} manifest
 * @returns {{version: number, indexes: object[]}} 같은 객체
 */
export function validateManifest(manifest) {
  if (manifest === null || typeof manifest !== "object" || manifest.version !== 1 || !Array.isArray(manifest.indexes)) {
    throw new IndexManifestError("작업 목록은 { version: 1, indexes: [...] } 형식이어야 한다");
  }
  const problems = manifest.indexes.flatMap((entry, i) => entryProblems(entry, i));
  const seen     = new Set();
  for (const entry of manifest.indexes) {
    if (seen.has(entry?.name)) problems.push(`이름이 중복된다: ${entry.name}`);
    seen.add(entry?.name);
  }
  if (problems.length > 0) throw new IndexManifestError(problems.join("\n"));
  return manifest;
}

/**
 * 작업 목록 파일을 읽고 검사한다.
 *
 * @param {string} [filePath]
 * @returns {{version: number, indexes: object[]}}
 */
export function loadManifest(filePath = MANIFEST_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new IndexManifestError(`작업 목록을 읽을 수 없다 (${filePath}): ${err.message}`);
  }
  return validateManifest(parsed);
}

/**
 * 등록된 색인 이름 집합.
 *
 * @param {{indexes: Array<{name: string}>}} manifest
 * @returns {Set<string>}
 */
export function manifestNames(manifest) {
  return new Set(manifest.indexes.map(entry => entry.name));
}

/**
 * 등록된 색인 이름과 표의 대응.
 *
 * @param {{indexes: Array<{name: string, table: string}>}} manifest
 * @returns {Map<string, string>}
 */
export function manifestTables(manifest) {
  return new Map(manifest.indexes.map(entry => [entry.name, entry.table]));
}

/**
 * 스크립트가 만들 수 있는 항목(definition 이 있는 항목)을 이름으로 찾는다.
 *
 * @param {{indexes: object[]}} manifest
 * @param {string} name
 * @returns {object}
 */
export function findBuildableEntry(manifest, name) {
  const entry = manifest.indexes.find(candidate => candidate.name === name);
  if (!entry)                    throw new IndexManifestError(`작업 목록에 없는 색인이다: ${name}`);
  if (entry.baseline === true)   throw new IndexManifestError(`baseline 항목은 만들 수 없다(이미 마이그레이션이 만든 색인): ${name}`);
  return entry;
}
