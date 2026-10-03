/**
 * 파편 임포트/엑스포트 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-03-27
 * 수정일: 2026-10-03 (형식 버전 2, 링크와 이력, 정확한 집계, 대상 키 매개변수)
 */
import { once }           from "node:events";
import { getPrimaryPool } from "../tools/db.js";
import { readJsonBody, readRawBody } from "../utils.js";
import { logError, logWarn } from "../logger.js";
import { logAudit }       from "../logging/audit.js";
import { fetchGroupKeyIds, escapeLike } from "./admin-memory.js";
import { adminAuditActor, ADMIN_BASE } from "./admin-auth.js";
import { keyScopeScalar, keyScopeGroup } from "../memory/keyScope.js";
import {
  negotiateExportVersion, ExportVersionError, UnsupportedFormatVersionError
} from "../memory/transfer/exportFormat.js";
import { exportRecords } from "../memory/transfer/FragmentExporter.js";
import { ImportReport }  from "../memory/transfer/ImportReport.js";
import { ImportOptionError, ImportAbortedError, ImportInputError } from "../memory/transfer/importErrors.js";
import { recordsFromLines, recordsFromJsonBody } from "../memory/transfer/importRecords.js";
import { loadImportRuntime, targetKeyExists } from "../memory/transfer/importRuntime.js";
/* 라우트는 ADMIN_BASE/export, ADMIN_BASE/import 경로와 정확히 같을 때만 처리한다(감사 행위 선언과 같은 경로). */

/** 줄 단위(JSON Lines) 가져오기 본문의 크기 상한. JSON 본문은 readJsonBody의 상한을 따른다. */
export const IMPORT_NDJSON_MAX_BYTES = 64 * 1024 * 1024;

/** 질의 매개변수의 참 값. */
function flagOf(url, ...names) {
  return names.some(n => /^(1|true|yes|on)$/i.test(url.searchParams.get(n) ?? ""));
}

/** 질의 매개변수가 명시적 거짓("0", "false", "no", "off")이면 true. */
function flagOff(url, name) {
  return /^(0|false|no|off)$/i.test(url.searchParams.get(name) ?? "");
}

/**
 * 내보내기 조건식과 바인딩을 만든다. 조건은 항상 valid_to IS NULL로 시작한다.
 *
 * @returns {Promise<{where: string, params: Array}|null>} 그룹에 구성원이 없으면 null
 */
async function buildExportScope(pool, url) {
  const keyId   = url.searchParams.get("key_id");
  const groupId = url.searchParams.get("group_id");
  const topic   = url.searchParams.get("topic");
  const type    = url.searchParams.get("type");
  const keyIds  = (url.searchParams.get("key_ids") || "")
    .split(",").map(s => s.trim()).filter(Boolean);

  let where    = "valid_to IS NULL";
  const params = [];

  if (keyIds.length > 0) {
    where += keyScopeGroup(params, "key_id", keyIds);
  } else if (keyId) {
    where += keyScopeScalar(params, "key_id", keyId);
  } else if (groupId) {
    const memberKeyIds = await fetchGroupKeyIds(pool, groupId);
    if (memberKeyIds.length === 0) return null;
    where += keyScopeGroup(params, "key_id", memberKeyIds);
  }
  if (topic) {
    params.push(`%${escapeLike(topic)}%`);
    where += ` AND topic ILIKE $${params.length}`;
  }
  if (type) {
    params.push(type);
    where += ` AND type = $${params.length}`;
  }
  return { where, params };
}

/** 머리 줄에 적는 내보내기 조건. 지정한 것만 담는다. */
function exportScopeOf(url) {
  const scope = {};
  for (const name of ["key_id", "key_ids", "group_id", "topic", "type"]) {
    const value = url.searchParams.get(name);
    if (value) scope[name] = value;
  }
  if (url.searchParams.get("confirm") === "full") scope.all = true;
  return scope;
}

/** 응답 줄을 쓴다. 소켓 버퍼가 차면 비워지거나 연결이 닫힐 때까지 기다린다. */
export async function writeLine(res, line) {
  if (res.write(line) !== false || typeof res.once !== "function") return;
  const abort = new AbortController();
  try {
    await Promise.race([once(res, "drain", { signal: abort.signal }), once(res, "close", { signal: abort.signal })]);
  } finally {
    abort.abort();
  }
}

/**
 * GET /export?key_id=&group_id=&topic=&type=&format_version=&include_links=&include_versions=
 *
 * key_id 또는 group_id 중 하나가 필수다. 전체 반출은 confirm=full을
 * 명시한 경우에만 허용한다 (무의식적 전 테넌트 dump 차단).
 *
 * 형식 버전은 format_version 매개변수가, 없으면 Accept 헤더의 version 매개변수가 정하고, 둘 다
 * 없으면 현재 버전(2)이다. 읽을 수 없는 버전은 406이다. 응답 헤더 X-Memento-Export-Format-Version이
 * 실제 버전을 알린다. 버전 1은 파편 줄만 담는다.
 */
