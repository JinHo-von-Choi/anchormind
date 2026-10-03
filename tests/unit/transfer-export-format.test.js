/**
 * 내보내기 형식 순수 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 줄 분류, 버전 읽기, 버전 협상, 머리 줄과 끝 줄 생성을 DB 없이 확인한다. 줄 전체를 고정 문자열과
 * 비교하지 않고 구조와 값 관계만 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  FORMAT_NAME, CURRENT_VERSION, READABLE_VERSIONS, RECORD,
  V1_FRAGMENT_COLUMNS, V2_FRAGMENT_COLUMNS, LINK_COLUMNS, VERSION_COLUMNS, LINK_RELATION_TYPES,
  UnsupportedFormatVersionError, ExportVersionError,
  negotiateExportVersion, migrationNumber, buildHeader, buildTrailer, readHeaderVersion,
  classifyRecord, hasFragmentFields, PARSE_FAILURE
} from "../../lib/memory/transfer/exportFormat.js";

describe("classifyRecord", () => {
  it("record 필드가 없는 객체는 파편(버전 1 줄)이다", () => {
    const result = classifyRecord(JSON.stringify({ id: "a", content: "본문", topic: "t" }));
    assert.equal(result.ok, true);
    assert.equal(result.kind, RECORD.FRAGMENT);
  });

  it("format이 맞는 객체는 record가 없어도 머리 줄이다", () => {
    const result = classifyRecord({ format: FORMAT_NAME, version: 2 });
    assert.equal(result.kind, RECORD.HEADER);
  });

  it("record 값이 알려진 종류면 그대로 분류한다", () => {
    for (const kind of Object.values(RECORD)) {
      const result = classifyRecord({ record: kind });
      assert.equal(result.ok, true);
      assert.equal(result.kind, kind);
    }
  });

  it("알 수 없는 record 종류는 invalid_record다", () => {
    const result = classifyRecord({ record: "claim" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, PARSE_FAILURE.INVALID_RECORD);
  });

  it("JSON이 아니면 invalid_json이다", () => {
    const result = classifyRecord("{not json");
    assert.equal(result.ok, false);
    assert.equal(result.reason, PARSE_FAILURE.INVALID_JSON);
  });

  it("객체가 아닌 값은 invalid_record다", () => {
    for (const value of ["[]", "42", "null", '"text"']) {
      const result = classifyRecord(value);
      assert.equal(result.ok, false, value);
      assert.equal(result.reason, PARSE_FAILURE.INVALID_RECORD, value);
    }
  });
});

describe("hasFragmentFields", () => {
  it("content와 topic이 비어 있지 않은 문자열이어야 한다", () => {
    assert.equal(hasFragmentFields({ content: "x", topic: "t" }), true);
    assert.equal(hasFragmentFields({ content: "", topic: "t" }), false);
    assert.equal(hasFragmentFields({ content: "x" }), false);
    assert.equal(hasFragmentFields({ content: 5, topic: "t" }), false);
  });
});

describe("readHeaderVersion", () => {
  it("읽을 수 있는 모든 버전을 돌려준다", () => {
    for (const version of READABLE_VERSIONS) {
      assert.equal(readHeaderVersion({ format: FORMAT_NAME, version }), version);
    }
  });

  it("읽기 목록 밖의 버전은 UnsupportedFormatVersionError다", () => {
    const newer = Math.max(...READABLE_VERSIONS) + 1;
    assert.throws(() => readHeaderVersion({ format: FORMAT_NAME, version: newer }), UnsupportedFormatVersionError);
    assert.throws(() => readHeaderVersion({ format: FORMAT_NAME, version: 0 }), UnsupportedFormatVersionError);
    assert.throws(() => readHeaderVersion({ format: FORMAT_NAME, version: "x" }), UnsupportedFormatVersionError);
  });

  it("다른 형식 이름은 거부한다", () => {
    assert.throws(() => readHeaderVersion({ format: "other", version: CURRENT_VERSION }), UnsupportedFormatVersionError);
  });

  it("읽기 버전은 현재 버전과 직전 버전 두 개다", () => {
    assert.deepEqual([...READABLE_VERSIONS], [CURRENT_VERSION - 1, CURRENT_VERSION]);
  });
});

describe("negotiateExportVersion", () => {
  it("요청이 없으면 현재 버전이다", () => {
    assert.equal(negotiateExportVersion(), CURRENT_VERSION);
    assert.equal(negotiateExportVersion({ accept: "application/json" }), CURRENT_VERSION);
    assert.equal(negotiateExportVersion({ accept: "*/*" }), CURRENT_VERSION);
  });

  it("명시한 값이 Accept보다 앞선다", () => {
    assert.equal(negotiateExportVersion({ requested: "1", accept: "application/x-ndjson; version=2" }), 1);
  });

  it("Accept의 version 매개변수를 읽는다", () => {
    assert.equal(negotiateExportVersion({ accept: "application/x-ndjson; version=1" }), 1);
    assert.equal(negotiateExportVersion({ accept: 'text/html, application/jsonl; version="2"' }), 2);
  });

  it("관련 없는 미디어 타입의 version 매개변수는 무시한다", () => {
    assert.equal(negotiateExportVersion({ accept: "text/html; version=1" }), CURRENT_VERSION);
  });

  it("읽을 수 없는 버전은 ExportVersionError다", () => {
    assert.throws(() => negotiateExportVersion({ requested: 9 }), ExportVersionError);
    assert.throws(() => negotiateExportVersion({ requested: "abc" }), ExportVersionError);
    assert.throws(() => negotiateExportVersion({ accept: "application/x-ndjson; version=7" }), ExportVersionError);
  });
});

