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
 * 도구 정의 목록 (tools/list 응답용)
 */
export function getToolsDefinition(keyId) {
  const base = [
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
    reconstructHistoryDefinition,
    searchTracesDefinition,
    sessionRotateDefinition,
    batchStatusDefinition
  ];
  if (keyId === null) {
    base.push(checkUpdateDefinition, applyUpdateDefinition);
  }
  return base;
}
