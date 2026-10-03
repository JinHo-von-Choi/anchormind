/**
 * grant-anchor-permission.js 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 인자 처리, 대상 키 분류, dry-run 출력 구조, --apply의 트랜잭션 흐름을 연결 대역으로 확인하고,
 * 스크립트가 환경 파일을 읽는 모듈을 가져오지 않는지 소스로 본다. DB는 쓰지 않는다.
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";
import { fileURLToPath } from "node:url";

import {
  WINDOW_DAYS,
  CANDIDATES_SQL,
  GRANT_SQL,
  parseGrantArgs,
  classifyKey,
  main
} from "../../scripts/grant-anchor-permission.js";

const ROOT     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const URL_ARGS = ["--url", "postgresql://u:secret-pw@db.example:5432/memento"];

const ROWS = [
  { id: "k-active",   name: "agent-a", status: "active",   permissions: ["read", "write"],           anchors_created: 120 },
  { id: "k-granted",  name: "agent-b", status: "active",   permissions: ["read", "write", "anchor"], anchors_created: 40 },
  { id: "k-admin",    name: "agent-c", status: "active",   permissions: ["admin"],                   anchors_created: 3 },
  { id: "k-inactive", name: "agent-d", status: "inactive", permissions: ["read", "write"],           anchors_created: 2 },
  { id: "k-readonly", name: "agent-e", status: "active",   permissions: ["read"],                    anchors_created: 1 }
];

/** 연결 대역. failOn이 문장 앞부분과 같으면 그 문장에서 실패한다. */
function fakeClient({ rows = ROWS, failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    ended: false,
    async query(sql, params) {
      calls.push({ sql, params });
      if (failOn && sql.startsWith(failOn)) throw new Error("write failed");
      if (sql === CANDIDATES_SQL) return { rows };
      if (sql === GRANT_SQL) {
        return { rows: rows.filter(r => params[0].includes(r.id)).map(r => ({ id: r.id, name: r.name, permissions: [...r.permissions, "anchor"] })) };
      }
      return { rows: [] };
    },
    async end() { this.ended = true; }
  };
}

async function run(argv, { env = {}, client = fakeClient() } = {}) {
  const out = [];
  const err = [];
  let   connected = null;
  const code = await main(argv, env, {
    connect: async (config) => { connected = config; return client; },
    out    : line => out.push(line),
    err    : line => err.push(line)
  });
  return { code, out, err, client, connected };
}

describe("인자와 분류", () => {
  it("기본은 dry-run이고 --apply만 쓰기를 켠다", () => {
    assert.equal(parseGrantArgs([]).apply, false);
    assert.equal(parseGrantArgs(["--apply"]).apply, true);
    assert.equal(parseGrantArgs(["--url", "postgres://h/db"]).url, "postgres://h/db");
  });

  it("알 수 없는 인자는 거부한다", () => {
    assert.throws(() => parseGrantArgs(["--days", "30"]));
    assert.throws(() => parseGrantArgs(["positional"]));
    assert.throws(() => parseGrantArgs(["--url"]));
  });

  it("최근 90일 앵커를 만든 키를 고르는 질의다", () => {
    assert.equal(WINDOW_DAYS, 90);
    assert.match(CANDIDATES_SQL, /is_anchor = TRUE/);
    assert.match(CANDIDATES_SQL, /created_at > now\(\) - make_interval\(days => \$1\)/);
    assert.match(CANDIDATES_SQL, /agent_memory\.api_keys/);
  });

  it("부여 문장은 활성이고 anchor가 없는 대상 키에만 anchor를 덧붙인다", () => {
    assert.match(GRANT_SQL, /array_append\(permissions, 'anchor'\)/);
    assert.match(GRANT_SQL, /id = ANY\(\$1::text\[\]\)/);
    assert.match(GRANT_SQL, /status = 'active'/);
    assert.match(GRANT_SQL, /'write' = ANY\(permissions\)/);
    assert.match(GRANT_SQL, /NOT \('anchor' = ANY\(permissions\)\)/);
  });

  it("키를 부여, 이미 보유, 비활성, write 없음으로 분류한다", () => {
    assert.equal(classifyKey(ROWS[0]), "grant");
    assert.equal(classifyKey(ROWS[1]), "skip_has_permission");
    assert.equal(classifyKey(ROWS[2]), "skip_has_permission");
    assert.equal(classifyKey(ROWS[3]), "skip_inactive");
    assert.equal(classifyKey(ROWS[4]), "skip_no_write");
  });
});

