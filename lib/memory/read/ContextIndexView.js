/**
 * context 목록 보기(view=index)와 응답 표시
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * 목록 보기는 파편 본문 대신 첫 문장을 짧게 자른 줄로 고르고 주입한다. 사본의 id와 순위 필드는 원본과
 * 같으므로 ContextBuilder의 선택, 중복 제거, 최소 슬롯 보장이 그대로 동작한다.
 * annotateContextResult는 고른 결과에 앵커 토큰 예산 보고(budget.anchor)와 다른 작업 공간 fact 표시를 단다.
 */

import { contextAnchorTokenBudget } from "../../config.js";
import { anchorBudgetReport }       from "../anchorBudget.js";
import { countContentTokens }       from "./BudgetSelector.js";
import { workspaceBoundaryWarning } from "./WorkspaceBoundary.js";

/** 목록 줄 본문 최대 길이 */
const INDEX_LINE_CHARS = 60;

/**
 * 파편의 목록 줄 본문. 첫 문장(또는 첫 줄)을 INDEX_LINE_CHARS자로 자른다.
 *
 * @param {string} content
 * @returns {string}
 */
export function indexLine(content) {
  const first = String(content || "").split(/\n|(?<=[.!?。])\s/)[0].trim();
  return first.length > INDEX_LINE_CHARS ? `${first.slice(0, INDEX_LINE_CHARS)}…` : first;
}

/**
 * 섹션별 파편을 목록 줄 본문을 단 사본으로 바꾼다. id와 순위 필드는 그대로라 선택과 중복 제거가 같다.
 *
 * @param {{anchor: object[], core: object[], learning: object[], working: object[]}} sections
 * @returns {{anchor: object[], core: object[], learning: object[], working: object[]}}
 */
export function toIndexSections(sections) {
  const toIndex = f => ({ ...f, content: indexLine(f.content), index: true });
  return {
    anchor  : sections.anchor.map(toIndex),
    core    : sections.core.map(toIndex),
    learning: sections.learning.map(toIndex),
    working : sections.working.map(toIndex)
  };
}

/**
 * context 인자에 맞는 섹션. view=index이면 목록 줄 사본, 아니면 그대로.
 *
 * @param {{anchor: object[], core: object[], learning: object[], working: object[]}} sections
 * @param {{view?: string}} params
 */
export function contextSections(sections, params) {
  return params.view === "index" ? toIndexSections(sections) : sections;
}

/**
 * 고른 context 결과에 앵커 토큰 예산 보고와 다른 작업 공간 fact 표시를 단다.
 *
 * @param {{budget: Object}} ranked 선택 결과. budget.anchor를 단다
 * @param {object[]} anchors 주입한 앵커(순위순)
 * @param {object[]} fragments 응답 파편. 표시할 파편에 workspace_warning을 단다
 * @param {Object} params context 인자
 */
export function annotateContextResult(ranked, anchors, fragments, params) {
  const report = anchorBudgetReport(anchors, contextAnchorTokenBudget(), countContentTokens);
  if (report) ranked.budget.anchor = report;
  for (const fragment of fragments) {
    const warning = workspaceBoundaryWarning(fragment, params);
    if (warning) fragment.workspace_warning = warning;
  }
}
