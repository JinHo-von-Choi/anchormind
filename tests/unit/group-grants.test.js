/**
 * 키 그룹 멤버 권한 판정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 판정 행(같은 그룹의 다른 멤버별 can_*)에서 읽기 대상과 쓰기 권한을 만드는 규칙, 다른 키 파편에 대한 쓰기
 * 허용 판정, 공유 workspace 제한, 관리 API가 받는 권한 목록 검사를 확인한다.
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import {
  groupAccessFromRows, canActOnGroupFragment, normalizeMemberPermissions, sanitizeGroupGrants, GroupPermissionError,
  autoLinkOwnerKeys, isAutoLinkOwner, normalizeSharedWorkspaces, requestGroupKeyIds, isShareReadable
} from "../../lib/memory/groupGrants.js";

const row = (key_id, flags = {}) => ({ key_id, can_read: false, can_link: false, can_amend: false, can_forget: false, ...flags });

describe("판정 행에서 읽기 대상과 쓰기 권한", () => {
  it("읽을 수 없는 멤버는 쓰기 권한이 있어도 빠진다", () => {
    const access = groupAccessFromRows("me", [
      row("reader-ok", { can_read: true, can_link: true }),
      row("no-share",  { can_amend: true, can_forget: true })
    ]);
    assert.deepEqual(access.groupKeyIds, ["me", "reader-ok"]);
    assert.deepEqual(access.groupGrants, { link: ["reader-ok"], amend: [], forget: [] });
  });

  it("그룹이 없으면 자기 키만 읽고 쓰기 권한이 없다", () => {
    assert.deepEqual(groupAccessFromRows("me", []), {
      groupKeyIds: ["me"], groupGrants: { link: [], amend: [], forget: [] }, groupShareScopes: {}
    });
  });
});

describe("공유 workspace 제한", () => {
  it("여러 그룹의 공유 범위를 합치고, 한 그룹이라도 전체 공유면 제한이 없다", () => {
    const access = groupAccessFromRows("me", [
      row("b", { can_read: true, shared_workspaces: ["ws-b"] }),
      row("b", { can_read: true, shared_workspaces: ["ws-a", "ws-b"] }),
      row("c", { can_read: true, shared_workspaces: ["ws-c"] }),
      row("c", { can_read: true, shared_workspaces: null })
    ]);
    assert.deepEqual(access.groupShareScopes, { b: ["ws-a", "ws-b"] });
  });

  it("요청 workspace가 공유 목록 밖이거나 없으면 그 멤버를 읽기 대상에서 뺀다", () => {
    const scopes = { b: ["ws-a"] };
    assert.deepEqual(requestGroupKeyIds("me", ["me", "b", "c"], scopes, "ws-a"), ["me", "b", "c"]);
    assert.deepEqual(requestGroupKeyIds("me", ["me", "b", "c"], scopes, "ws-x"), ["me", "c"]);
    assert.deepEqual(requestGroupKeyIds("me", ["me", "b", "c"], scopes, null), ["me", "c"]);
    assert.equal(requestGroupKeyIds(null, null, scopes, "ws-a"), null);
  });

  it("id로 집은 제한 멤버의 파편은 공유 workspace나 전역 파편일 때만 읽힌다", () => {
    const ctx = { keyId: "me", groupShareScopes: { b: ["ws-a"] } };
    assert.equal(isShareReadable({ key_id: "b", workspace: "ws-a" }, ctx), true);
    assert.equal(isShareReadable({ key_id: "b", workspace: null }, ctx), true);
    assert.equal(isShareReadable({ key_id: "b", workspace: "ws-x" }, ctx), false);
    assert.equal(isShareReadable({ key_id: "c", workspace: "ws-x" }, ctx), true);
    assert.equal(isShareReadable({ key_id: "b", workspace: "ws-x" }, { keyId: null, groupShareScopes: ctx.groupShareScopes }), true);
  });

  it("공유 workspace 입력은 null(전체) 또는 중복 없는 이름 목록이다", () => {
    assert.equal(normalizeSharedWorkspaces(null), null);
    assert.deepEqual(normalizeSharedWorkspaces([" ws-a ", "ws-a", "ws-b"]), ["ws-a", "ws-b"]);
    assert.deepEqual(normalizeSharedWorkspaces([]), []);
    assert.throws(() => normalizeSharedWorkspaces("ws-a"), GroupPermissionError);
    assert.throws(() => normalizeSharedWorkspaces(["ws\u0001"]), GroupPermissionError);
    assert.throws(() => normalizeSharedWorkspaces(Array.from({ length: 65 }, (_, i) => `ws-${i}`)), GroupPermissionError);
  });
});

describe("다른 키 파편에 대한 쓰기 허용", () => {
  const ctx = { keyId: "me", groupGrants: { link: ["b"], amend: ["c"], forget: [] } };

  it("자기 파편과 마스터는 언제나 허용한다", () => {
    assert.equal(canActOnGroupFragment(ctx, "forget", "me"), true);
    assert.equal(canActOnGroupFragment({ keyId: null }, "amend", "anyone"), true);
  });

  it("받은 권한의 대상 키에만 허용한다", () => {
    assert.equal(canActOnGroupFragment(ctx, "link", "b"), true);
    assert.equal(canActOnGroupFragment(ctx, "amend", "b"), false);
    assert.equal(canActOnGroupFragment(ctx, "amend", "c"), true);
    assert.equal(canActOnGroupFragment(ctx, "forget", "c"), false);
  });

  it("마스터 소유(key_id 없음) 파편과 권한 맥락이 없는 요청은 거부한다", () => {
    assert.equal(canActOnGroupFragment(ctx, "link", null), false);
    assert.equal(canActOnGroupFragment({ keyId: "me", groupGrants: null }, "link", "b"), false);
  });
});

describe("권한 목록 입력", () => {
  it("정해진 순서의 중복 없는 배열로 만든다", () => {
    assert.deepEqual(normalizeMemberPermissions(["forget", "read", "read"]), ["read", "forget"]);
    assert.deepEqual(normalizeMemberPermissions([]), []);
  });

  it("모르는 권한과 배열이 아닌 값은 거부한다", () => {
    assert.throws(() => normalizeMemberPermissions(["read", "admin"]), GroupPermissionError);
    assert.throws(() => normalizeMemberPermissions("read"), GroupPermissionError);
  });

  it("세션 맥락의 형식이 틀린 값은 권한 없음으로 다룬다", () => {
    assert.deepEqual(sanitizeGroupGrants({ link: "b", amend: ["c", 3, ""] }), { link: [], amend: ["c"], forget: [] });
    assert.deepEqual(sanitizeGroupGrants(null), { link: [], amend: [], forget: [] });
  });
});

describe("키 상태로 세션 identity 갱신", async () => {
  const { identityFromKeyState } = await import("../../lib/keys/key-identity.js");

  it("키 상태의 그룹 접근과 기본 workspace로 바꾼다", () => {
    const fresh = identityFromKeyState(
      { permissions: ["read"], defaultWorkspace: null, groupKeyIds: ["me"], groupGrants: { link: [], amend: [], forget: [] } },
      { keyId: "me", groupKeyIds: ["me", "gone"] }
    );
    assert.deepEqual(fresh, {
      permissions: ["read"], defaultWorkspace: null, groupKeyIds: ["me"], groupGrants: { link: [], amend: [], forget: [] }, groupShareScopes: {}
    });
  });

  it("그룹 접근을 읽지 못하면(재확인 꺼짐) 저장된 그룹을 두고 읽을 수 있는 멤버 파편 링크만 허용한다", () => {
    const fresh = identityFromKeyState(null, { keyId: "me", groupKeyIds: ["me", "b"], groupShareScopes: { b: ["ws-a"] } });
    assert.deepEqual(fresh, { groupGrants: { link: ["b"], amend: [], forget: [] }, groupShareScopes: { b: ["ws-a"] } });
  });
});

describe("자동 링크 소유 키", () => {
  it("API 키는 자기 키와 link 권한을 받은 멤버 키 파편끼리만 잇는다", () => {
    const owners = autoLinkOwnerKeys("me", { link: ["b"], amend: ["c"], forget: [] });
    assert.deepEqual(owners, ["me", "b"]);
    assert.equal(isAutoLinkOwner("b", owners), true);
    assert.equal(isAutoLinkOwner("c", owners), false);
    assert.equal(isAutoLinkOwner(null, owners), false);
  });

  it("마스터는 마스터 파편(key_id 없음)끼리만 잇는다", () => {
    const owners = autoLinkOwnerKeys(null, null);
    assert.equal(owners, null);
    assert.equal(isAutoLinkOwner(null, owners), true);
    assert.equal(isAutoLinkOwner("any-key", owners), false);
  });
});
