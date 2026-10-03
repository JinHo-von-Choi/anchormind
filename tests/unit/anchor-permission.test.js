/**
 * 앵커 권한 판정 순수 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 권한 포함 판정(rbac), 앵커 변경 종류, 권한과 상한 판정, 주체 표지, 스위치와 상한 판독을
 * DB 없이 확인한다.
 */

import { describe, it, afterEach } from "node:test";
import assert                      from "node:assert/strict";

import { ANCHOR_PERMISSION, hasAnchorPermission, checkPermission } from "../../lib/rbac.js";
import {
  ANCHOR_RULES,
  ANCHOR_REASONS,
  anchorChange,
  decideAnchor,
  anchorPrincipalLabel
} from "../../lib/memory/anchorPolicy.js";
import {
  anchorPermissionMode,
  anchorLimitPerKey,
  DEFAULT_ANCHOR_LIMIT_PER_KEY
} from "../../lib/config.js";

describe("hasAnchorPermission", () => {
  it("anchor 권한 이름은 anchor다", () => {
    assert.equal(ANCHOR_PERMISSION, "anchor");
  });

  it("anchor 또는 admin 권한이 있으면 참이다", () => {
    assert.equal(hasAnchorPermission(["read", "write", "anchor"]), true);
    assert.equal(hasAnchorPermission(["admin"]), true);
  });

  it("write만으로는 거짓이다", () => {
    assert.equal(hasAnchorPermission(["read", "write"]), false);
  });

  it("배열이 아니면 거짓이다", () => {
    assert.equal(hasAnchorPermission(null), false);
    assert.equal(hasAnchorPermission("anchor"), false);
  });

  it("anchor 권한은 도구 호출 권한을 대신하지 않는다", () => {
    assert.equal(checkPermission(["anchor"], "remember").allowed, false);
  });
});

describe("anchorChange", () => {
  const create = (isAnchor) => ({ op: "create", fields: {}, draft: { is_anchor: isAnchor } });
  const update = (fields, baseAnchor) => ({ op: "update", fields, base: { is_anchor: baseAnchor }, draft: null });

  it("생성 후보가 앵커이면 set이다", () => {
    assert.equal(anchorChange(create(true)), "set");
    assert.equal(anchorChange(create(false)), null);
  });

  it("갱신은 앵커가 아닌 행을 앵커로 바꿀 때 set이다", () => {
    assert.equal(anchorChange(update({ is_anchor: true }, false)), "set");
    assert.equal(anchorChange(update({ is_anchor: true }, null)), "set");
  });

  it("갱신은 앵커 행의 표시를 내릴 때 clear다", () => {
    assert.equal(anchorChange(update({ is_anchor: false }, true)), "clear");
  });

  it("값이 그대로이거나 is_anchor를 바꾸지 않는 갱신은 변경이 아니다", () => {
    assert.equal(anchorChange(update({ is_anchor: true }, true)), null);
    assert.equal(anchorChange(update({ is_anchor: false }, false)), null);
    assert.equal(anchorChange(update({ content: "x" }, true)), null);
  });
});

describe("decideAnchor", () => {
  it("master는 권한과 상한 없이 허용한다", () => {
    assert.deepEqual(decideAnchor({ isMaster: true, permissions: [], anchorCount: 5000, limit: 1 }),
      { granted: true, reason: ANCHOR_REASONS.MASTER });
  });

  it("조회 실패는 허용하지 않는다", () => {
    assert.deepEqual(decideAnchor({ lookupFailed: true, permissions: ["anchor"], anchorCount: 0, limit: 10 }),
      { granted: false, reason: ANCHOR_REASONS.LOOKUP_FAILED });
  });

  it("anchor 권한이 없으면 허용하지 않는다", () => {
    assert.deepEqual(decideAnchor({ permissions: ["read", "write"], anchorCount: 0, limit: 10 }),
      { granted: false, reason: ANCHOR_REASONS.PERMISSION });
  });

  it("살아 있는 앵커 수가 상한에 이르면 허용하지 않는다", () => {
    assert.deepEqual(decideAnchor({ permissions: ["anchor"], anchorCount: 10, limit: 10 }),
      { granted: false, reason: ANCHOR_REASONS.LIMIT });
  });

  it("권한이 있고 상한 아래면 허용한다", () => {
    assert.deepEqual(decideAnchor({ permissions: ["write", "anchor"], anchorCount: 9, limit: 10 }),
      { granted: true, reason: ANCHOR_REASONS.PERMITTED });
  });

  it("거부 사유마다 위반 규칙 이름이 있다", () => {
    assert.equal(ANCHOR_RULES[ANCHOR_REASONS.PERMISSION], "anchorPermissionRequired");
    assert.equal(ANCHOR_RULES[ANCHOR_REASONS.LIMIT], "anchorLimitExceeded");
    assert.equal(ANCHOR_RULES[ANCHOR_REASONS.LOOKUP_FAILED], "anchorLookupFailed");
  });
});

describe("anchorPrincipalLabel", () => {
  it("키 앵커는 k: 뒤에 키 id 해시 앞 4자를 붙인다", () => {
    const label = anchorPrincipalLabel("0f9c1d1e-1111-4222-8333-944455556666");
    assert.match(label, /^k:[0-9a-f]{4}$/);
  });

  it("키 id 원문의 일부를 담지 않고 같은 키는 같은 표지다", () => {
    const keyId = "abcd1234-0000-4000-8000-000000000000";
    assert.equal(anchorPrincipalLabel(keyId), anchorPrincipalLabel(keyId));
    assert.notEqual(anchorPrincipalLabel(keyId), "k:abcd");
  });

  it("마스터 앵커(key_id 없음)는 master다", () => {
    assert.equal(anchorPrincipalLabel(null), "master");
    assert.equal(anchorPrincipalLabel(undefined), "master");
  });
});

describe("앵커 스위치와 상한 판독", () => {
  afterEach(() => {
    delete process.env.MEMENTO_ANCHOR_PERMISSION;
    delete process.env.MEMENTO_ANCHOR_LIMIT_PER_KEY;
  });

  it("MEMENTO_ANCHOR_PERMISSION 기본값은 warn이다", () => {
    assert.equal(anchorPermissionMode(), "warn");
  });

  it("off, warn, enforce를 호출 시점에 읽고 그 밖의 값은 warn이다", () => {
    for (const value of ["off", "warn", "enforce"]) {
      process.env.MEMENTO_ANCHOR_PERMISSION = value;
      assert.equal(anchorPermissionMode(), value);
    }
    process.env.MEMENTO_ANCHOR_PERMISSION = "strict";
    assert.equal(anchorPermissionMode(), "warn");
  });

  it("키별 앵커 상한 기본값은 1000이고 운영 최댓값 659보다 크다", () => {
    assert.equal(DEFAULT_ANCHOR_LIMIT_PER_KEY, 1000);
    assert.equal(anchorLimitPerKey(), 1000);
    assert.ok(anchorLimitPerKey() > 659);
  });

  it("상한은 1 이상의 정수를 읽고 그 밖은 기본값이다", () => {
    process.env.MEMENTO_ANCHOR_LIMIT_PER_KEY = "2500";
    assert.equal(anchorLimitPerKey(), 2500);
    for (const bad of ["0", "-3", "1.5", "many"]) {
      process.env.MEMENTO_ANCHOR_LIMIT_PER_KEY = bad;
      assert.equal(anchorLimitPerKey(), 1000);
    }
  });
});
