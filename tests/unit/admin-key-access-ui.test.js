/**
 * 관리 콘솔 키 인스펙터의 그룹 접근 카드와 보존 정책 카드 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { setupDom }     from "./admin-test-helper.js";

setupDom();

const { renderKeyAccessCard, readableKeyDetail, keyLabel } = await import("../../assets/admin/modules/key-access.js");
const { renderKeyRetentionCard, parseRetentionInput }      = await import("../../assets/admin/modules/key-retention.js");

/** 요소 아래의 모든 글을 모은다. */
function texts(node) {
  const out = node.textContent ? [node.textContent] : [];
  for (const child of node.children ?? []) out.push(...texts(child));
  return out;
}

const ACCESS = {
  keyId           : "k-me",
  readableKeyIds  : ["k-b", "k-gone"],
  groupGrants     : { link: ["k-b"], amend: ["k-b"], forget: [] },
  groupShareScopes: { "k-gone": ["ws-a"] },
  days            : 7,
  sharedReads     : [{ reader_key_id: "k-b", reader_name: "reader-b", searches: 3, fragments: 5, last_at: "2026-11-03T00:00:00Z" }]
};

describe("그룹 접근 카드", () => {
  it("읽을 수 있는 키마다 받은 쓰기 권한과 공유 workspace 제한을 보여 준다", () => {
    assert.equal(readableKeyDetail("k-b", ACCESS), "read + link, amend · all workspaces");
    assert.equal(readableKeyDetail("k-gone", ACCESS), "read · workspaces: ws-a");
    assert.equal(readableKeyDetail("k-gone", { groupShareScopes: { "k-gone": [] } }), "read · workspaces: (none)");
  });

  it("목록에 없는 키는 id 앞부분으로, 키 없는 주체는 master로 쓴다", () => {
    const names = new Map([["k-b", "reader-b"]]);
    assert.equal(keyLabel("k-b", names), "reader-b");
    assert.equal(keyLabel("0123456789abcdef", names), "01234567…");
    assert.equal(keyLabel(null, names), "master");
  });

  it("자료를 읽어 읽기 대상과 공유 읽기 기록을 채운다", async () => {
    const calls = [];
    const card  = renderKeyAccessCard({ id: "k-me" }, [{ id: "k-b", name: "reader-b" }], {
      load: async (id) => { calls.push(id); return { ok: true, data: ACCESS }; }
    });
    await card.ready;
    const all = texts(card).join("\n");
    assert.deepEqual(calls, ["k-me"]);
    assert.match(all, /GROUP ACCESS/);
    assert.match(all, /reader-b/);
    assert.match(all, /k-gone…/);
    assert.match(all, /3 recalls · 5 fragments/);
  });

  it("읽기에 실패하면 오류 문구를 보여 준다", async () => {
    const card = renderKeyAccessCard({ id: "k-me" }, [], { load: async () => ({ ok: false, data: { error: "forbidden" } }) });
    await card.ready;
    assert.ok(texts(card).includes("forbidden"));
  });
});

describe("보존 정책 카드", () => {
  it("키 전체, workspace 하나, 지우기 입력을 읽고 형식이 틀리면 거부한다", () => {
    assert.deepEqual(parseRetentionInput("30"), { workspace: null, max_age_days: 30 });
    assert.deepEqual(parseRetentionInput("proj-a=7"), { workspace: "proj-a", max_age_days: 7 });
    assert.deepEqual(parseRetentionInput("proj-a="), { workspace: "proj-a", max_age_days: null });
    assert.deepEqual(parseRetentionInput("*="), { workspace: null, max_age_days: null });
    assert.equal(parseRetentionInput(null), undefined);
    assert.equal(parseRetentionInput(""), null);
    assert.equal(parseRetentionInput("0"), null);
    assert.equal(parseRetentionInput("w=abc"), null);
  });

  it("정책 목록을 보여 주고, 입력한 정책을 저장한 뒤 다시 읽는다", async () => {
    let stored = [{ workspace: null, max_age_days: 90 }];
    const saved = [];
    const card  = renderKeyRetentionCard({ id: "k-1" }, {
      load: async () => ({ ok: true, data: { policies: stored } }),
      save: async (id, body) => { saved.push([id, body]); stored = [...stored, { workspace: body.workspace, max_age_days: body.max_age_days }]; return { ok: true }; },
      ask : () => "proj-a=14"
    });
    await card.ready;
    assert.ok(texts(card).includes("All workspaces: delete after 90 days"));
    const btn = card.children.find((c) => c.id === "key-retention-edit");
    await btn._listeners.click[0]();
    assert.deepEqual(saved, [["k-1", { workspace: "proj-a", max_age_days: 14 }]]);
    assert.ok(texts(card).includes("proj-a: delete after 14 days"));
  });
});
