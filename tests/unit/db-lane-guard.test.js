/**
 * DB 동시성 시험 실행 허용 조건 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * DB 동시성 시험은 데이터베이스를 만들고 지운다. 로컬 시험 서버가 아니거나 시험
 * 데이터베이스 형식이 아닌 이름이면 연결을 열기 전에 거부하는지 DB 없이 확인한다.
 */

import { describe, it }  from "node:test";
import assert            from "node:assert/strict";
import pg                from "pg";

import {
  LaneRefusalError, resolveLaneServer, assertLaneServer, assertLaneDatabaseName,
  newLaneDatabaseName, TEST_PORT, TEST_USER, TEST_PASSWORD
} from "../db-concurrency/_guard.js";
import { prepareLaneDatabase } from "../db-concurrency/_harness.js";

const defaults = () => resolveLaneServer({});

describe("DB 동시성 시험 서버 검사", () => {
  it("값이 없으면 로컬 시험 컨테이너 값이 기본이고 허용된다", () => {
    const server = defaults();
    assert.deepEqual(server, { host: "localhost", port: TEST_PORT, user: TEST_USER, password: TEST_PASSWORD });
    assert.doesNotThrow(() => assertLaneServer(server, {}));
  });

  for (const host of ["localhost", "127.0.0.1", "::1"]) {
    it(`로컬 호스트 ${host} 는 허용된다`, () => {
      assert.doesNotThrow(() => assertLaneServer({ ...defaults(), host }, {}));
    });
  }

  for (const host of ["db.example.com", "192.168.0.10", "10.0.0.5", "localhost.example.com", "127.0.0.2"]) {
    it(`원격 호스트 ${host} 는 호스트 이름을 담아 거부된다`, () => {
      assert.throws(
        () => assertLaneServer({ ...defaults(), host }, {}),
        (err) => err instanceof LaneRefusalError && err.message.includes(`"${host}"`)
      );
    });
  }

  it("시험 포트가 아니면 거부된다", () => {
    assert.throws(
      () => assertLaneServer({ ...defaults(), port: 5432 }, {}),
      (err) => err instanceof LaneRefusalError && err.message.includes("5432")
    );
  });

  it("DB_LANE_SERVER_ALLOW 가 호스트와 포트에 정확히 일치할 때만 다른 포트를 연다", () => {
    const server = { ...defaults(), port: 5432 };
    assert.doesNotThrow(() => assertLaneServer(server, { DB_LANE_SERVER_ALLOW: "localhost:5432" }));
    assert.throws(() => assertLaneServer(server, { DB_LANE_SERVER_ALLOW: "localhost:5433" }), LaneRefusalError);
    assert.throws(() => assertLaneServer(server, { DB_LANE_SERVER_ALLOW: "127.0.0.1:5432" }), LaneRefusalError);
    assert.throws(() => assertLaneServer(server, { DB_LANE_SERVER_ALLOW: "" }), LaneRefusalError);
  });

  it("DB_LANE_SERVER_ALLOW 로 연 일회용 원격 서버도 사용자와 비밀번호 조건은 그대로다", () => {
    const remote = { ...defaults(), host: "db.example.com" };
    assert.doesNotThrow(() => assertLaneServer(remote, { DB_LANE_SERVER_ALLOW: "db.example.com:35433" }));
    assert.throws(
      () => assertLaneServer({ ...remote, user: "postgres" }, { DB_LANE_SERVER_ALLOW: "db.example.com:35433" }),
      LaneRefusalError
    );
  });

  it("시험 컨테이너 사용자가 아니면 거부된다", () => {
    assert.throws(
      () => assertLaneServer({ ...defaults(), user: "postgres" }, {}),
      (err) => err instanceof LaneRefusalError && err.message.includes('"postgres"')
    );
  });

  it("시험 컨테이너 비밀번호가 아니면 거부되고 메시지에 비밀번호가 없다", () => {
    const secret = "s3cret-value-xyz";
    assert.throws(
      () => assertLaneServer({ ...defaults(), password: secret }, {}),
      (err) => err instanceof LaneRefusalError && !err.message.includes(secret)
    );
  });

  it("접속 값은 POSTGRES_* 한 곳에서 읽는다", () => {
    const server = resolveLaneServer({
      POSTGRES_HOST: "127.0.0.1", POSTGRES_PORT: "35433", POSTGRES_USER: "memento", POSTGRES_PASSWORD: "memento_test"
    });
    assert.deepEqual(server, { host: "127.0.0.1", port: 35433, user: "memento", password: "memento_test" });
  });
});

describe("DB 동시성 시험 데이터베이스 이름 검사", () => {
  it("새 이름은 dbl_<pid>_<hex8> 형식이다", () => {
    assert.match(newLaneDatabaseName(), /^dbl_\d+_[0-9a-f]{8}$/);
    assert.equal(newLaneDatabaseName(42, "0123abcd"), "dbl_42_0123abcd");
  });

  for (const name of ["memento", "memento_test", "postgres", "template1", "dbl_", "dbl_1_xyz", "dbl_12_0123abcd; DROP", 'dbl_1_0123abcd"', ""]) {
    it(`형식이 아닌 이름 "${name}" 은 거부된다`, () => {
      assert.throws(
        () => assertLaneDatabaseName(name),
        (err) => err instanceof LaneRefusalError && err.message.includes(`"${name}"`)
      );
    });
  }
});

describe("DB 동시성 시험 준비 단계의 거부", () => {
  it("원격 호스트면 연결을 열기 전에 거부하고 접속 환경을 바꾸지 않는다", async () => {
    const connect   = pg.Client.prototype.connect;
    const before    = { db: process.env.POSTGRES_DB, host: process.env.POSTGRES_HOST, url: process.env.DATABASE_URL };
    let   connected = 0;
    pg.Client.prototype.connect = function counted(...args) {
      connected++;
      return connect.apply(this, args);
    };
    try {
      await assert.rejects(
        prepareLaneDatabase({ POSTGRES_HOST: "db.example.com", POSTGRES_USER: "memento", POSTGRES_PASSWORD: "memento_test" }),
        LaneRefusalError
      );
      await assert.rejects(
        prepareLaneDatabase({ POSTGRES_PORT: "5432" }),
        LaneRefusalError
      );
      await assert.rejects(
        prepareLaneDatabase({ POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "x" }),
        LaneRefusalError
      );
    } finally {
      pg.Client.prototype.connect = connect;
    }
    assert.equal(connected, 0);
    assert.deepEqual(
      { db: process.env.POSTGRES_DB, host: process.env.POSTGRES_HOST, url: process.env.DATABASE_URL },
      before
    );
  });
});
