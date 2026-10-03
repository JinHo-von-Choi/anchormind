/**
 * 파편 내보내기 형식 (JSON Lines)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 형식 버전 2는 머리 줄(header), 파편 줄(fragment), 링크 줄(link), 이력 줄(version),
 * 끝 줄(end)로 이루어진다. 버전 1은 머리 줄 없이 파편 줄만 있다. 이 모듈은 DB에 닿지 않는
 * 순수 함수와 상수만 가진다.
 *
 *   header   {record:"header", format, version, schema_migration, exported_at, scope, includes}
 *   fragment {record:"fragment", id, content, ...}  (버전 1 줄은 record가 없다)
 *   link     {record:"link", from_id, to_id, relation_type, ...}
 *   version  {record:"version", fragment_id, content, ...}
 *   end      {record:"end", counts:{fragments, links, versions}}
 *
 * 읽기는 현재 버전과 직전 버전을 받는다. 알 수 없는 버전은 UnsupportedFormatVersionError로 거부한다.
 */

export const FORMAT_NAME      = "memento-fragments";
export const CURRENT_VERSION  = 2;
export const READABLE_VERSIONS = Object.freeze([1, 2]);

/** 버전 1 파일을 계속 받아들이는 기한(이 날짜 이전에는 읽기를 끊지 않는다). */
export const V1_ACCEPTED_UNTIL = "2027-10-03";

export const RECORD = Object.freeze({
  HEADER  : "header",
  FRAGMENT: "fragment",
  LINK    : "link",
  VERSION : "version",
  END     : "end"
});

/** 버전 1 파편 열. */
export const V1_FRAGMENT_COLUMNS = Object.freeze([
  "id", "content", "topic", "type", "keywords", "importance", "source", "agent_id",
  "created_at", "is_anchor", "case_id", "idempotency_key",
  "goal", "outcome", "phase", "resolution_status", "assertion_status"
]);

/**
 * 버전 2 파편 열. embedding은 대상 서버가 다시 만든다. linked_to는 링크 줄에서 다시 만들어진다.
 * 감쇠와 활성도 계수, 형태소 색인 표식, workspace 추정 열, 백필 표식은 서버 내부 상태라 싣지 않는다.
 */
export const V2_FRAGMENT_COLUMNS = Object.freeze([
  ...V1_FRAGMENT_COLUMNS,
  "content_hash", "key_id", "ttl_tier", "estimated_tokens", "valid_from", "valid_to",
  "accessed_at", "access_count", "verified_at", "utility_score",
  "context_summary", "session_id", "workspace", "workspace_source", "affect",
  "validation_warnings", "quality_verified", "quality_rationale"
]);

export const LINK_COLUMNS = Object.freeze([
  "from_id", "to_id", "relation_type", "created_at", "weight", "confidence", "decay_rate", "quarantine_state"
]);

export const VERSION_COLUMNS = Object.freeze([
  "fragment_id", "content", "topic", "keywords", "type", "importance",
  "amended_at", "amended_by", "agent_id", "workspace", "resolution_status", "outcome", "phase"
]);

/** fragment_links.relation_type 허용 값. */
export const LINK_RELATION_TYPES = Object.freeze([
  "related", "caused_by", "resolved_by", "part_of", "contradicts", "superseded_by", "co_retrieved", "temporal"
]);

/** 읽을 수 없는 형식 버전. */
export class UnsupportedFormatVersionError extends Error {
  /**
   * @param {unknown} version
   */
  constructor(version) {
    super(`Unsupported export format version: ${String(version)} (readable: ${READABLE_VERSIONS.join(", ")})`);
    this.name      = "UnsupportedFormatVersionError";
    this.version   = version;
    this.supported = READABLE_VERSIONS;
  }
}

/** 요청한 내보내기 버전을 만들 수 없을 때의 오류. */
export class ExportVersionError extends Error {
  /**
   * @param {unknown} requested
   */
  constructor(requested) {
    super(`Export format version ${String(requested)} is not available (available: ${READABLE_VERSIONS.join(", ")})`);
    this.name      = "ExportVersionError";
    this.requested = requested;
    this.supported = READABLE_VERSIONS;
  }
}

/**
 * 버전 값을 정수로 읽는다. 정수가 아니면 null이다.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toVersionInt(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Accept 헤더에서 내보내기 형식 버전 요청을 찾는다. 미디어 타입 매개변수 version을 읽는다.
 * 대상은 application/x-ndjson, application/jsonl, application/json과 와일드카드다.
 *
 * @param {string|undefined|null} accept
 * @returns {number|string|null} 요청한 값, 없으면 null
 */
