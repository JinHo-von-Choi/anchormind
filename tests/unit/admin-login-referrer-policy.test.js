/**
 * 관리 로그인 페이지 Referrer-Policy 계약 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 로그인 폼 POST가 Origin 허용 목록을 통과하도록 로그인 페이지는 같은 출처 한정 Referrer-Policy를 보낸다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleAdminUi } from "../../lib/admin/admin-routes.js";

function fakeRes() {
  const headers = {};
  return {
    statusCode: 0,
    headers,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    end()           { this.ended = true; }
  };
}

describe("관리 로그인 페이지 Referrer-Policy", () => {
  it("인증 없는 요청의 로그인 페이지는 same-origin을 보낸다", async () => {
    const res = fakeRes();
    await handleAdminUi({ headers: {}, method: "GET", url: "/v1/internal/model/nothing", socket: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers["referrer-policy"], "same-origin");
  });
});
