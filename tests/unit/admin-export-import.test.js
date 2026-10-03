/**
 * 관리 API 내보내기와 가져오기 처리기 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * GET /export의 형식 버전 협상과 응답 머리, POST /import의 질의 매개변수 해석, 본문 형태별 입력,
 * 오류 응답 매핑을 DB와 실행기 대역 위에서 확인한다. 가져오기 집계 자체는 import-runner 시험이 본다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";
import { Readable }                       from "node:stream";

let queryCalls   = [];
let queryResults = [];
const mockPool = {
  query(sql, params) {
    queryCalls.push({ sql, params });
    const next = queryResults.shift();
    if (typeof next === "function") return Promise.resolve(next(sql, params));
    return Promise.resolve(next ?? { rows: [] });
  }
};
mock.module("../../lib/tools/db.js", { namedExports: { getPrimaryPool: () => mockPool } });

const audits = [];
mock.module("../../lib/logging/audit.js", {
  namedExports: {
    logAudit       : async (operation, fields) => { audits.push({ operation, fields }); },
    logAccess      : async () => {},
    buildAuditActor: () => ({}),
    maskAuditPath  : (p) => p
  }
});

const { handleExport, handleImport } = await import("../../lib/admin/admin-export.js");
const { ImportAbortedError }         = await import("../../lib/memory/transfer/importErrors.js");
const { UnsupportedFormatVersionError, RECORD } = await import("../../lib/memory/transfer/exportFormat.js");
const { ImportReport }               = await import("../../lib/memory/transfer/ImportReport.js");

const BASE = "/v1/internal/model/nothing";

function fakeRes() {
  const headers = {};
  const chunks  = [];
  return {
    statusCode: 0,
    headers,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    write(c)        { chunks.push(c); },
    end(body)       { if (body) chunks.push(body); this.ended = true; },
    get body()      { return chunks.join(""); },
    get lines()     { return this.body.split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  };
}

function req(method, { body, contentType = "application/json", accept } = {}) {
  const r   = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  r.method  = method;
  r.headers = { "content-type": contentType, ...(accept ? { accept } : {}) };
  return r;
}

const url = (pathAndQuery) => new URL(`http://localhost${pathAndQuery}`);

beforeEach(() => {
  queryCalls   = [];
  queryResults = [];
  audits.length = 0;
});

/** 헤더 조회와 파편 조회 대역을 차례로 준비한다. */
function seedExport(rows = [{ id: "a", content: "본문 a", topic: "t", type: "fact" }]) {
  queryResults = [{ rows: [{ filename: "migration-049-x.sql" }] }, { rows }];
}

describe("GET /export 형식 버전 협상", () => {
  it("기본은 현재 버전이고 첫 줄이 머리 줄이며 응답 헤더가 버전을 알린다", async () => {
    seedExport();
    const res = fakeRes();
    await handleExport(req("GET"), res, url(`${BASE}/export?key_id=k1`));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-memento-export-format-version"], "2");
    assert.equal(res.lines[0].record, RECORD.HEADER);
    assert.deepEqual(res.lines[0].scope, { key_id: "k1" });
    assert.equal(res.lines.at(-1).record, RECORD.END);
  });

  it("format_version=1은 머리 줄과 끝 줄 없이 파편 줄만 보낸다", async () => {
    queryResults = [{ rows: [{ id: "a", content: "본문 a", topic: "t", type: "fact" }] }];
    const res = fakeRes();
    await handleExport(req("GET"), res, url(`${BASE}/export?key_id=k1&format_version=1`));
    assert.equal(res.headers["x-memento-export-format-version"], "1");
    assert.equal(res.lines.length, 1);
    assert.equal(res.lines[0].record, undefined);
  });

  it("Accept 헤더의 version 매개변수로도 버전을 고르고 Vary를 알린다", async () => {
    queryResults = [{ rows: [] }];
    const res = fakeRes();
    await handleExport(req("GET", { accept: "application/x-ndjson; version=1" }), res, url(`${BASE}/export?key_id=k1`));
    assert.equal(res.headers["x-memento-export-format-version"], "1");
    assert.equal(res.headers.vary, "Accept");
  });

  it("읽을 수 없는 버전은 406과 지원 목록을 돌려주고 DB를 조회하지 않는다", async () => {
    const res = fakeRes();
    await handleExport(req("GET"), res, url(`${BASE}/export?key_id=k1&format_version=9`));
    assert.equal(res.statusCode, 406);
    const body = JSON.parse(res.body);
    assert.equal(body.error, "unsupported_export_version");
    assert.deepEqual(body.supported, [1, 2]);
    assert.equal(queryCalls.length, 0);
  });

  it("범위 매개변수가 없으면 400이다", async () => {
    const res = fakeRes();
    await handleExport(req("GET"), res, url(`${BASE}/export`));
    assert.equal(res.statusCode, 400);
  });

  it("파편은 id 순 묶음으로 읽고 include_versions를 주면 이력 조회를 더한다", async () => {
    seedExport();
    const res = fakeRes();
    await handleExport(req("GET"), res, url(`${BASE}/export?key_id=k1&include_versions=true`));
    assert.ok(queryCalls.some(c => /ORDER BY id LIMIT/.test(c.sql)));
    assert.ok(queryCalls.some(c => /fragment_versions/.test(c.sql)));
  });

  it("include_links=false이면 링크를 조회하지 않는다", async () => {
    seedExport();
    const res = fakeRes();
    await handleExport(req("GET"), res, url(`${BASE}/export?key_id=k1&include_links=false`));
    assert.ok(!queryCalls.some(c => /fragment_links/.test(c.sql)));
  });
});

