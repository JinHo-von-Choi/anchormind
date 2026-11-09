/**
 * unlink 도구 정의
 *
 * 작성자: 최진호
 * 작성일: 2026-11-09
 */

import { TOOL_HEAD }     from "./tool-head.js";
import { COMMON_PARAMS } from "./memory-schemas.js";

export const unlinkDefinition = {
  ...TOOL_HEAD.unlink,
  description: "두 파편 사이의 방향이 정해진 링크 한 건을 해제한다. 파편과 다른 링크, 반대 방향 링크는 바꾸지 않으며 link로 다시 걸 수 있다. " +
                 "relationType이 현재 관계와 다르거나 링크가 없으면 아무것도 바꾸지 않고 unlinked=false를 돌려준다. " +
                 "contradicts와 닫힌 파편의 superseded_by는 해제할 수 없다. 파편의 linked_to에 저장된 선언 값은 바뀌지 않는다.",
  inputSchema: {
    type      : "object",
    properties: {
      fromId: {
        type       : "string",
        description: "링크의 시작 파편 ID",
        examples   : ["frag-error-001", "frag-abc123"]
      },
      toId: {
        type       : "string",
        description: "링크의 대상 파편 ID",
        examples   : ["frag-procedure-001", "frag-def456"]
      },
      relationType: {
        type       : "string",
        enum       : ["related", "caused_by", "resolved_by", "part_of", "contradicts", "superseded_by", "co_retrieved", "temporal"],
        description: "해제할 관계 유형. 현재 관계와 일치할 때만 해제한다.",
        examples   : ["related", "caused_by", "temporal"]
      },
      agentId: COMMON_PARAMS.agentId,
      dryRun: {
        type       : "boolean",
        description: "true 설정 시 실제 해제 없이 같은 권한 검사를 거쳐 해제 가능 여부만 반환.",
        examples   : [true, false]
      }
    },
    required: ["fromId", "toId", "relationType"]
  }
};
