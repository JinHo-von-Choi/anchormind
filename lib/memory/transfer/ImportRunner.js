/**
 * ImportRunner - 가져오기 기록 흐름
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 기록(record) 스트림을 차례로 읽어 파편은 의미 쓰기 관문과 FragmentWriter로, 링크와 이력은
 * 파일 id를 저장된 id로 바꿔 기록한다. admin 가져오기와 CLI 가져오기가 함께 쓴다.
 *
 *   헤더 없는 파일은 형식 버전 1이다. 헤더가 있으면 버전을 읽고 읽을 수 없으면 중단한다.
 *   파편 줄은 줄마다 따로 트랜잭션을 연다. 링크는 두 끝 파편이 이 실행에서 imported 또는
 *   duplicate로 처리된 경우에만 기록한다. 이력은 이 실행에서 새로 만든 파편에만 붙인다.
 *   dryRun은 하나의 트랜잭션에서 같은 경로로 기록하고 끝에 되돌린다. 집계는 실제 실행과 같다.
 *
 * 집계 규칙은 ImportReport가 정한다. 행 문제가 아닌 실패(연결 오류 등)는 failFast이면
 * ImportAbortedError로 중단하고, 아니면 errors로 세고 다음 줄로 넘어간다.
 */

import { checkImportRow, writeImportRow, ignoredFields, isRowLevelDbError } from "../write/FragmentImporter.js";
import { maskSensitiveText }                                  from "../write/FragmentFactory.js";
import { REJECT_REASONS }                                     from "./ImportReport.js";
import { ImportAbortedError, ImportOptionError }               from "./importErrors.js";
import {
  RECORD, LINK_RELATION_TYPES, hasFragmentFields, readHeaderVersion
} from "./exportFormat.js";

/** 줄 종류별 집계 이름. */
const ENTITY_OF = Object.freeze({
  [RECORD.FRAGMENT]: "fragments",
  [RECORD.LINK]    : "links",
  [RECORD.VERSION] : "versions"
});

/** 한 번에 큐에 올리는 임베딩 작업 수. */
const QUEUE_CHUNK = 50;

/**
 * dryRun용 트랜잭션 세션을 연다. 줄마다 SAVEPOINT를 잡아 행 거부가 이후 줄을 막지 않게 하고,
 * close에서 전체를 되돌린다.
 *
 * @param {import("pg").Pool} pool
 * @returns {Promise<{run: Function, close: Function}>}
 */
async function openRollbackSession(pool) {
  const client = await pool.connect();
  await client.query("BEGIN");
  return {
    async run(fn, keep = () => true) {
      await client.query("SAVEPOINT import_row");
      let result;
      try {
        result = await fn(client);
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT import_row");
        throw err;
      }
      await client.query(keep(result) ? "RELEASE SAVEPOINT import_row" : "ROLLBACK TO SAVEPOINT import_row");
      return result;
    },
    async close() {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  };
}

/**
 * 쓰기 함수를 줄 단위 트랜잭션 안에서 실행한다. dryRun이면 처음 쓰는 시점에 세션을 열고
 * 세션의 SAVEPOINT 안에서 실행한다. 관문에서 모두 거부되는 입력은 DB에 닿지 않는다.
 */
async function inWrite(ctx, fn, keep) {
  if (!ctx.deps.dryRun) return ctx.deps.withTransaction(ctx.deps.pool, fn);
  ctx.session ??= await openRollbackSession(ctx.deps.pool);
  return ctx.session.run(fn, keep);
}

/** 거부를 집계하고 기록 줄을 남긴다. */
function reject(ctx, entity, rec, reason, detail) {
  ctx.report.reject(entity, reason, { line: rec.lineNo, detail });
  ctx.deps.log?.(`Line ${rec.lineNo}: ${entity} rejected (${reason}${detail ? `: ${detail}` : ""})`);
}

/**
 * 쓰기 한 건을 실행하고, 행 값 때문에 DB가 거부하면 거부로 세고 null을 돌려준다. 그 밖의 오류는
 * failFast이면 중단하고 아니면 errors로 센 뒤 null을 돌려준다.
 */
async function guarded(ctx, entity, rec, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isRowLevelDbError(err)) {
      reject(ctx, entity, rec, REJECT_REASONS.DATABASE_REJECTED, `database rejected the row (${err.code})`);
      return null;
    }
    if (ctx.deps.failFast) throw new ImportAbortedError(ctx.report, err);
    ctx.report.error(entity, { line: rec.lineNo, detail: err.message });
    ctx.deps.log?.(`Line ${rec.lineNo}: ${entity} failed (${err.message})`);
    return null;
  }
}

