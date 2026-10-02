/**
 * CI 워크플로 배치 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 의존성 감사는 시험 워크플로 밖의 별도 워크플로에서 돌고, 예약 실행을 가진다.
 * YAML 전체를 고정하지 않고 단계 이름과 트리거 존재만 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const ROOT      = new URL("../../", import.meta.url);
const TEST_YML  = readFileSync(new URL(".github/workflows/test.yml", ROOT), "utf8");
const AUDIT_URL = new URL(".github/workflows/audit.yml", ROOT);

describe("CI 워크플로 배치", () => {
  it("시험 워크플로에는 감사 단계가 없다", () => {
    assert.doesNotMatch(TEST_YML, /npm run audit:ci/);
    assert.doesNotMatch(TEST_YML, /npm audit /);
  });

  it("시험 워크플로는 단위 시험과 통합 시험 단계를 가진다", () => {
    assert.match(TEST_YML, /name: All unit tests/);
    assert.match(TEST_YML, /name: Integration tests/);
  });

  it("감사 워크플로는 push, pull_request, schedule 트리거와 audit:ci 단계를 가진다", () => {
    assert.ok(existsSync(AUDIT_URL), ".github/workflows/audit.yml 이 필요하다");
    const yml = readFileSync(AUDIT_URL, "utf8");
    assert.match(yml, /^\s+push:/m);
    assert.match(yml, /^\s+pull_request:/m);
    assert.match(yml, /^\s+schedule:\s*\n\s+- cron: "[^"]+"/m);
    assert.match(yml, /run: npm run audit:ci/);
    assert.match(yml, /^permissions:\s*\n\s+contents: read/m);
  });

  it("시험 워크플로는 실제 DB 동시성 작업에서 npm run test:db 를 실행한다", () => {
    assert.match(TEST_YML, /^\s{2}db-concurrency:\s*$/m);
    assert.match(TEST_YML, /run: npm run test:db/);
    assert.match(TEST_YML, /image: pgvector\/pgvector:pg15[\s\S]*run: npm run test:db/);
  });
});