export async function handleExport(req, res, url) {
  if (req.method !== "GET" || url.pathname !== `${ADMIN_BASE}/export`) return false;

  let started = false;
  try {
    const pool    = getPrimaryPool();
    const keyId   = url.searchParams.get("key_id");
    const groupId = url.searchParams.get("group_id");
    const confirm = url.searchParams.get("confirm");
    const keyIds  = (url.searchParams.get("key_ids") || "").split(",").map(s => s.trim()).filter(Boolean);

    if (!keyId && !groupId && keyIds.length === 0 && confirm !== "full") {
      res.statusCode = 400;
      res.end(JSON.stringify({
        error: "key_id, key_ids, or group_id is required. Pass confirm=full to export all tenants."
      }));
      return true;
    }

    const version = negotiateExportVersion({
      requested: url.searchParams.get("format_version"),
      accept   : req.headers?.accept
    });
    const scope = await buildExportScope(pool, url);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Memento-Export-Format-Version", String(version));
    res.setHeader("Vary", "Accept");
    if (scope === null) {
      res.end();
      return true;
    }
    res.setHeader("Content-Disposition", "attachment; filename=fragments.jsonl");

    const records = exportRecords({
      query          : (sql, params) => pool.query(sql, params),
      where          : scope.where,
      params         : scope.params,
      version,
      includeLinks   : !flagOff(url, "include_links"),
      includeVersions: flagOf(url, "include_versions"),
      scope          : exportScopeOf(url)
    });
    for await (const record of records) {
      if (res.destroyed) return true;
      started = true;
      await writeLine(res, JSON.stringify(record) + "\n");
    }
    res.end();
  } catch (err) {
    return failExport(res, err, started);
  }
  return true;
}

/** 내보내기 실패를 응답으로 바꾼다. 이미 줄을 보낸 뒤면 끝 줄이 없는 채로 연결을 닫는다. */
function failExport(res, err, started) {
  if (err instanceof ExportVersionError) {
    res.statusCode = 406;
    res.end(JSON.stringify({ error: "unsupported_export_version", requested: err.requested, supported: err.supported }));
    return true;
  }
  logError("[Admin] /export error:", err);
  if (started) {
    if (typeof res.destroy === "function") res.destroy(err);
    else res.end();
    return true;
  }
  res.statusCode = 500;
  res.end(JSON.stringify({ error: "Internal error" }));
  return true;
}

/**
 * 가져오기 질의 매개변수를 읽는다. key_id는 기록 대상 키(파일 행의 key_id는 읽지 않는다),
 * dryRun은 기록 없이 같은 경로로 집계만 하고, restore=trusted는 저장된 값을 되살리는 가져오기다.
 *
 * @param {URL} url
 * @returns {{keyId: string|null, dryRun: boolean, restore: boolean}}
 */
function parseImportOptions(url) {
  const restoreValue = url.searchParams.get("restore");
  if (restoreValue !== null && restoreValue !== "trusted") {
    throw new ImportOptionError("restore must be 'trusted'");
  }
  return {
    keyId : url.searchParams.get("key_id") || null,
    dryRun: flagOf(url, "dryRun", "dry_run"),
    restore: restoreValue === "trusted"
  };
}

/** 줄 단위 본문인지(Content-Type이 ndjson 또는 jsonl) 본다. */
function isLineBody(req) {
  return /ndjson|jsonl/i.test(String(req.headers?.["content-type"] ?? ""));
}

/** 요청 본문을 기록 스트림으로 읽는다. 읽을 수 없으면 null이며 응답은 이미 보냈다. */
async function readImportRecords(req, res) {
  if (isLineBody(req)) {
    const text = await readRawBody(req, IMPORT_NDJSON_MAX_BYTES);
    return recordsFromLines(text.split("\n"));
  }
  const body = await readJsonBody(req);
  if (!body || !Array.isArray(body.fragments)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "body.fragments array required" }));
    return null;
  }
  return recordsFromJsonBody(body);
}

/** 새로 만든 파편을 임베딩 큐에 올리는 함수. 큐에 올린 수를 돌려준다. */
async function queueEmbeddingsFor() {
  const [{ pushToQueue }, { MEMORY_CONFIG }] = await Promise.all([
    import("../redis.js"),
    import("../../config/memory.js")
  ]);
  return async (ids) => {
    const results = await Promise.all(ids.map(id => pushToQueue(MEMORY_CONFIG.embeddingWorker.queueKey, { fragmentId: id })));
    return results.filter(Boolean).length;
  };
}

