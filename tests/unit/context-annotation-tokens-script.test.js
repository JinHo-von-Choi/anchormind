/**
 * context 주석 토큰 증가율 측정 스크립트 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * DB와 네트워크 없이 입력 해석, 창 단위 집계, 증가율 계산, 진입점 출력의 구조를 확인한다.
 * 측정값을 고정 수치와 대조하지 않는다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";
import { fileURLToPath } from "node:url";

import {
  MeasureInputError, parseFragmentLines, measureAnnotation, main, DEFAULT_FRAGMENTS, DEFAULT_WINDOW
} from "../../scripts/measure/context-annotation-tokens.mjs";

const ROOT       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_SRC = readFileSync(path.join(ROOT, "scripts/measure/context-annotation-tokens.mjs"), "utf8");

const charCount = text => text.length;

describe("parseFragmentLines", () => {
  it("평가 세트 store 줄은 저장일 기준값과 observed로 채운다", () => {
    const text = [
      "{\"id\": \"es-01\", \"store\": \"포트 3300 고정\", \"query\": \"q\", \"type\": \"fact\"}",
      "",
      "// 주석 줄"
    ].join("\n");
    const [fragment, ...rest] = parseFragmentLines(text, { baseDate: "2026-10-03" });
    assert.equal(rest.length, 0);
    assert.equal(fragment.content, "포트 3300 고정");
    assert.equal(fragment.type, "fact");
    assert.equal(fragment.assertion_status, "observed");
    assert.equal(fragment.created_at, "2026-10-03T00:00:00.000Z");
  });

  it("내보내기 파일은 fragment 줄만 쓰고 저장된 날짜와 assertion을 유지한다", () => {
    const text = [
      JSON.stringify({ record: "header", format: "memento-fragments", version: 2 }),
      JSON.stringify({ record: "fragment", id: "f1", content: "본문", type: "decision", created_at: "2026-01-02T03:04:05Z", assertion_status: null, is_anchor: true }),
      JSON.stringify({ record: "link", from_id: "f1", to_id: "f2", relation_type: "related" }),
      JSON.stringify({ id: "v1", content: "버전 1 줄", type: "fact", created_at: "2025-12-31T00:00:00Z", assertion_status: "inferred" }),
      JSON.stringify({ record: "end", counts: {} })
    ].join("\n");
    const fragments = parseFragmentLines(text, { baseDate: "2026-10-03" });

    assert.deepEqual(fragments.map(f => f.content), ["본문", "버전 1 줄"]);
    assert.equal(fragments[0].created_at, "2026-01-02T03:04:05Z");
    assert.equal(fragments[0].assertion_status, null);
    assert.equal(fragments[0].is_anchor, true);
    assert.equal(fragments[1].assertion_status, "inferred");
  });

  it("해석할 수 없는 줄과 빈 입력은 줄 번호를 담은 오류다", () => {
    assert.throws(() => parseFragmentLines("{\"store\": \"a\"}\n{broken", {}), e => e instanceof MeasureInputError && /line 2/.test(e.message));
    assert.throws(() => parseFragmentLines("\n// only comments\n", {}), MeasureInputError);
  });
});

describe("measureAnnotation", () => {
  const fragments = Array.from({ length: 7 }, (_, i) => ({
    id: `f${i}`, type: i % 2 ? "fact" : "error", content: `본문 ${i}`, is_anchor: i === 0,
    created_at: "2026-09-30T00:00:00Z", assertion_status: i === 3 ? null : "observed"
  }));

  it("창 수와 합계, 증가율을 계산한다", () => {
    const report = measureAnnotation(fragments, { window: 3, countTokens: charCount });

    assert.equal(report.windows, 3);
    assert.equal(report.fragments, 7);
    assert.ok(report.total.tokens_on > report.total.tokens_off);
    assert.equal(report.total.growth_ratio,
      Number(((report.total.tokens_on - report.total.tokens_off) / report.total.tokens_off).toFixed(4)));
    assert.ok(report.per_window_growth.min <= report.per_window_growth.median);
    assert.ok(report.per_window_growth.median <= report.per_window_growth.max);
  });

  it("줄당 주석 토큰은 on과 off 차이를 기억 줄 수로 나눈 값이다", () => {
    const report = measureAnnotation(fragments, { window: 10, countTokens: charCount });
    assert.equal(report.memory_lines, 7);
    assert.equal(report.per_line.annotation_tokens_mean,
      Number(((report.total.tokens_on - report.total.tokens_off) / 7).toFixed(4)));
  });

  it("꾸러미 부가 토큰은 본문만의 토큰보다 크다", () => {
    const report = measureAnnotation(fragments, { window: 4, countTokens: charCount });
    assert.ok(report.pack.pack_tokens > report.pack.content_tokens);
    assert.ok(report.pack.overhead_ratio > 0);
  });
});

describe("진입점", () => {
  it("기본 입력으로 JSON 보고를 낸다", async () => {
    const chunks = [];
    const code   = await main([], { write: text => chunks.push(text) });
    const report = JSON.parse(chunks.join(""));

    assert.equal(code, 0);
    assert.equal(report.schema, "context-annotation-tokens/v1");
    assert.equal(report.input.path, path.relative(ROOT, DEFAULT_FRAGMENTS));
    assert.equal(report.input.window, DEFAULT_WINDOW);
    assert.equal(report.tokenizer, "cl100k_base");
    assert.ok(report.total.tokens_on > report.total.tokens_off);
    assert.ok(report.total.growth_ratio > 0);
  });

  it("--help는 사용법을 낸다", async () => {
    const chunks = [];
    assert.equal(await main(["--help"], { write: text => chunks.push(text) }), 0);
    assert.match(chunks.join(""), /--fragments/);
  });

  it("설정, DB, 환경 파일을 불러오지 않는다", () => {
    assert.doesNotMatch(SCRIPT_SRC, /lib\/config\.js|tools\/db\.js|dotenv/);
  });
});
