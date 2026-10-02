/**
 * 운영 지표 문서 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * docs/operations/monitoring.md 의 스크레이프 잡과 경보 규칙이 실제 등록된 지표와 라벨만
 * 참조하는지 본다. 규칙 본문을 문자열로 고정하지 않고 참조 관계만 검사한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";

import { register }     from "../../lib/metrics.js";
import "../../lib/memory/consolidate/split-metrics.js";

const DOC_URL = new URL("../../docs/operations/monitoring.md", import.meta.url);
const DOC     = readFileSync(DOC_URL, "utf8");

/** Prometheus 가 스크레이프마다 생성하는 시계열 이름 */
const SYNTHETIC_SERIES = new Set(["up"]);

/** 문서의 yaml 코드 블록 본문 목록 */
function yamlBlocks(text) {
  return [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** yaml 블록 중 경보 규칙 그룹을 가진 것 */
function alertBlock(text) {
  return yamlBlocks(text).find((b) => /^groups:/m.test(b)) ?? "";
}

/** yaml 블록 중 스크레이프 설정을 가진 것 */
function scrapeBlock(text) {
  return yamlBlocks(text).find((b) => /^scrape_configs:/m.test(b)) ?? "";
}

/** 경보 규칙의 expr 값 목록 */
function ruleExprs(block) {
  return [...block.matchAll(/^\s+expr:\s*(.+)$/gm)].map((m) => m[1].trim());
}

/**
 * expr 에서 지표 참조를 뽑는다.
 * 지표 이름 뒤의 { ... } 셀렉터에 쓰인 라벨 이름을 함께 돌려준다.
 */
function metricRefs(expr) {
  const refs = [];
  const re   = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(\{([^}]*)\})?/g;
  for (const m of expr.matchAll(re)) {
    const name = m[1];
    if (!/^(mcp|memento|up)(_|$)/.test(name)) continue;
    const labels = m[3]
      ? [...m[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)/g)].map((l) => l[1])
      : [];
    refs.push({ name, labels });
  }
  return refs;
}

describe("운영 지표 문서", () => {
  const registered = new Map(register.getMetricsAsArray().map((m) => [m.name, m]));
  const exprs      = ruleExprs(alertBlock(DOC));

  it("경보 규칙 그룹이 하나 이상의 규칙을 가진다", () => {
    assert.ok(exprs.length >= 4, `규칙 expr 수: ${exprs.length}`);
  });

  it("규칙이 참조하는 지표는 모두 등록돼 있다", () => {
    for (const expr of exprs) {
      for (const { name } of metricRefs(expr)) {
        if (SYNTHETIC_SERIES.has(name)) continue;
        assert.ok(registered.has(name), `미등록 지표: ${name} (${expr})`);
      }
    }
  });

  it("규칙 셀렉터의 라벨은 해당 지표의 라벨 이름에 있다", () => {
    for (const expr of exprs) {
      for (const { name, labels } of metricRefs(expr)) {
        if (SYNTHETIC_SERIES.has(name)) continue;
        const known = registered.get(name)?.labelNames ?? [];
        for (const label of labels) {
          assert.ok(known.includes(label), `${name} 에 없는 라벨: ${label}`);
        }
      }
    }
  });

  it("규칙 지표는 /metrics 출력에 TYPE 줄로 나타난다", async () => {
    const output = await register.metrics();
    for (const expr of exprs) {
      for (const { name } of metricRefs(expr)) {
        if (SYNTHETIC_SERIES.has(name)) continue;
        assert.match(output, new RegExp(`^# TYPE ${name} `, "m"), name);
      }
    }
  });

  it("스크레이프 잡은 memento-mcp 이름, 로컬 대상, 키 파일 참조를 가진다", () => {
    const block = scrapeBlock(DOC);
    assert.match(block, /job_name:\s*memento-mcp/);
    assert.match(block, /127\.0\.0\.1:57332/);
    assert.match(block, /metrics_path:\s*\/metrics/);
    assert.match(block, /credentials_file:\s*\S+/);
    assert.doesNotMatch(block, /credentials:\s*\S+/);
  });

  it("경보 규칙의 job 셀렉터는 스크레이프 잡 이름과 같다", () => {
    const jobs = [...exprs.join("\n").matchAll(/job="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(jobs.length > 0);
    for (const job of jobs) assert.equal(job, "memento-mcp");
  });

  it("문서에 내부 사설 주소가 없다", () => {
    assert.doesNotMatch(DOC, /\b(192\.168|10\.\d{1,3}|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/);
  });
});