/** 파편 줄 하나. */
async function importFragmentRecord(rec, ctx) {
  const { report, deps, state } = ctx;
  const row = rec.data;
  state.seen.fragments++;

  if (!hasFragmentFields(row)) {
    reject(ctx, "fragments", rec, REJECT_REASONS.INVALID_ROW, "content and topic are required");
    return;
  }
  for (const field of ignoredFields(row, deps.profile)) report.ignoredField(field);

  const prepared = await guarded(ctx, "fragments", rec, () => checkImportRow(row, deps));
  if (prepared === null) return;
  if (prepared.status === "rejected") {
    reject(ctx, "fragments", rec, prepared.reasonCode, prepared.reason);
    return;
  }

  const keep    = (r) => r.status === "imported" || r.status === "duplicate";
  const outcome = await guarded(ctx, "fragments", rec, () =>
    inWrite(ctx, (client) => writeImportRow(prepared, { writer: deps.writer, profile: deps.profile, client }), keep));
  if (outcome === null) return;

  recordFragmentOutcome(rec, ctx, row, prepared, outcome);
}

/** writeImportRow 결과를 집계하고 id 대응표에 반영한다. */
function recordFragmentOutcome(rec, ctx, row, prepared, outcome) {
  const { report, deps, state } = ctx;
  if (outcome.status === "conflict") {
    if (deps.idempotent) report.duplicate("fragments");
    else reject(ctx, "fragments", rec, REJECT_REASONS.ID_CONFLICT, "a different fragment with this id already exists");
    return;
  }
  if (outcome.status === "rejected") {
    reject(ctx, "fragments", rec, REJECT_REASONS.DATABASE_REJECTED, outcome.reason);
    return;
  }

  if (typeof row.id === "string") state.idMap.set(row.id, outcome.id);
  if (outcome.status === "imported") {
    report.imported("fragments");
    state.created.add(outcome.id);
    if (prepared.transformed) report.transformed++;
  } else {
    report.duplicate("fragments");
  }
}

