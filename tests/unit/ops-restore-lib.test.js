/**
 * 복구 훈련 순수 함수 시험
 *
 * 복구 대상 서버 검사, 행 수 대조, 체크섬 파일 해석을 DB 없이 확인한다. 대상 서버
 * 검사는 DB 동시성 시험의 실행 허용 조건과 같은 입력에서 같은 판정을 내려야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  RestoreRefusedError, RestoreVerifyError, REQUIRED_TABLES, resolveRestoreServer, assertRestoreTarget,
  assertRestoreDatabaseName, newRestoreDatabaseName, compareDrillCounts, parseDrillCounts, parseChecksumFile, sanitizePgErrors
} from "../../scripts/ops/restore-lib.mjs";
import {
  LaneRefusalError, resolveLaneServer, assertLaneServer, assertLaneDatabaseName, newLaneDatabaseName
} from "../db-concurrency/_guard.js";

const counts = (overrides = {}) => ({
  tables: {
    fragments: 100, fragment_links: 250, fragment_versions: 40, api_keys: 3, case_events: 0, ...(overrides.tables || {})
  },
  schemaMigrationsMax: "migration-049-align-synthetic-query-embedding.sql",
  hnsw: { total: 2, valid: 2 },
  ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "tables"))
});

describe("복구 대상 서버 검사", () => {
  const envs = [
    {},
    { POSTGRES_HOST: "127.0.0.1" },
    { POSTGRES_HOST: "::1" },
    { POSTGRES_HOST: "db.example.com" },
    { POSTGRES_HOST: "203.0.113.10" },
    { POSTGRES_PORT: "5432" },
    { POSTGRES_PORT: "57332" },
    { POSTGRES_USER: "postgres" },
    { POSTGRES_PASSWORD: "other" },
    { POSTGRES_HOST: "db.example.com", POSTGRES_PORT: "5432", DB_LANE_SERVER_ALLOW: "db.example.com:5432" },
    { POSTGRES_HOST: "db.example.com", POSTGRES_PORT: "5432", DB_LANE_SERVER_ALLOW: "other.example.com:5432" },
    { POSTGRES_HOST: "db.example.com", POSTGRES_PORT: "5432", DB_LANE_SERVER_ALLOW: "db.example.com:5432", POSTGRES_USER: "admin" }
  ];

  const verdict = (assertFn, resolveFn, env) => {
    try {
      assertFn(resolveFn(env), env);
      return "allow";
    } catch (err) {
      return err.constructor.name;
    }
  };

  it("값이 없으면 시험 컨테이너가 기본이고 허용된다", () => {
    assert.deepEqual(resolveRestoreServer({}), resolveLaneServer({}));
    assert.doesNotThrow(() => assertRestoreTarget(resolveRestoreServer({}), {}));
  });

  for (const [i, env] of envs.entries()) {
    it(`입력 ${i + 1} ${JSON.stringify({ ...env, POSTGRES_PASSWORD: env.POSTGRES_PASSWORD ? "<set>" : undefined })} 은 시험 서버 검사와 같이 판정한다`, () => {
      const lane    = verdict(assertLaneServer, resolveLaneServer, env);
      const restore = verdict(assertRestoreTarget, resolveRestoreServer, env);
      assert.equal(restore === "allow", lane === "allow");
      if (lane !== "allow") {
        assert.equal(lane, LaneRefusalError.name);
        assert.equal(restore, RestoreRefusedError.name);
      }
    });
  }

  it("운영 서버 포트 57332 와 원격 호스트는 거부 대상을 담아 거부한다", () => {
    assert.throws(
      () => assertRestoreTarget(resolveRestoreServer({ POSTGRES_PORT: "57332" }), {}),
      (err) => err instanceof RestoreRefusedError && err.message.includes("57332")
    );
    assert.throws(
      () => assertRestoreTarget(resolveRestoreServer({ POSTGRES_HOST: "db.example.com" }), {}),
      (err) => err instanceof RestoreRefusedError && err.message.includes("db.example.com")
    );
  });

  it("거부 메시지에 비밀번호를 담지 않는다", () => {
    const env = { POSTGRES_PASSWORD: "super-secret-value" };
    assert.throws(
      () => assertRestoreTarget(resolveRestoreServer(env), env),
      (err) => !err.message.includes("super-secret-value")
    );
  });
});

describe("복구 대상 데이터베이스 이름", () => {
  it("시험 서버 검사와 같은 형식만 허용한다", () => {
    for (const name of ["dbl_1_abcdef12", "dbl_4242_00ff00ff", "memento", "postgres", "memento_test", "dbl_1_ABCDEF12", "dbl_x_abcdef12", "dbl_1_abc", 'dbl_1_abcdef12"; DROP DATABASE x; --']) {
      let lane = "allow";
      let rest = "allow";
      try { assertLaneDatabaseName(name); } catch { lane = "refuse"; }
      try { assertRestoreDatabaseName(name); } catch (err) { rest = err instanceof RestoreRefusedError ? "refuse" : "other"; }
      assert.equal(rest, lane, name);
    }
  });

  it("새 이름은 pid와 접미사를 받아 시험 서버의 이름과 같은 형식을 만든다", () => {
    assert.equal(newRestoreDatabaseName(77, "0a1b2c3d"), "dbl_77_0a1b2c3d");
    assert.equal(newRestoreDatabaseName(77, "0a1b2c3d"), newLaneDatabaseName(77, "0a1b2c3d"));
    assert.match(newRestoreDatabaseName(), /^dbl_\d+_[0-9a-f]{8}$/);
  });
});

describe("행 수 대조", () => {
  it("모든 값이 같으면 일치로 판정한다", () => {
    const report = compareDrillCounts(counts(), counts());
    assert.equal(report.ok, true);
    assert.equal(report.tables.length, 5);
    assert.ok(report.tables.every(t => t.equal));
    assert.equal(report.schemaMigrations.equal, true);
    assert.equal(report.hnsw.equal, true);
    assert.deepEqual(report.missingRequired, []);
  });

  it("표 하나의 행 수가 다르면 그 표만 불일치로 표시하고 전체를 실패로 판정한다", () => {
    const report = compareDrillCounts(counts(), counts({ tables: { fragment_links: 249 } }));
    assert.equal(report.ok, false);
    const bad = report.tables.filter(t => !t.equal);
    assert.deepEqual(bad.map(t => t.name), ["fragment_links"]);
    assert.equal(bad[0].source, 250);
    assert.equal(bad[0].restored, 249);
  });

  it("복구본에 없는 표는 불일치다", () => {
    const restored = counts();
    delete restored.tables.case_events;
    const report = compareDrillCounts(counts(), restored);
    assert.equal(report.ok, false);
    const row = report.tables.find(t => t.name === "case_events");
    assert.equal(row.equal, false);
    assert.equal(row.restored, null);
  });

  it("복구본에만 있는 표도 불일치다", () => {
    const report = compareDrillCounts(counts(), counts({ tables: { extra_table: 1 } }));
    assert.equal(report.ok, false);
    assert.equal(report.tables.find(t => t.name === "extra_table").source, null);
  });

  it("원본 목록에 필수 표가 없으면 목록에 올리고 실패로 판정한다", () => {
    const source   = counts();
    const restored = counts();
    delete source.tables.api_keys;
    delete restored.tables.api_keys;
    const report = compareDrillCounts(source, restored);
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingRequired, ["api_keys"]);
  });

  it("필수 표는 파편, 링크, 버전, API 키다", () => {
    assert.deepEqual([...REQUIRED_TABLES].sort(), ["api_keys", "fragment_links", "fragment_versions", "fragments"]);
  });

  it("schema_migrations 최댓값이 다르면 실패로 판정한다", () => {
    const report = compareDrillCounts(counts(), counts({ schemaMigrationsMax: "migration-048-case-events-case-closed.sql" }));
    assert.equal(report.ok, false);
    assert.equal(report.schemaMigrations.equal, false);
    assert.equal(report.schemaMigrations.restored, "migration-048-case-events-case-closed.sql");
  });

  it("HNSW 색인 수가 다르거나 무효 색인이 있으면 실패로 판정한다", () => {
    assert.equal(compareDrillCounts(counts(), counts({ hnsw: { total: 1, valid: 1 } })).ok, false);
    const invalid = compareDrillCounts(counts(), counts({ hnsw: { total: 2, valid: 1 } }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.hnsw.allValid, false);
  });

  it("원본에 HNSW 색인이 하나도 없으면 복구본도 없어야 일치다", () => {
    const none = { hnsw: { total: 0, valid: 0 } };
    assert.equal(compareDrillCounts(counts(none), counts(none)).ok, true);
  });

  it("보고에는 이름과 숫자만 담긴다", () => {
    const report = compareDrillCounts(counts(), counts());
    const keys   = new Set(report.tables.flatMap(t => Object.keys(t)));
    assert.deepEqual([...keys].sort(), ["equal", "name", "restored", "source"]);
  });
});

describe("행 수 목록 해석", () => {
  it("psql 출력 한 줄을 해석한다", () => {
    const parsed = parseDrillCounts(JSON.stringify(counts()) + "\n");
    assert.equal(parsed.tables.fragments, 100);
    assert.equal(parsed.schemaMigrationsMax, "migration-049-align-synthetic-query-embedding.sql");
  });

  it("매니페스트 형식(counts 키 아래)도 해석한다", () => {
    const parsed = parseDrillCounts(JSON.stringify({ version: 1, createdAt: "2026-10-03T00:00:00Z", counts: counts() }));
    assert.equal(parsed.tables.api_keys, 3);
  });

  for (const [label, text] of [
    ["빈 문자열", ""],
    ["JSON이 아님", "not json"],
    ["표 목록 없음", JSON.stringify({ schemaMigrationsMax: "x", hnsw: { total: 0, valid: 0 } })],
    ["행 수가 음수", JSON.stringify(counts({ tables: { fragments: -1 } }))],
    ["행 수가 숫자가 아님", JSON.stringify(counts({ tables: { fragments: "100" } }))],
    ["hnsw 없음", JSON.stringify({ tables: { fragments: 1 }, schemaMigrationsMax: "x" })]
  ]) {
    it(`형식이 틀리면(${label}) 거부한다`, () => {
      assert.throws(() => parseDrillCounts(text), RestoreVerifyError);
    });
  }
});

describe("체크섬 파일 해석", () => {
  const hash = "a".repeat(64);

  it("sha256sum 형식에서 대상 파일 이름의 해시를 돌려준다", () => {
    assert.equal(parseChecksumFile(`${hash}  memento-20261003T031500Z.dump\n`, "memento-20261003T031500Z.dump"), hash);
  });

  it("다른 파일 이름이나 형식 오류는 거부한다", () => {
    assert.throws(() => parseChecksumFile(`${hash}  other.dump\n`, "memento-20261003T031500Z.dump"), RestoreVerifyError);
    assert.throws(() => parseChecksumFile("zz  memento.dump\n", "memento.dump"), RestoreVerifyError);
    assert.throws(() => parseChecksumFile("", "memento.dump"), RestoreVerifyError);
  });
});

describe("pg_restore 오류 정리", () => {
  it("서버 오류 문구와 행 내용이 실릴 수 있는 줄을 모두 뺀다", () => {
    const stderr = [
      'pg_restore: error: COPY failed for table "fragments": ERROR:  invalid input syntax for type real: "secret memory text"',
      'pg_restore: error: could not execute query: ERROR:  duplicate key value violates unique constraint',
      "CONTEXT:  COPY fragments, line 3: \"secret memory text\"",
      "DETAIL:  Key (id)=(abc) already exists.",
      "Command was: COPY agent_memory.fragments (id, content) FROM stdin;",
      "pg_restore: warning: errors ignored on restore: 2",
      ""
    ].join("\n");
    const lines = sanitizePgErrors(stderr);
    assert.deepEqual(lines, [
      'pg_restore: error: COPY failed for table "fragments" (서버 오류 문구 생략)',
      "pg_restore: error: could not execute query (서버 오류 문구 생략)",
      "pg_restore: warning: errors ignored on restore: 2"
    ]);
    const joined = lines.join("\n");
    assert.ok(!joined.includes("secret memory text"));
    assert.ok(!joined.includes("abc"));
  });

  it("pg_restore 줄이 아닌 줄은 버린다", () => {
    assert.deepEqual(sanitizePgErrors("Command failed: pg_restore --x\nrandom text with value=secret"), []);
  });

  it("긴 줄은 200자로 자른다", () => {
    const [line] = sanitizePgErrors(`pg_restore: error: ${"x".repeat(500)}`);
    assert.ok(line.length <= 203);
  });
});
