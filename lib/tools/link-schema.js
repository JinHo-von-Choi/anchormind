/**
 * link 도구 정의
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { TOOL_HEAD }     from "./tool-head.js";
import { COMMON_PARAMS } from "./memory-schemas.js";

export const linkDefinition = {
  ...TOOL_HEAD.link,
  description: "두 파편 사이에 관계를 설정한다. 인과, 해결, 구성, 모순 관계를 명시. " +
                 "recall의 그래프 이웃 검색에서 링크된 파편은 추가 부스트를 받는다. " +
                 "에러(fromId) → 해결책(toId) 패턴: relationType='resolved_by'. " +
                 "더 구체적인 기존 관계는 유지하고 relationType에 실제 관계를 돌려준다. 낡은 링크는 unlink로 해제한다.",
  inputSchema: {
    type      : "object",
    properties: {
      fromId: {
        type       : "string",
        description: "시작 파편 ID (원인·에러 파편 권장)",
        examples   : ["frag-error-001", "frag-abc123"]
      },
      toId: {
        type       : "string",
        description: "대상 파편 ID (결과·해결책 파편 권장)",
        examples   : ["frag-procedure-001", "frag-def456"]
      },
      relationType: {
        type       : "string",
        enum       : ["related", "caused_by", "resolved_by", "part_of", "contradicts"],
        description: "관계 유형 (기본 related). " +
                     "resolved_by: 에러→해결책. caused_by: 원인→결과. " +
                     "part_of: 하위 파편→상위 에피소드. contradicts: 상충 파편 (자동 격리 트리거).",
        examples   : ["resolved_by", "caused_by", "related", "part_of", "contradicts"]
      },
      agentId: COMMON_PARAMS.agentId,
      workspace: {
        type       : "string",
        description: "이 요청의 워크스페이스. 공유 workspace가 제한된 그룹 멤버의 파편을 다룰 때 그 workspace를 지정한다. 미지정 시 키의 default_workspace.",
        examples   : ["memento-mcp", "personal"]
      },
      weight: {
        type       : "number",
        description: "관계 가중치 (0-1, 기본 1). ReconsolidationEngine이 접근 패턴에 따라 자동 조정한다.",
        examples   : [0.5, 0.8, 1.0]
      },
      dryRun: {
        type       : "boolean",
        description: "true 설정 시 실제 링크 생성 없이 소유권 검사 결과와 저장될 관계만 반환.",
        examples   : [true, false]
      }
    },
    required: ["fromId", "toId"]
  }
};
