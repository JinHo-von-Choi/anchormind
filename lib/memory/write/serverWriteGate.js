/**
 * 서버 쓰기 경로의 의미 쓰기 관문 생성
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 키의 workspace 허가 집합과 hard gate 설정을 ApiKeyStore에서 읽는 관문을 만든다. WriteGate는
 * DB 모듈을 import하지 않으므로 서버 쪽 의존성은 여기서 주입한다.
 */

import { WriteGate }                                    from "./WriteGate.js";
import { checkWorkspaceAllowed, getSymbolicHardGate }   from "../../admin/ApiKeyStore.js";

/**
 * @returns {WriteGate}
 */
export function createServerWriteGate() {
  return new WriteGate({ checkWorkspaceAllowed, getHardGate: getSymbolicHardGate });
}
