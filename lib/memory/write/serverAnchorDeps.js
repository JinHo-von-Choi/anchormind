/**
 * 서버 쓰기 경로의 anchor 단계 의존성
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 키 권한과 살아 있는 앵커 수 조회(ApiKeyStore), 판정 감사 기록(anchorAudit)을 묶는다. WriteGate는
 * DB와 감사 모듈을 import하지 않으므로 앵커를 판정하는 진입점(remember, amend)의 호출자가 주입한다.
 */

import { getAnchorState }      from "../../admin/ApiKeyStore.js";
import { auditAnchorDecision } from "./anchorAudit.js";

/** anchor 단계의 서버 의존성 */
export const SERVER_ANCHOR_DEPS = Object.freeze({
  getAnchorState,
  auditAnchor: auditAnchorDecision
});
