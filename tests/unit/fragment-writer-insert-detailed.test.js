/**
 * FragmentWriter.insertDetailed, restoreVersion 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 새로 만든 행과 기존 행을 구분하는 결과, 만든 시각 전달, importance 상한 적용 여부, 이력 행 기록을
 * DB 대역 위에서 확인한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

const statements = [];
let   insertRows = [{ id: "f1", created: true }];
let   twin       = null;

const fakeClient = {
  query: async (sql, params = []) => {
    statements.push({ sql, params });
    if (/^\s*SELECT id FROM/.test(sql)) return { rows: twin ? [{ id: twin }] : [] };
    if (/INSERT INTO\s+\S*fragments/.test(sql)) return { rows: insertRows };
    return { rows: [] };
  }
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => ({}),
    queryWithAgentVector: async () => ({ rows: [] })
  }
});

const { FragmentWriter, UngatedSemanticWriteError } = await import("../../lib/memory/write/FragmentWriter.js");
const { WriteGate }                                 = await import("../../lib/memory/write/WriteGate.js");

beforeEach(() => {
  statements.length = 0;
  insertRows        = [{ id: "f1", created: true }];
  twin              = null;
});

/** 관문을 거친 후보를 만든다. */
async function approved(extra = {}) {
  const { draft } = await new WriteGate().check({
    entry: "cli_import", op: "create", mode: "production",
    fields: { content: "Redis 포트는 6380으로 운영한다", topic: "ops", type: "fact", ...extra },
    build : (input) => ({ id: "f1", type: "fact", agent_id: "default", key_id: null, keywords: [], importance: 0.95, ...input })
  });
  return draft;
}

const insertStatement = () => statements.find(s => /INSERT INTO\s+\S*fragments/.test(s.sql));

describe("insertDetailed", () => {
  const writer = new FragmentWriter();

  it("새 행이면 created가 true다", async () => {
    const result = await writer.insertDetailed(await approved(), { client: fakeClient });
    assert.deepEqual(result, { id: "f1", created: true });
  });

  it("같은 본문이 이미 있으면 기존 id와 created=false를 돌려주고 쓰지 않는다", async () => {
    twin = "existing";
    const result = await writer.insertDetailed(await approved(), { client: fakeClient });
    assert.deepEqual(result, { id: "existing", created: false });
    assert.equal(insertStatement(), undefined);
  });

  it("충돌로 기존 행이 갱신되면 created=false다", async () => {
    insertRows = [{ id: "other", created: false }];
    const result = await writer.insertDetailed(await approved(), { client: fakeClient });
    assert.deepEqual(result, { id: "other", created: false });
  });

  it("insert는 id만 돌려준다", async () => {
    assert.equal(await writer.insert(await approved(), { client: fakeClient }), "f1");
  });

  it("관문을 거치지 않은 값은 거부한다", async () => {
    await assert.rejects(
      () => writer.insertDetailed({ id: "x", content: "본문", topic: "t", type: "fact" }, { client: fakeClient }),
      UngatedSemanticWriteError
    );
  });

  it("created_at이 있으면 INSERT 바인딩에 넣고 없으면 null을 넣어 서버 시각을 쓴다", async () => {
    await writer.insertDetailed(await approved({ created_at: "2026-01-02T03:04:05.000Z" }), { client: fakeClient });
    const withTime = insertStatement();
    assert.match(withTime.sql, /COALESCE\(\$29::timestamptz, NOW\(\)\)/);
    assert.equal(withTime.params[28], "2026-01-02T03:04:05.000Z");

    statements.length = 0;
    await writer.insertDetailed(await approved(), { client: fakeClient });
    assert.equal(insertStatement().params[28], null);
  });

  it("importance는 기본으로 유형 상한을 적용하고 exactImportance이면 그대로 기록한다", async () => {
    await writer.insertDetailed(await approved(), { client: fakeClient });
    const capped = insertStatement().params[5];
    assert.ok(capped < 0.95, `상한 적용: ${capped}`);

    statements.length = 0;
    await writer.insertDetailed(await approved(), { client: fakeClient, exactImportance: true });
    assert.equal(insertStatement().params[5], 0.95);
  });
});

describe("restoreVersion", () => {
  it("이력 행을 호출자의 client로 fragment_versions에 기록한다", async () => {
    await new FragmentWriter().restoreVersion({
      fragment_id: "f1", content: "옛 본문", topic: "ops", keywords: ["a"], type: "fact", importance: 0.4,
      amended_at: "2026-02-03T00:00:00.000Z", amended_by: "agent", agent_id: "default"
    }, { client: fakeClient });
    const stmt = statements[0];
    assert.match(stmt.sql, /INSERT INTO\s+\S*fragment_versions/);
    assert.equal(stmt.params[0], "f1");
    assert.equal(stmt.params[1], "옛 본문");
    assert.equal(stmt.params[6], "2026-02-03T00:00:00.000Z");
  });
});