/** 실행기와 의존성 대역. 받은 기록과 옵션을 모은다. */
function importHarness({ summary = {}, throwError = null } = {}) {
  const seen = { records: [], runtimeArgs: null, deps: null };
  return {
    seen,
    deps: {
      loadRuntime    : async (kind, opts) => { seen.runtimeArgs = { kind, ...opts }; return { profile: { restore: opts.restore } }; },
      queueEmbeddings: async () => async (ids) => ids.length,
      run            : async (records, deps) => {
        seen.deps = deps;
        for await (const record of records) seen.records.push(record);
        if (throwError) throw throwError;
        Object.assign(deps.report.entities.fragments, summary);
        deps.report.formatVersion = 2;
        return deps.report;
      }
    }
  };
}

describe("POST /import", () => {
  it("JSON 본문의 파편을 기록 스트림으로 실행기에 넘기고 집계를 그대로 응답한다", async () => {
    const h   = importHarness({ summary: { imported: 2, duplicates: 1 } });
    const res = fakeRes();
    await handleImport(req("POST", { body: { fragments: [{ content: "본문 하나", topic: "t" }, { content: "본문 둘", topic: "t" }] } }),
      res, url(`${BASE}/import`), h.deps);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(h.seen.records.length, 2);
    assert.equal(JSON.parse(res.body).imported, 2);
    assert.equal(JSON.parse(res.body).skipped, 1);
  });

  it("ndjson 본문은 줄 단위로 읽는다", async () => {
    const h    = importHarness();
    const body = [{ record: "header", format: "memento-fragments", version: 2 }, { record: "fragment", content: "본문", topic: "t" }]
      .map(o => JSON.stringify(o)).join("\n") + "\n";
    const res = fakeRes();
    await handleImport(req("POST", { body, contentType: "application/x-ndjson" }), res, url(`${BASE}/import`), h.deps);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(h.seen.records.map(r => r.kind), ["header", "fragment"]);
  });

  it("fragments 배열이 없는 JSON 본문은 400이다", async () => {
    const res = fakeRes();
    await handleImport(req("POST", { body: { rows: [] } }), res, url(`${BASE}/import`), importHarness().deps);
    assert.equal(res.statusCode, 400);
  });

  it("JSON 본문이 상한(2 MiB)을 넘으면 413이고 같은 크기의 ndjson 본문은 받는다", async () => {
    const big = JSON.stringify({ fragments: [{ content: "가".repeat(2 * 1024 * 1024), topic: "t" }] });
    const res = fakeRes();
    await handleImport(req("POST", { body: big }), res, url(`${BASE}/import`), importHarness().deps);
    assert.equal(res.statusCode, 413);

    const h    = importHarness();
    const line = JSON.stringify({ record: "fragment", content: "가".repeat(2 * 1024 * 1024), topic: "t" });
    const ok   = fakeRes();
    await handleImport(req("POST", { body: line, contentType: "application/x-ndjson" }), ok, url(`${BASE}/import`), h.deps);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(h.seen.records.length, 1);
  });

  it("깨진 JSON 본문은 500이 아니라 400이다", async () => {
    const res = fakeRes();
    await handleImport(req("POST", { body: "{oops" }), res, url(`${BASE}/import`), importHarness().deps);
    assert.equal(res.statusCode, 400);
  });

  it("key_id 매개변수는 대상 키로 실행기에 넘기고 없으면 마스터 범위(null)다", async () => {
    const h = importHarness();
    queryResults = [{ rows: [{ "?column?": 1 }] }];
    await handleImport(req("POST", { body: { fragments: [] } }), fakeRes(), url(`${BASE}/import?key_id=key-7`), h.deps);
    assert.equal(h.seen.runtimeArgs.keyId, "key-7");

    const h2 = importHarness();
    await handleImport(req("POST", { body: { fragments: [] } }), fakeRes(), url(`${BASE}/import`), h2.deps);
    assert.equal(h2.seen.runtimeArgs.keyId, null);
  });

  it("알 수 없는 key_id는 404이고 본문을 읽지 않는다", async () => {
    const h   = importHarness();
    const res = fakeRes();
    queryResults = [{ rows: [] }];
    await handleImport(req("POST", { body: { fragments: [{ content: "본문", topic: "t" }] } }), res, url(`${BASE}/import?key_id=nope`), h.deps);
    assert.equal(res.statusCode, 404);
    assert.equal(h.seen.records.length, 0);
  });

  it("dryRun 매개변수는 실행기 옵션이 되고 임베딩 큐 함수를 넘기지 않는다", async () => {
    const h = importHarness();
    await handleImport(req("POST", { body: { fragments: [] } }), fakeRes(), url(`${BASE}/import?dryRun=true`), h.deps);
    assert.equal(h.seen.deps.dryRun, true);
    assert.equal(h.seen.deps.onCreated, null);

    const h2 = importHarness();
    await handleImport(req("POST", { body: { fragments: [] } }), fakeRes(), url(`${BASE}/import`), h2.deps);
    assert.equal(h2.seen.deps.dryRun, false);
    assert.equal(typeof h2.seen.deps.onCreated, "function");
    assert.equal(h2.seen.deps.failFast, true);
  });

  it("restore=trusted는 되살리기 모드로 실행하고 감사 기록을 남긴다", async () => {
    const h   = importHarness();
    const res = fakeRes();
    await handleImport(req("POST", { body: { fragments: [] } }), res, url(`${BASE}/import?restore=trusted`), h.deps);
    assert.equal(h.seen.runtimeArgs.restore, true);
    assert.equal(JSON.parse(res.body).restore, true);
    assert.equal(audits.length, 1);
    assert.match(audits[0].fields.details, /restore=trusted/);
  });

  it("restore에 다른 값을 주면 400이다", async () => {
    const res = fakeRes();
    await handleImport(req("POST", { body: { fragments: [] } }), res, url(`${BASE}/import?restore=yes`), importHarness().deps);
    assert.equal(res.statusCode, 400);
  });

  it("보통 가져오기는 감사 기록을 따로 남기지 않는다", async () => {
    await handleImport(req("POST", { body: { fragments: [] } }), fakeRes(), url(`${BASE}/import`), importHarness().deps);
    assert.equal(audits.length, 0);
  });

  it("읽을 수 없는 형식 버전은 400과 지원 목록이다", async () => {
    const h   = importHarness({ throwError: new UnsupportedFormatVersionError(3) });
    const res = fakeRes();
    await handleImport(req("POST", { body: { fragments: [] } }), res, url(`${BASE}/import`), h.deps);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, "unsupported_format_version");
    assert.deepEqual(JSON.parse(res.body).supported, [1, 2]);
  });

  it("중단 오류는 지금까지의 집계를 partial에 담아 500이다", async () => {
    const report = new ImportReport();
    report.imported("fragments");
    const h   = importHarness({ throwError: new ImportAbortedError(report, new Error("down")) });
    const res = fakeRes();
    await handleImport(req("POST", { body: { fragments: [] } }), res, url(`${BASE}/import`), h.deps);
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.body).partial.imported, 1);
  });

  it("다른 경로와 메서드는 처리하지 않는다", async () => {
    assert.equal(await handleImport(req("GET"), fakeRes(), url(`${BASE}/import`), importHarness().deps), false);
    assert.equal(await handleExport(req("POST"), fakeRes(), url(`${BASE}/export`)), false);
  });
});
