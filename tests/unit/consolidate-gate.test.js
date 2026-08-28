/**
 * Consolidate safety gate 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import {
  extractDistinctiveTokens,
  findLostTokens,
  judgeMergePair,
  summarizeGate,
  shouldAbortCycle,
} from "../../lib/memory/consolidate/consolidate-gate.js";

describe("extractDistinctiveTokens", () => {
  test("수치와 단위를 뽑는다", () => {
    const t = extractDistinctiveTokens("타임아웃을 30000ms로 올렸다");
    assert.ok(t.has("30000ms") || t.has("30000"));
  });

  test("snake_case 식별자와 대문자 상수를 뽑는다", () => {
    const t = extractDistinctiveTokens("max_connections와 MEMENTO_ACCESS_KEY를 바꿨다");
    assert.ok(t.has("max_connections"));
    assert.ok(t.has("memento_access_key"));
  });

  test("경로를 뽑는다", () => {
    const t = extractDistinctiveTokens("설정은 /etc/nginx/nginx.conf에 있다");
    assert.ok([...t].some(x => x.includes("/etc/nginx")));
  });

  test("0과 1은 변별력이 없어 제외한다", () => {
    const t = extractDistinctiveTokens("첫 번째 항목 0 1");
    assert.ok(!t.has("0"));
    assert.ok(!t.has("1"));
  });

  test("2 이상 수치는 의미를 실을 수 있어 남긴다", () => {
    const t = extractDistinctiveTokens("재시도 3회, 복제본 2개");
    assert.ok(t.has("3"));
    assert.ok(t.has("2"));
  });
});

describe("findLostTokens", () => {
  test("승계자에 없는 수치를 찾아낸다", () => {
    const lost = findLostTokens(
      "max_connections를 200으로 설정했다",
      "max_connections를 500으로 설정했다"
    );
    assert.ok(lost.includes("500"));
  });

  test("내용이 같으면 소실 토큰이 없다", () => {
    assert.deepEqual(findLostTokens("포트를 3300으로 바꿨다", "포트를 3300으로 바꿨다"), []);
  });
});

describe("judgeMergePair", () => {
  test("수치만 다른 근접 중복은 병합을 차단한다", () => {
    const v = judgeMergePair({
      keepContent: "PostgreSQL max_connections를 200으로 설정했다",
      oldContent : "PostgreSQL max_connections를 500으로 설정했다",
      cosine     : 0.99,
    });
    assert.equal(v.allow, false);
    assert.equal(v.reason, "distinctive_token_loss");
    assert.ok(v.lostTokens.includes("500"));
  });

  test("표현만 다르고 값이 같으면 병합을 허용한다", () => {
    const v = judgeMergePair({
      keepContent: "Grafana 내부 포트를 3300으로 고정했다",
      oldContent : "Grafana 포트 3300 고정",
      cosine     : 0.95,
    });
    assert.equal(v.allow, true);
    assert.equal(v.reason, null);
  });

  test("코사인 하한 미달은 차단한다", () => {
    const v = judgeMergePair({ keepContent: "가", oldContent: "나", cosine: 0.5 });
    assert.equal(v.allow, false);
    assert.equal(v.reason, "cosine_below_floor");
  });

  test("승계자가 현저히 짧으면 정보 삭제로 보고 차단한다", () => {
    const v = judgeMergePair({
      keepContent: "배포 절차 요약",
      oldContent : "배포 절차 요약: 변경 목록 확인 후 스키마 호환을 검토하고 롤백 경로를 확인한 다음 승인 단계를 거친다",
      cosine     : 0.95,
    });
    assert.equal(v.allow, false);
    assert.equal(v.reason, "survivor_shorter");
  });

  test("maxLostTokens를 올리면 소실을 허용할 수 있다", () => {
    const input = {
      keepContent: "타임아웃 30000ms 설정",
      oldContent : "타임아웃 30000ms 설정 재시도 3회",
      cosine     : 0.97,
    };
    assert.equal(judgeMergePair(input).allow, false);
    assert.equal(judgeMergePair(input, { maxLostTokens: 5 }).allow, true);
  });

  test("코사인이 없으면 하한 검사를 건너뛴다", () => {
    const v = judgeMergePair({ keepContent: "포트 3300 고정", oldContent: "포트 3300" });
    assert.equal(v.allow, true);
  });
});

describe("summarizeGate", () => {
  test("차단 비율과 사유별 건수를 낸다", () => {
    const s = summarizeGate([
      { allow: true,  reason: null },
      { allow: false, reason: "distinctive_token_loss" },
      { allow: false, reason: "distinctive_token_loss" },
      { allow: false, reason: "survivor_shorter" },
    ]);
    assert.equal(s.total, 4);
    assert.equal(s.blocked, 3);
    assert.equal(s.allowed, 1);
    assert.equal(s.lossRate, 0.75);
    assert.equal(s.byReason.distinctive_token_loss, 2);
  });

  test("빈 입력은 0으로 처리한다", () => {
    const s = summarizeGate([]);
    assert.equal(s.total, 0);
    assert.equal(s.lossRate, 0);
  });
});

describe("shouldAbortCycle", () => {
  test("임계 이하면 중단하지 않고 연속 카운터를 초기화한다", () => {
    const r = shouldAbortCycle(0.01, { consecutive: 1 }, {}, 100);
    assert.equal(r.abort, false);
    assert.equal(r.state.consecutive, 0);
  });

  test("첫 위반은 중단하지 않고 카운터만 올린다", () => {
    const r = shouldAbortCycle(0.10, { consecutive: 0 }, {}, 100);
    assert.equal(r.abort, false);
    assert.equal(r.state.consecutive, 1);
  });

  test("연속 위반이 기준에 도달하면 중단한다", () => {
    const r = shouldAbortCycle(0.10, { consecutive: 1 }, {}, 100);
    assert.equal(r.abort, true);
    assert.ok(r.reason.includes("consecutive"));
  });

  test("표본이 적으면 판정을 유보한다", () => {
    const r = shouldAbortCycle(1.0, { consecutive: 1 }, {}, 3);
    assert.equal(r.abort, false);
    assert.equal(r.state.consecutive, 0);
  });
});
