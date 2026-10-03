/**
 * 쓰기 도구의 origin 파라미터 스키마
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * remember와 batch_remember 항목이 펼쳐 쓰는 inputSchema 조각이다. 허용 값은 lib/memory/provenance.js의
 * ORIGINS와 같다.
 */

import { ORIGINS } from "../memory/provenance.js";

export const ORIGIN_PARAM = {
  type       : "string",
  enum       : [...ORIGINS],
  description: "기억의 출처(클라이언트 주장). user_stated=사용자가 직접 말함, agent_inferred=에이전트 추론, " +
               "tool_output=도구 실행 결과, external_content=웹 문서 등 외부 내용, consolidation=정리와 요약 파생, " +
               "import=가져오기. 신뢰 등급은 출처 등급과 키 상한(trusted_origin 권한이 없으면 2) 중 작은 값이며, " +
               "external_content(등급 1)는 context의 ANCHOR와 CORE 주입에서 빠진다. 미지정 시 출처 없음(등급 2).",
  examples   : ["user_stated", "tool_output", "external_content"]
};
