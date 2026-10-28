/**
 * 관리 콘솔 검토 대기, 모순 처리, 검색 진단, 운영 상태, 가져오기, 권한 확인 화면의 렌더와 요청 조립 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-28
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupDom, flatQuery } from "./admin-test-helper.js";

setupDom();

const review    = await import("../../assets/admin/modules/review.js");
const conflicts = await import("../../assets/admin/modules/conflicts.js");
const lab       = await import("../../assets/admin/modules/search-lab.js");
const overview  = await import("../../assets/admin/modules/overview.js");
const memory    = await import("../../assets/admin/modules/memory.js");
const users     = await import("../../assets/admin/modules/admin-users.js");
const auto      = await import("../../assets/admin/modules/auto-refresh.js");

/** 렌더 결과의 모든 텍스트 */
function allText(node) {
  const parts = [];
  const walk  = (n) => {
    if (!n) return;
    if (n.textContent) parts.push(n.textContent);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return parts.join(" ");
}

describe("검토 대기", () => {
  it("같은 파편의 결정 요청은 같은 멱등 키를 쓴다", () => {
    const a = review.reviewDecisionBody("frag-1", { note: "  ok  ", applyAnchor: true });
    const b = review.reviewDecisionBody("frag-1");
    assert.equal(a.idempotencyKey, b.idempotencyKey);
    assert.equal(a.note, "ok");
    assert.equal(a.applyAnchor, true);
    assert.equal(b.applyAnchor, false);
    assert.ok(!("note" in b));
    assert.notEqual(review.reviewDecisionBody("frag-2").idempotencyKey, a.idempotencyKey);
  });

  it("메모는 500자에서 자른다", () => {
    assert.equal(review.reviewDecisionBody("frag-3", { note: "x".repeat(600) }).note.length, 500);
  });

  it("검토 사유 코드를 문구로 바꾸고 모르는 코드는 그대로 둔다", () => {
    assert.equal(review.reviewReasonLabel(["instruction_override", "zzz"]), "지시 덮어쓰기 문구, zzz");
    assert.equal(review.reviewReasonLabel([]), "-");
  });

  it("자동 거절까지 남은 일수를 센다", () => {
    const now = Date.parse("2026-10-28T00:00:00Z");
    assert.equal(review.autoRejectLabel("2026-10-30T12:00:00Z", now), "3일 뒤 자동 거절");
    assert.equal(review.autoRejectLabel("2026-10-27T00:00:00Z", now), "오늘 자동 거절");
  });

  it("권한 없는 앵커 요청에만 앵커 적용 선택을 둔다", () => {
    const plain  = review.renderReviewItem({ id: "f1", review_reasons: ["mode_all"] }, () => {});
    const anchor = review.renderReviewItem({ id: "f2", review_reasons: ["anchor_unauthorized"] }, () => {});
    assert.ok(!allText(plain).includes("앵커 적용"));
    assert.ok(allText(anchor).includes("승인하면서 앵커 적용"));
  });

  it("결정 결과 문구는 재요청과 앵커 적용을 구분한다", () => {
    assert.equal(review.decisionMessage("approve", { replayed: true }), "승인했습니다 (이미 처리된 요청)");
    assert.equal(review.decisionMessage("approve", { anchorApplied: true }), "승인했습니다 · 앵커 적용");
    assert.equal(review.decisionMessage("reject", {}), "거절했습니다");
  });
});

describe("모순 처리", () => {
  const base = { id: 7, left_id: "L", right_id: "R", left_anchor: false, right_anchor: true };

  it("만료될 쪽이 앵커이면 그 결정을 막는다", () => {
    assert.equal(conflicts.decisionBlocked(base, "keep_left"), true);
    assert.equal(conflicts.decisionBlocked(base, "keep_right"), false);
    assert.equal(conflicts.decisionBlocked(base, "keep_both"), false);
  });

  it("미해결 모순은 결정 단추 네 개를, 해소한 모순은 결과 문구를 그린다", () => {
    const open = conflicts.renderConflictItem(base, () => {});
    const buttons = flatQuery(open, "button").filter(b => b.dataset?.decision);
    assert.equal(buttons.length, 4);
    assert.equal(buttons.find(b => b.dataset.decision === "keep_left").disabled, true);

    const done = conflicts.renderConflictItem({ ...base, decision: "keep_both", resolved_at: "2026-10-28T00:00:00Z" }, () => {});
    assert.ok(allText(done).includes("해소됨: 둘 다 유지"));
    assert.equal(flatQuery(done, "button").filter(b => b.dataset?.decision).length, 0);
  });

  it("주소 질의는 미해결이 기본이다", () => {
    conflicts.conflictsRoute.fromQuery(new URLSearchParams(""));
    assert.deepEqual(conflicts.conflictsRoute.toQuery(), { status: "" });
    conflicts.conflictsRoute.fromQuery(new URLSearchParams("status=all"));
    assert.deepEqual(conflicts.conflictsRoute.toQuery(), { status: "all" });
  });
});

describe("검색 진단", () => {
  it("검색 본문은 빈 항목을 빼고 결과 수를 50으로 묶는다", () => {
    assert.deepEqual(lab.buildSearchBody({ keyIds: "a, b,", keywords: "x", text: " ", type: "", topic: "t", pageSize: "80" }),
      { key_ids: ["a", "b"], keywords: ["x"], topic: "t", pageSize: 50 });
    assert.deepEqual(lab.buildSearchBody({ keyIds: "", keywords: "", text: "q", type: "fact", topic: "", pageSize: "" }),
      { text: "q", type: "fact" });
  });

  it("이벤트 id 질의는 숫자만 받는다", () => {
    lab.searchLabRoute.fromQuery(new URLSearchParams("event=12"));
    assert.deepEqual(lab.searchLabRoute.toQuery(), { event: "12" });
    lab.searchLabRoute.fromQuery(new URLSearchParams("event=1;drop"));
    assert.deepEqual(lab.searchLabRoute.toQuery(), { event: "" });
  });

  it("재실행 요약은 유효, 사라진 파편 수를 말한다", () => {
    assert.equal(lab.replaySummary({ mode: "current", originalSelectedCount: 3, selected: [{}, {}], unavailableIds: ["x"] }),
      "기록 당시 선택 3개 중 지금도 유효 2개, 사라짐 1개");
  });

  it("이벤트 상세는 선택 근거 코드를 함께 보여 준다", () => {
    const node = lab.renderSearchEvent({
      id: 5, created_at: "2026-10-28T00:00:00Z", search_path: "L1 → L2", result_count: 1,
      selected_fragment_ids: ["f1"], selection_reasons: { f1: { codes: ["direct_keyword_match"] } }
    });
    assert.ok(allText(node).includes("f1 · direct_keyword_match"));
  });
});

describe("운영 상태 패널", () => {
  it("실패가 마지막 성공보다 늦은 작업은 오류로 표시하고 스위치 요약을 보여 준다", () => {
    const panel = overview.renderOpsPanel({
      schedulerJobs: {
        outbox:      { lastSuccess: "2026-10-28T10:00:00Z", lastFailure: null, runCount: 3, failureCount: 0 },
        graphLinker: { lastSuccess: "2026-10-28T09:00:00Z", lastFailure: "2026-10-28T10:00:00Z", lastError: "boom", runCount: 4, failureCount: 1 }
      },
      lastConsolidation: null,
      switches: { on: 2, off: 1, mode: 1, nonDefaultCount: 1, nonDefault: ["X"], invalid: ["BAD"] }
    });
    const text = allText(panel);
    assert.ok(text.includes("아웃박스 처리"));
    assert.ok(text.includes("서버 시작 뒤 실행 기록 없음"));
    assert.ok(text.includes("켜짐 2 · 꺼짐 1"));
    assert.ok(text.includes("BAD"));
    const failedRow = flatQuery(panel, "span").find(s => String(s.className).includes("text-error") && s.textContent.includes("실패 1"));
    assert.ok(failedRow, "실패한 작업 행은 오류 색이다");
  });
});

describe("메모리 운영", () => {
  it("가져오기 요약은 시험 실행과 거부 사유를 구분한다", () => {
    const text = memory.importSummary({ dryRun: true, imported: 2, duplicates: 1, rejected: 1, errors: 0,
      links: { imported: 3 }, rejected_by_reason: { sensitive: 1 }, warnings: [] });
    assert.equal(text, "시험 실행: 새로 기록 2 · 중복 1 · 거부 1 · 오류 0 · 링크 3 (거부 사유: sensitive 1)");
  });

  it("변경 이력은 이전 판과 대체한 파편을 보여 준다", () => {
    const node = memory.renderFragmentHistory({
      versions: [{ amended_at: "2026-10-01T00:00:00Z", amended_by: "k1", type: "fact", topic: "t", content: "old" }],
      superseded_by_chain: []
    });
    const text = allText(node);
    assert.ok(text.includes("이전 판 1개"));
    assert.ok(text.includes("old"));
    assert.ok(text.includes("대체한 파편 없음"));
  });

  it("이상 징후 카드는 미해결 모순과 기간이 붙은 실패 검색 수를 보여 준다", () => {
    const panel = memory.renderAnomalyCards({ failedSearchCount: 4, failedSearchDays: 7, openConflicts: 2, qualityUnverified: 1, staleFragments: 3, staleDays: 30 });
    const text  = allText(panel);
    assert.ok(text.includes("결과 0건 검색 (7일)"));
    assert.ok(text.includes("미해결 모순"));
    assert.ok(text.includes("30일 넘게 접근 없음"));
  });

  it("주소 질의와 조회 조건이 서로 옮겨진다", () => {
    memory.memoryRoute.fromQuery(new URLSearchParams("topic=a&page=3&frag=f9"));
    const q = memory.memoryRoute.toQuery();
    assert.equal(q.topic, "a");
    assert.equal(q.page, 3);
    assert.equal(q.frag, "f9");
    memory.memoryRoute.fromQuery(new URLSearchParams(""));
    assert.equal(memory.memoryRoute.toQuery().page, "");
  });
});

describe("권한 확인과 자동 갱신 문구", () => {
  it("판정 단계를 줄마다 적는다", () => {
    const lines = users.explainLines({ allowed: false, cap: "mem.write", workspace: "ws", deniedAt: "workspace", reason: "outside",
      steps: [{ step: "principal", ok: true }, { step: "workspace", ok: false, reason: "outside" }] });
    assert.deepEqual(lines, ["거부 · mem.write @ws · 거부 단계 workspace (outside)", "통과 principal", "실패 workspace: outside"]);
  });

  it("자동 갱신 문구는 일시정지와 주기를 구분한다", () => {
    assert.equal(auto.autoRefreshLabel({ paused: true, intervalMs: 30000, lastAt: null }), "자동 갱신 일시정지");
    assert.equal(auto.autoRefreshLabel({ paused: false, intervalMs: 30000, lastAt: null }), "자동 갱신 30초");
  });
});
