/**
 * 관리 처리기 직접 호출 시험의 owner 판정 도우미
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 관리 처리기는 디스패처(handleAdminApi)가 판정을 묶은 요청만 처리한다(판정 없는 요청은 빈 결과나 403).
 * 처리기를 직접 부르는 시험은 이 도우미로 요청에 마스터 키(owner) 판정을 묶는다.
 */

import { requireCapability, masterPrincipal } from "../../lib/admin/AdminAuthz.js";

/** 판정 허용 시에는 응답을 쓰지 않으므로 빈 응답 대역이면 된다. */
const UNUSED_RES = Object.freeze({ end() {}, setHeader() {} });

/**
 * 요청에 owner 판정을 묶고 같은 요청을 돌려준다.
 *
 * @template T
 * @param {T} req
 * @returns {T}
 */
export function asOwner(req) {
  requireCapability(req, UNUSED_RES, { principal: masterPrincipal(), cap: "system.update" });
  return req;
}

/**
 * 처리기를 감싸 첫 인자(요청)에 owner 판정을 묶는다.
 *
 * @param {Function} handler
 * @returns {Function}
 */
export function ownerHandler(handler) {
  return (req, ...rest) => handler(asOwner(req), ...rest);
}