/** 유한한 숫자이거나 숫자로 읽히는 문자열인지 본다. */
function isNumeric(value) {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

/**
 * 링크 줄이 기록 가능한 형태인지 본다.
 *
 * @param {Object} d
 * @returns {string|null} 문제 설명, 없으면 null
 */
function linkProblem(d) {
  if (typeof d.from_id !== "string" || d.from_id === "" || typeof d.to_id !== "string" || d.to_id === "") {
    return "from_id and to_id are required";
  }
  if (d.from_id === d.to_id) return "a link cannot point to itself";
  if (d.relation_type !== undefined && !LINK_RELATION_TYPES.includes(d.relation_type)) {
    return `unknown relation_type: ${String(d.relation_type)}`;
  }
  for (const key of ["weight", "confidence", "decay_rate"]) {
    if (d[key] !== undefined && d[key] !== null && !isNumeric(d[key])) return `${key} must be a number`;
  }
  return null;
}

/** 링크 줄 하나. */
async function importLinkRecord(rec, ctx) {
  const { report, deps, state } = ctx;
  const d = rec.data;
  state.seen.links++;

  const problem = linkProblem(d);
  if (problem) {
    reject(ctx, "links", rec, REJECT_REASONS.LINK_INVALID, problem);
    return;
  }
  const from = state.idMap.get(d.from_id);
  const to   = state.idMap.get(d.to_id);
  if (!from || !to) {
    reject(ctx, "links", rec, REJECT_REASONS.LINK_ENDPOINT_MISSING, `${d.from_id} > ${d.to_id}`);
    return;
  }

  if (from === to) {
    reject(ctx, "links", rec, REJECT_REASONS.LINK_INVALID, "both endpoints resolve to the same stored fragment");
    return;
  }

  const result = await guarded(ctx, "links", rec, () =>
    inWrite(ctx, (client) => deps.linkStore.restoreLink(client, { ...d, from_id: from, to_id: to })));
  if (result === null) return;
  if (result.created) report.imported("links");
  else report.duplicate("links");
}

/** 이력 줄 하나. 이 실행에서 새로 만든 파편에만 붙인다. */
async function importVersionRecord(rec, ctx) {
  const { report, deps, state } = ctx;
  const d = rec.data;
  state.seen.versions++;

  if (typeof d.fragment_id !== "string" || typeof d.content !== "string" || d.content === "") {
    reject(ctx, "versions", rec, REJECT_REASONS.INVALID_RECORD, "fragment_id and content are required");
    return;
  }
  const mapped = state.idMap.get(d.fragment_id);
  if (!mapped) {
    reject(ctx, "versions", rec, REJECT_REASONS.VERSION_FRAGMENT_MISSING, d.fragment_id);
    return;
  }
  if (!state.created.has(mapped)) {
    report.duplicate("versions");
    return;
  }

  const row  = { ...d, fragment_id: mapped, content: maskSensitiveText(d.content), keywords: Array.isArray(d.keywords) ? d.keywords : null };
  const done = await guarded(ctx, "versions", rec, () =>
    inWrite(ctx, async (client) => { await deps.writer.restoreVersion(row, { client }); return true; }));
  if (done) report.imported("versions");
}

/** 끝 줄의 수와 읽은 줄 수를 대조한다. */
function checkTrailer(rec, ctx) {
  const expected = rec.data.counts ?? {};
  const seen     = ctx.state.seen;
  ctx.state.endSeen = true;
  for (const kind of ["fragments", "links", "versions"]) {
    if (typeof expected[kind] === "number" && expected[kind] !== seen[kind]) {
      ctx.report.warn("trailer_mismatch", { entity: kind, expected: expected[kind], seen: seen[kind] });
    }
  }
}

/** 형식 버전 1 파일에는 없는 줄 종류를 거부한다. 파일의 첫 줄을 보고 버전을 정한다. */
function resolveVersion(rec, ctx) {
  const { state, report } = ctx;
  if (state.version === null) {
    state.version        = rec.ok && rec.kind === RECORD.HEADER ? readHeaderVersion(rec.data) : 1;
    report.formatVersion = state.version;
    if (ctx.deps.profile.restore && state.version < 2) {
      throw new ImportOptionError("restore import requires a format version 2 file");
    }
    return rec.ok && rec.kind === RECORD.HEADER;
  }
  if (rec.ok && rec.kind === RECORD.HEADER) {
    report.warn("header_not_first", { line: rec.lineNo });
    return true;
  }
  return false;
}

/** 기록 하나를 종류별 처리기로 보낸다. */
async function dispatch(rec, ctx) {
  if (!rec.ok) {
    reject(ctx, "fragments", rec, rec.reason, rec.detail);
    return;
  }
  if (rec.kind === RECORD.END && ctx.state.version >= 2) {
    checkTrailer(rec, ctx);
    return;
  }
  if (ctx.state.version === 1 && rec.kind !== RECORD.FRAGMENT) {
    const entity = ENTITY_OF[rec.kind];
    if (entity) reject(ctx, entity, rec, REJECT_REASONS.INVALID_RECORD, "this record kind requires format version 2");
    else ctx.report.warn("record_ignored", { line: rec.lineNo, kind: rec.kind });
    return;
  }
  if (rec.kind === RECORD.FRAGMENT) await importFragmentRecord(rec, ctx);
  else if (rec.kind === RECORD.LINK) await importLinkRecord(rec, ctx);
  else if (rec.kind === RECORD.VERSION) await importVersionRecord(rec, ctx);
}

/** 이 실행에서 새로 만든 파편을 임베딩 큐에 올린다. */
async function queueEmbeddings(ctx) {
  const { deps, state, report } = ctx;
  if (deps.dryRun || !deps.onCreated || state.created.size === 0) return;
  const ids    = [...state.created];
  let   queued = 0;
  for (let i = 0; i < ids.length; i += QUEUE_CHUNK) {
    queued += await deps.onCreated(ids.slice(i, i + QUEUE_CHUNK));
  }
  report.embeddingQueued = queued;
}

/**
 * 기록 스트림을 가져온다.
 *
 * @param {AsyncIterable<Object>|Iterable<Object>} records - recordsFromLines 또는 recordsFromJsonBody 결과
 * @param {Object} deps
 * @param {import("./ImportReport.js").ImportReport} deps.report
 * @param {Object}   deps.profile       - importProfile 결과
 * @param {string}   deps.entry         - 관문 진입점 이름
 * @param {Object}   deps.gate          - WriteGate
 * @param {Object}   deps.writer        - FragmentWriter(insertDetailed, restoreVersion)
 * @param {Object}   deps.linkStore     - LinkStore(restoreLink)
 * @param {Object}   deps.pool          - pg Pool
 * @param {Function} deps.withTransaction - (pool, fn) => Promise
 * @param {boolean}  [deps.dryRun=false]
 * @param {boolean}  [deps.idempotent=false] - 같은 id가 이미 있는 행을 거부 대신 duplicates로 센다
 * @param {boolean}  [deps.failFast=false]   - 행 문제가 아닌 실패에서 중단한다
 * @param {(ids: string[]) => Promise<number>} [deps.onCreated] - 새 파편 id를 받아 큐에 올린 수를 돌려준다
 * @param {(message: string) => void} [deps.log]
 * @returns {Promise<import("./ImportReport.js").ImportReport>}
 */
export async function runImport(records, deps) {
  const state = {
    version: null,
    idMap  : new Map(),
    created: new Set(),
    seen   : { fragments: 0, links: 0, versions: 0 },
    endSeen: false
  };
  const ctx = { deps, report: deps.report, state, session: null };

  try {
    for await (const rec of records) {
      ctx.report.lines = rec.lineNo;
      if (resolveVersion(rec, ctx)) continue;
      await dispatch(rec, ctx);
    }
    if (state.version >= 2 && !state.endSeen) ctx.report.warn("trailer_missing", {});
  } finally {
    if (ctx.session) await ctx.session.close();
  }
  await queueEmbeddings(ctx);
  return ctx.report;
}
