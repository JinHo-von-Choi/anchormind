/**
 * 도구 모듈 인덱스 (Memory Only)
 *
 * memento-mcp: 기억 도구만 포함
 */

/** 통계 */
export { accessStats, updateAccessStats, saveAccessStats } from "./stats.js";

/** 에이전트 기억 도구 핸들러 */
import {
  tool_remember,
  tool_batchRemember,
  tool_recall,
  tool_forget,
  tool_link,
  tool_amend,
  tool_reflect,
  tool_context,
  tool_toolFeedback,
  tool_memoryStats,
  tool_memoryConsolidate,
  tool_graphExplore,
  tool_fragmentHistory,
  tool_getSkillGuide,
  tool_sessionRotate,
  tool_batchStatus,
  rememberDefinition,
  batchRememberDefinition,
  recallDefinition,
  forgetDefinition,
  linkDefinition,
  amendDefinition,
  reflectDefinition,
  contextDefinition,
  toolFeedbackDefinition,
  memoryStatsDefinition,
  memoryConsolidateDefinition,
  graphExploreDefinition,
  fragmentHistoryDefinition,
  getSkillGuideDefinition,
  sessionRotateDefinition,
  batchStatusDefinition
} from "./memory.js";
export {
  tool_remember,
  tool_batchRemember,
  tool_recall,
  tool_forget,
  tool_link,
  tool_amend,
  tool_reflect,
  tool_context,
  tool_toolFeedback,
  tool_memoryStats,
  tool_memoryConsolidate,
  tool_graphExplore,
  tool_fragmentHistory,
  tool_getSkillGuide,
  tool_sessionRotate,
  tool_batchStatus,
  rememberDefinition,
  batchRememberDefinition,
  recallDefinition,
  forgetDefinition,
  linkDefinition,
  amendDefinition,
  reflectDefinition,
  contextDefinition,
  toolFeedbackDefinition,
  memoryStatsDefinition,
  memoryConsolidateDefinition,
  graphExploreDefinition,
  fragmentHistoryDefinition,
  getSkillGuideDefinition,
  sessionRotateDefinition,
  batchStatusDefinition
};

/** 서사 재구성 도구 핸들러 */
import { tool_reconstructHistory, tool_searchTraces, reconstructHistoryDefinition, searchTracesDefinition } from "./reconstruct.js";
export { tool_reconstructHistory, tool_searchTraces, reconstructHistoryDefinition, searchTracesDefinition };
import { checkUpdateDefinition, applyUpdateDefinition }         from "./update-tools.js";

/**
 * 목록 맨 앞에 고정하는 핵심 도구. 도구 목록의 앞쪽만 노출하는 클라이언트에서도
 * 조회와 저장의 기본 도구가 보이도록 이 순서를 유지한다.
 */
const TOOL_LIST_PRIORITY = ["recall", "context", "remember"];

/**
 * 도구 정의 순서를 정의 선언 순서와 무관하게 고정한다.
 * 핵심 도구가 TOOL_LIST_PRIORITY 순서로 앞에 오고 나머지는 이름 오름차순이다.
 * 입력 배열은 바꾸지 않는다.
 *
 * @param {Object[]} tools
 * @returns {Object[]}
 */
export function sortToolsDefinition(tools) {
  const rank = (name) => {
    const idx = TOOL_LIST_PRIORITY.indexOf(name);
    return idx === -1 ? TOOL_LIST_PRIORITY.length : idx;
  };
  return [...tools].sort((a, b) =>
    rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

/**
 * 도구 정의 목록 (tools/list 응답용)
 */
export function getToolsDefinition(_keyId, isMaster = false) {
  const base = [
    rememberDefinition,
    recallDefinition,
    contextDefinition,
    batchRememberDefinition,
    forgetDefinition,
    linkDefinition,
    amendDefinition,
    reflectDefinition,
    toolFeedbackDefinition,
    graphExploreDefinition,
    fragmentHistoryDefinition,
    getSkillGuideDefinition,
    reconstructHistoryDefinition,
    searchTracesDefinition,
    sessionRotateDefinition,
    batchStatusDefinition
  ];
  if (isMaster === true) {
    base.push(
      memoryStatsDefinition, memoryConsolidateDefinition,
      checkUpdateDefinition, applyUpdateDefinition
    );
  }
  return sortToolsDefinition(base);
}