describe("머리 줄과 끝 줄", () => {
  it("머리 줄은 형식 이름, 현재 버전, 마이그레이션 번호, 내보낸 시각을 가진다", () => {
    const header = buildHeader({ schemaMigration: "049", scope: { key_id: "k" }, includes: [RECORD.FRAGMENT] });
    assert.equal(header.record, RECORD.HEADER);
    assert.equal(header.format, FORMAT_NAME);
    assert.equal(header.version, CURRENT_VERSION);
    assert.equal(header.schema_migration, "049");
    assert.ok(!Number.isNaN(Date.parse(header.exported_at)));
    assert.equal(readHeaderVersion(header), CURRENT_VERSION);
  });

  it("마이그레이션 번호를 모르면 null이다", () => {
    assert.equal(buildHeader({ schemaMigration: undefined }).schema_migration, null);
  });

  it("끝 줄은 종류별 수를 담는다", () => {
    const trailer = buildTrailer({ fragments: 3, links: 2, versions: 0, extra: 9 });
    assert.equal(trailer.record, RECORD.END);
    assert.deepEqual(trailer.counts, { fragments: 3, links: 2, versions: 0 });
  });

  it("마이그레이션 파일명에서 번호를 뽑는다", () => {
    assert.equal(migrationNumber("migration-049-align-synthetic-query-embedding.sql"), "049");
    assert.equal(migrationNumber("other.sql"), null);
    assert.equal(migrationNumber(undefined), null);
  });
});

describe("열 목록 관계", () => {
  it("버전 2 파편 열은 버전 1 열을 모두 포함한다", () => {
    for (const column of V1_FRAGMENT_COLUMNS) assert.ok(V2_FRAGMENT_COLUMNS.includes(column), column);
  });

  it("열 이름에 중복이 없고 embedding과 내부 계수는 싣지 않는다", () => {
    for (const list of [V1_FRAGMENT_COLUMNS, V2_FRAGMENT_COLUMNS, LINK_COLUMNS, VERSION_COLUMNS]) {
      assert.equal(new Set(list).size, list.length);
    }
    for (const internal of ["embedding", "linked_to", "ema_activation", "last_decay_at", "morpheme_indexed"]) {
      assert.ok(!V2_FRAGMENT_COLUMNS.includes(internal), internal);
    }
  });

  it("버전 2는 키, 범위, 시각, 본문 해시 열을 싣는다", () => {
    for (const column of ["content_hash", "key_id", "workspace", "ttl_tier", "valid_from", "valid_to", "context_summary", "affect"]) {
      assert.ok(V2_FRAGMENT_COLUMNS.includes(column), column);
    }
  });

  it("링크 관계 유형 목록에 기본 유형이 들어 있다", () => {
    assert.ok(LINK_RELATION_TYPES.includes("related"));
    assert.ok(LINK_RELATION_TYPES.includes("resolved_by"));
  });
});