describe("dry-run 출력 구조", () => {
  it("대상 키 목록과 집계를 JSON으로 출력하고 쓰지 않는다", async () => {
    const { code, out, client, connected } = await run(URL_ARGS);
    assert.equal(code, 0);
    assert.equal(connected.host, "db.example");

    const report = JSON.parse(out.join("\n"));
    assert.deepEqual(Object.keys(report).sort(), ["granted", "keys", "mode", "summary", "target", "windowDays"]);
    assert.equal(report.mode, "dry-run");
    assert.equal(report.windowDays, 90);
    assert.ok(!report.target.includes("secret-pw"), "대상 표시에 비밀번호가 있다");
    assert.deepEqual(report.granted, []);
    for (const key of report.keys) {
      assert.deepEqual(Object.keys(key).sort(), ["action", "anchorsCreated", "id", "name", "permissions", "status"]);
    }
    assert.deepEqual(report.keys.map(k => [k.id, k.action]), [
      ["k-active", "grant"], ["k-granted", "skip_has_permission"], ["k-admin", "skip_has_permission"],
      ["k-inactive", "skip_inactive"], ["k-readonly", "skip_no_write"]
    ]);
    assert.deepEqual(report.summary, { candidates: 5, toGrant: 1, granted: 0 });

    assert.deepEqual(client.calls.map(c => c.sql), [CANDIDATES_SQL]);
    assert.deepEqual(client.calls[0].params, [90]);
    assert.equal(client.ended, true);
  });
});

describe("--apply", () => {
  it("한 트랜잭션에서 부여 대상 키에만 anchor를 덧붙이고 결과를 출력한다", async () => {
    const { code, out, client } = await run(["--apply", ...URL_ARGS]);
    assert.equal(code, 0);
    assert.deepEqual(client.calls.map(c => c.sql), ["BEGIN", CANDIDATES_SQL, GRANT_SQL, "COMMIT"]);
    assert.deepEqual(client.calls[2].params, [["k-active"]]);

    const report = JSON.parse(out.join("\n"));
    assert.equal(report.mode, "apply");
    assert.deepEqual(report.granted, ["k-active"]);
    assert.deepEqual(report.summary, { candidates: 5, toGrant: 1, granted: 1 });
  });

  it("부여할 키가 없으면 갱신하지 않는다", async () => {
    const { code, client } = await run(["--apply", ...URL_ARGS], { client: fakeClient({ rows: [ROWS[1]] }) });
    assert.equal(code, 0);
    assert.deepEqual(client.calls.map(c => c.sql), ["BEGIN", CANDIDATES_SQL, "COMMIT"]);
  });

  it("갱신이 실패하면 되돌리고 종료 코드 1이다", async () => {
    const client = fakeClient({ failOn: GRANT_SQL.slice(0, 20) });
    const { code, err } = await run(["--apply", ...URL_ARGS], { client });
    assert.equal(code, 1);
    assert.deepEqual(client.calls.map(c => c.sql).slice(-1), ["ROLLBACK"]);
    assert.ok(err.some(line => /실패/.test(line)));
    assert.equal(client.ended, true);
  });
});

describe("접속 대상", () => {
  it("대상이 명시되지 않으면 연결하지 않고 종료 코드 2다", async () => {
    const { code, connected, err } = await run([]);
    assert.equal(code, 2);
    assert.equal(connected, null);
    assert.ok(err.some(line => /거부/.test(line)));
  });

  it("PG 환경변수로 대상을 정할 수 있다", async () => {
    const { code, connected } = await run([], { env: { PGHOST: "db.local", PGDATABASE: "memento", PGUSER: "ops" } });
    assert.equal(code, 0);
    assert.equal(connected.database, "memento");
  });

  it("환경 파일을 읽는 모듈(dotenv, lib/config.js)을 가져오지 않는다", () => {
    const source = readFileSync(path.join(ROOT, "scripts", "grant-anchor-permission.js"), "utf8");
    const specifiers = [...source.matchAll(/(?:import|from)\s*\(?\s*["']([^"']+)["']/g)].map(m => m[1]);
    assert.ok(specifiers.length > 0);
    for (const spec of specifiers) {
      assert.ok(!/dotenv|lib\/config\.js|tools\/db\.js/.test(spec), spec);
    }
  });
});
