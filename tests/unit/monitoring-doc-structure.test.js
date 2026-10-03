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

import { register, protocolVersionLabel } from "../../lib/metrics.js";
import { SUPPORTED_PROTOCOL_VERSIONS }     from "../../lib/protocol-versions.js";
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

/**
 * 경보 규칙의 expr 값 목록.
 * expr 키보다 더 들여쓴 줄은 같은 값의 연속이므로(블록 스칼라 | > 와 여러 줄 평문 모두) 공백 하나로 이어 붙인다.
 */
function ruleExprs(block) {
  const lines = block.split("\n");
  const out   = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:-\s+)?)expr:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const keyIndent = m[1].length;
    const parts     = /^[|>][+-]?\d*$/.test(m[2].trim()) ? [] : [m[2].trim()];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.trim() !== "" && next.length - next.trimStart().length <= keyIndent) break;
      if (next.trim() !== "") parts.push(next.trim());
      i++;
    }
    out.push(parts.join(" ").replace(/^(["'])(.*)\1$/, "$2"));
  }
  return out;
}

/**
 * expr 에서 지표 참조를 뽑는다.
 * 지표 이름 뒤의 { ... } 셀렉터에 쓰인 라벨 이름과 라벨 매처(이름, 연산자, 값)를 함께 돌려준다.
 */
function metricRefs(expr) {
  const refs = [];
  const re   = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(\{([^}]*)\})?/g;
  for (const m of expr.matchAll(re)) {
    const name = m[1];
    if (!/^(mcp|memento|up)(_|$)/.test(name)) continue;
    const matchers = m[3]
      ? [...m[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"/g)]
        .map((l) => ({ label: l[1], op: l[2], value: l[3] }))
      : [];
    const labels = m[3]
      ? [...m[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)/g)].map((l) => l[1])
      : [];
    refs.push({ name, labels, matchers });
  }
  return refs;
}

/**
 * 값 집합이 닫혀 있는(코드가 만들 수 있는 값이 정해진) 라벨의 허용 값.
 * 허용 값은 코드의 내보내기에서 도출한다.
 */
function closedLabelValues() {
  const protocolValues = new Set([
    ...SUPPORTED_PROTOCOL_VERSIONS.map(protocolVersionLabel),
    protocolVersionLabel(undefined),
    protocolVersionLabel("\u0000unsupported-version")
  ]);
  return {
    mcp_protocol_version_negotiations_total: {
      requested_version : protocolValues,
      negotiated_version: protocolValues
    }
  };
}

/** 매처 하나가 허용 값 중 하나와 맞을 수 있는지(= 은 포함, != 은 허용 값이 둘 이상, =~ !~ 은 전체 일치 정규식 기준) */
function matcherCanMatch({ op, value }, allowed) {
  const values = [...allowed];
  if (op === "=")  return allowed.has(value);
  if (op === "!=") return values.some((v) => v !== value);
  const hits = values.filter((v) => new RegExp(`^(?:${value})$`).test(v));
  return op === "=~" ? hits.length > 0 : hits.length < values.length;
}

/** 닫힌 라벨을 쓰는 규칙 셀렉터에서 코드가 만들 수 없는 값을 찾아 설명 문자열로 돌려준다. */
function unreachableLabelValues(expr, closed) {
  const problems = [];
  for (const { name, matchers } of metricRefs(expr)) {
    for (const matcher of matchers) {
      const allowed = closed[name]?.[matcher.label];
      if (allowed && !matcherCanMatch(matcher, allowed)) {
        problems.push(`${name}{${matcher.label}${matcher.op}"${matcher.value}"} 허용 값: ${[...allowed].join(", ")}`);
      }
    }
  }
  return problems;
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

  it("규칙 개수와 파싱된 expr 개수가 같다(건너뛴 규칙이 없다)", () => {
    const alerts = alertBlock(DOC).match(/^\s*-\s+alert:/gm) ?? [];
    assert.equal(exprs.length, alerts.length);
    assert.ok(exprs.every((e) => e.length > 1 && !/^[|>]/.test(e)), exprs.join(" ; "));
  });

  it("규칙 셀렉터의 라벨 값은 코드가 만들 수 있는 값이다(값 집합이 닫힌 라벨)", () => {
    const closed = closedLabelValues();
    const used   = exprs.flatMap((e) => metricRefs(e)).flatMap((r) => r.matchers.map((m) => ({ name: r.name, ...m })));
    assert.ok(used.some((u) => closed[u.name]?.[u.label]), "닫힌 라벨 값을 쓰는 규칙이 하나도 없다");
    for (const expr of exprs) assert.deepEqual(unreachableLabelValues(expr, closed), []);
  });

  it("프로토콜 버전 라벨의 허용 값에 other 와 none 이 들어 있다", () => {
    const allowed = closedLabelValues().mcp_protocol_version_negotiations_total.requested_version;
    assert.ok(allowed.has("other") && allowed.has("none"));
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) assert.ok(allowed.has(v));
  });

  it("엔드포인트 표에 /health 행이 있고 /metrics 의 401 응답을 밝힌다", () => {
    const rows = DOC.split("\n").filter((l) => l.startsWith("|"));
    assert.ok(rows.some((r) => r.startsWith("| `/health` |")));
    assert.ok(rows.some((r) => r.startsWith("| `/metrics` |") && r.includes("401")));
  });

  it("/health/live 와 /health/ready 가 키를 요구하지 않는다고 밝힌다", () => {
    assert.match(DOC, /`\/health\/live`와 `\/health\/ready`는[^\n]*키 없이 응답한다/);
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

describe("규칙 expr 파서", () => {
  const FIXTURE = [
    "groups:",
    "  - name: fixture",
    "    rules:",
    "      - alert: Inline",
    "        expr: sum(rate(mcp_a_total[5m])) > 0",
    "        for: 1m",
    "      - alert: Literal",
    "        expr: |",
    "          sum(increase(",
    "            mcp_protocol_version_negotiations_total{requested_version=\"bogus\"}[1h]",
    "          )) > 0",
    "",
    "        labels: { severity: info }",
    "      - alert: Folded",
    "        expr: >-",
    "          sum(rate(memento_b_total[5m]))",
    "            > 0",
    "      - alert: Plain",
    "        expr: sum(rate(mcp_c_total[5m]))",
    "          / sum(rate(mcp_d_total[5m]))",
    "      - alert: Last",
    "        expr: up{job=\"memento-mcp\"} == 0",
    ""
  ].join("\n");

  it("여러 줄 블록 스칼라와 평문 연속을 하나의 식으로 잇는다", () => {
    assert.deepEqual(ruleExprs(FIXTURE), [
      "sum(rate(mcp_a_total[5m])) > 0",
      "sum(increase( mcp_protocol_version_negotiations_total{requested_version=\"bogus\"}[1h] )) > 0",
      "sum(rate(memento_b_total[5m])) > 0",
      "sum(rate(mcp_c_total[5m])) / sum(rate(mcp_d_total[5m]))",
      "up{job=\"memento-mcp\"} == 0"
    ]);
  });

  it("여러 줄 규칙의 셀렉터 라벨 값도 허용 값 검사에 걸린다", () => {
    const exprs = ruleExprs(FIXTURE);
    const bad   = unreachableLabelValues(exprs[1], closedLabelValues());
    assert.equal(bad.length, 1);
    assert.match(bad[0], /requested_version="bogus"/);
    assert.deepEqual(unreachableLabelValues(exprs[0], closedLabelValues()), []);
  });

  it("연산자별 라벨 값 판정", () => {
    const closed = closedLabelValues();
    const sel    = (m) => `sum(mcp_protocol_version_negotiations_total{${m}})`;
    assert.deepEqual(unreachableLabelValues(sel('requested_version="other"'), closed), []);
    assert.deepEqual(unreachableLabelValues(sel('requested_version=~"other|none"'), closed), []);
    assert.deepEqual(unreachableLabelValues(sel('requested_version!="other"'), closed), []);
    assert.equal(unreachableLabelValues(sel('requested_version=~"x.*"'), closed).length, 1);
    assert.equal(unreachableLabelValues(sel('negotiated_version="1999-01-01"'), closed).length, 1);
    assert.deepEqual(unreachableLabelValues(sel('unrelated="anything"'), closed), []);
  });
});
