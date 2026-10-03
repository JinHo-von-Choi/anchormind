/**
 * 관리 질의 workspace 범위 술어 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * scopePredicate는 판정 범위(range)를 SQL 조건 하나로 바꾼다. 범위가 전체면 TRUE, workspace 목록이면
 * 바인딩 하나를 쓰는 ANY 비교, 범위가 없거나 형식이 틀리면 FALSE(빈 결과)다. workspace 열이 없는 표는
 * 범위가 전체일 때만 TRUE다. scopedQuery는 다른 바인딩이 없는 질의에 술어와 바인딩 배열을 함께 만든다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { scopePredicate, scopedQuery, ScopeFilterError } from "../../lib/admin/ScopeFilter.js";

describe("scopePredicate", () => {
  it("전체 범위는 TRUE이고 바인딩을 더하지 않는다", () => {
    const params = ["x"];
    assert.equal(scopePredicate(params, "workspace", { all: true }), "TRUE");
    assert.equal(scopePredicate(params, null, { all: true }), "TRUE");
    assert.deepEqual(params, ["x"]);
  });

  it("workspace 목록은 다음 바인딩 번호의 ANY 비교다", () => {
    const params = ["a", "b"];
    const sql    = scopePredicate(params, "f.workspace", { all: false, workspaces: ["ws-a", "ws-b"] });
    assert.equal(sql, "f.workspace = ANY($3::text[])");
    assert.deepEqual(params[2], ["ws-a", "ws-b"]);
  });

  it("범위 입력이 없거나 형식이 틀리면 FALSE이고 바인딩을 더하지 않는다", () => {
    const inputs = [undefined, null, {}, { all: "true" }, { all: false }, { all: false, workspaces: [] },
      { all: false, workspaces: "ws-a" }, { all: false, workspaces: ["ws-a", 3] }, { all: false, workspaces: [""] }];
    for (const range of inputs) {
      const params = [];
      assert.equal(scopePredicate(params, "workspace", range), "FALSE", JSON.stringify(range));
      assert.deepEqual(params, []);
    }
  });

  it("workspace 열이 없는 표는 전체 범위가 아니면 FALSE다", () => {
    const params = [];
    assert.equal(scopePredicate(params, null, { all: false, workspaces: ["ws-a"] }), "FALSE");
    assert.deepEqual(params, []);
  });

  it("열 이름이 식별자 형식이 아니면 ScopeFilterError를 던진다", () => {
    for (const column of ["workspace; DROP TABLE x", "1abc", "a.b.c", "", "Workspace", 7]) {
      assert.throws(() => scopePredicate([], column, { all: true }), ScopeFilterError, String(column));
    }
  });

  it("바인딩 배열이 아니면 ScopeFilterError를 던진다", () => {
    assert.throws(() => scopePredicate(null, "workspace", { all: true }), ScopeFilterError);
  });
});

describe("scopedQuery", () => {
  it("술어를 질의 조립 함수에 넘기고 [질의, 바인딩]을 돌려준다", () => {
    const [text, values] = scopedQuery("workspace", { all: false, workspaces: ["ws-a"] }, (ws) => `SELECT 1 WHERE ${ws}`);
    assert.equal(text, "SELECT 1 WHERE workspace = ANY($1::text[])");
    assert.deepEqual(values, [["ws-a"]]);
  });

  it("범위가 없으면 FALSE 술어와 빈 바인딩이다", () => {
    assert.deepEqual(scopedQuery("workspace", undefined, (ws) => `WHERE ${ws}`), ["WHERE FALSE", []]);
    assert.deepEqual(scopedQuery(null, { all: true }, (ws) => `WHERE ${ws}`), ["WHERE TRUE", []]);
  });
});