/** 가져오기 오류를 응답으로 바꾼다. */
function failImport(res, err) {
  if (err instanceof UnsupportedFormatVersionError) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "unsupported_format_version", version: err.version, supported: err.supported }));
  } else if (err instanceof ImportOptionError) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: err.message }));
  } else if (err?.statusCode === 413) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: "Payload too large" }));
  } else if (err instanceof SyntaxError) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
  } else if (err instanceof ImportInputError) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "no_valid_records", message: err.message, partial: err.report.toJSON() }));
  } else if (err instanceof ImportAbortedError) {
    logError("[Admin] /import aborted:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Internal error", partial: err.report.toJSON() }));
  } else {
    logError("[Admin] /import error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Internal error" }));
  }
}

/**
 * 되살리기 가져오기의 감사 한 줄. 끝났는지(completed), 대상 DB 실패로 중단했는지(aborted), 그 밖의
 * 오류로 멈췄는지(failed)와 그때까지의 집계를 남긴다. 기록 실패는 경고로만 남긴다.
 */
async function auditRestore(req, options, report, outcome) {
  const c = report.entities.fragments;
  try {
    await logAudit("admin import restore", {
      success: outcome === "completed",
      details: `restore=trusted outcome=${outcome} dryRun=${options.dryRun} key=${options.keyId ?? "master"} `
        + `imported=${c.imported} duplicates=${c.duplicates} rejected=${c.rejected} errors=${c.errors} transformed=${report.transformed}`,
      actor  : adminAuditActor(req)
    });
  } catch (err) {
    logWarn(`[Admin] restore audit write failed: ${err.message}`);
  }
}

/**
 * 가져오기를 실행한다. 되살리기이면 끝나든 중단되든 오류로 멈추든 그때까지 기록한 내용을 감사에 남긴다.
 */
async function runAudited(req, options, report, execute) {
  let outcome = "failed";
  try {
    await execute();
    outcome = "completed";
  } catch (err) {
    outcome = err instanceof ImportAbortedError ? "aborted" : "failed";
    throw err;
  } finally {
    if (options.restore) await auditRestore(req, options, report, outcome);
  }
}

/**
 * POST /import?key_id=&dryRun=&restore=trusted
 *
 * 본문은 JSON {fragments: [...], links?: [...], versions?: [...]} 이거나, Content-Type이 ndjson
 * 또는 jsonl인 줄 단위 파일(/export 응답 그대로)이다. 행마다 의미 쓰기 관문을 거쳐 FragmentWriter로
 * 기록하고, 파편 줄은 줄마다 따로 트랜잭션을 연다. key_id 매개변수가 없으면 마스터 범위(key_id NULL)로
 * 기록하며 파일 행의 key_id는 읽지 않는다.
 *
 * 응답의 imported, duplicates, rejected, errors는 파편 집계이고 rejected_by_reason이 거부 사유 유형별
 * 건수다. 링크와 이력은 links, versions에 따로 센다. 행 문제가 아닌 DB 오류는 지금까지의 집계를
 * partial에 담아 500으로 응답한다.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.loadRuntime]     - 시험용 의존성 공급자
 * @param {Function} [deps.queueEmbeddings] - 새 파편 id를 큐에 올리는 함수를 만드는 공급자
 * @param {Function} [deps.run]             - 가져오기 실행기. 기본은 ImportRunner.runImport(동적 로드)
 */
export async function handleImport(req, res, url, {
  loadRuntime     = loadImportRuntime,
  queueEmbeddings = queueEmbeddingsFor,
  run             = null
} = {}) {
  if (req.method !== "POST" || url.pathname !== `${ADMIN_BASE}/import`) return false;

  try {
    const options = parseImportOptions(url);
    const pool    = getPrimaryPool();
    if (options.keyId && !(await targetKeyExists(pool, options.keyId))) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Unknown key_id" }));
      return true;
    }

    const records = await readImportRecords(req, res);
    if (records === null) return true;

    const runtime   = await loadRuntime("admin", { keyId: options.keyId, restore: options.restore });
    const report    = new ImportReport({ dryRun: options.dryRun, restore: options.restore });
    const runImport = run ?? (await import("../memory/transfer/ImportRunner.js")).runImport;
    const onCreated = options.dryRun ? null : await queueEmbeddings();
    await runAudited(req, options, report, () => runImport(records, {
      ...runtime, report, pool, dryRun: options.dryRun, failFast: true, onCreated
    }));

    res.statusCode = 200;
    res.end(JSON.stringify(report.toJSON()));
  } catch (err) {
    failImport(res, err);
  }
  return true;
}