function versionFromAccept(accept) {
  if (typeof accept !== "string" || accept.trim() === "") return null;
  for (const part of accept.split(",")) {
    const [type, ...params] = part.split(";").map(s => s.trim());
    if (!/^(application\/(x-ndjson|jsonl|json)|\*\/\*|application\/\*)$/i.test(type)) continue;
    for (const param of params) {
      const m = /^version\s*=\s*"?([^"]+)"?$/i.exec(param);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * 내보내기 형식 버전을 정한다. 명시한 값(질의 매개변수나 CLI 옵션)이 Accept 헤더보다 앞서고,
 * 둘 다 없으면 현재 버전이다. 읽을 수 없는 버전이면 ExportVersionError를 던진다.
 *
 * @param {{ requested?: unknown, accept?: string|null }} [input]
 * @returns {number}
 */
export function negotiateExportVersion({ requested = null, accept = null } = {}) {
  const asked = (requested !== null && requested !== undefined && requested !== "")
    ? requested
    : versionFromAccept(accept);
  if (asked === null) return CURRENT_VERSION;

  const version = toVersionInt(asked);
  if (version === null || !READABLE_VERSIONS.includes(version)) throw new ExportVersionError(asked);
  return version;
}

/**
 * 마이그레이션 파일명에서 번호 문자열을 뽑는다.
 *
 * @param {string|null|undefined} filename
 * @returns {string|null}
 */
export function migrationNumber(filename) {
  const m = /migration-(\d+)/.exec(String(filename ?? ""));
  return m ? m[1] : null;
}

/**
 * 머리 줄 객체를 만든다.
 *
 * @param {Object}   input
 * @param {string|null} input.schemaMigration - 내보낸 서버의 마지막 마이그레이션 번호
 * @param {Object}   [input.scope]            - 내보내기 조건(키, 주제, 유형, 기간 등)
 * @param {string[]} [input.includes]         - 포함한 줄 종류
 * @param {string}   [input.exportedAt]       - ISO 시각
 * @returns {Object}
 */
export function buildHeader({ schemaMigration, scope = {}, includes = [RECORD.FRAGMENT], exportedAt = new Date().toISOString() }) {
  return {
    record          : RECORD.HEADER,
    format          : FORMAT_NAME,
    version         : CURRENT_VERSION,
    schema_migration: schemaMigration ?? null,
    exported_at     : exportedAt,
    scope,
    includes
  };
}

/**
 * 끝 줄 객체를 만든다. 가져오기는 이 수와 읽은 줄 수를 대조해 잘린 파일을 알아낸다.
 *
 * @param {{fragments: number, links: number, versions: number}} counts
 * @returns {Object}
 */
export function buildTrailer(counts) {
  return {
    record: RECORD.END,
    counts: { fragments: counts.fragments, links: counts.links, versions: counts.versions }
  };
}

/**
 * 머리 줄을 검사하고 형식 버전을 돌려준다.
 *
 * @param {Object} header
 * @returns {number}
 * @throws {UnsupportedFormatVersionError}
 */
export function readHeaderVersion(header) {
  const version = toVersionInt(header.version);
  if (header.format !== FORMAT_NAME || version === null || !READABLE_VERSIONS.includes(version)) {
    throw new UnsupportedFormatVersionError(header.format === FORMAT_NAME ? header.version : `${String(header.format)}/${String(header.version)}`);
  }
  return version;
}

/** 줄 분류 결과의 거부 사유 */
export const PARSE_FAILURE = Object.freeze({
  INVALID_JSON  : "invalid_json",
  INVALID_RECORD: "invalid_record"
});

/**
 * JSONL 한 줄(또는 이미 읽은 객체)을 기록 종류별로 나눈다. `record`가 없는 객체는 파편으로 본다.
 *
 * @param {string|Object} input
 * @returns {{ok: true, kind: string, data: Object}|{ok: false, reason: string, detail: string}}
 */
export function classifyRecord(input) {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch (err) {
      return { ok: false, reason: PARSE_FAILURE.INVALID_JSON, detail: err.message };
    }
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: PARSE_FAILURE.INVALID_RECORD, detail: "record must be an object" };
  }
  if (data.record === undefined) {
    return { ok: true, kind: data.format === FORMAT_NAME ? RECORD.HEADER : RECORD.FRAGMENT, data };
  }
  if (!Object.values(RECORD).includes(data.record)) {
    return { ok: false, reason: PARSE_FAILURE.INVALID_RECORD, detail: `unknown record kind: ${String(data.record)}` };
  }
  return { ok: true, kind: data.record, data };
}

/**
 * 버전 1 줄이 파편으로서 갖춰야 할 필드를 검사한다.
 *
 * @param {Object} row
 * @returns {boolean}
 */
export function hasFragmentFields(row) {
  return typeof row.content === "string" && row.content !== ""
    && typeof row.topic === "string" && row.topic !== "";
}
