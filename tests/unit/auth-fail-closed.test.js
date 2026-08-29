/**
 * 인증 fail-closed 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-29
 *
 * 외부 감사에서 최우선 결함으로 지목된 지점이다. 인증 키가 비어 있을 때
 * 서버가 모든 도구와 master 범위를 무인증으로 열었다. 환경 변수 하나가 빠지는
 * 흔한 실수가 인터넷 노출 배포에서 전면 개방으로 이어졌다.
 *
 * 무인증 운용은 그 의사를 명시했을 때만 성립해야 한다. 정책 판정이 한곳에
 * 모여 있는지, 그리고 그 판정이 fail-closed인지 고정한다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readFileSync }   from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

import { buildAuthDecision } from "../../lib/auth.js";

const HERE   = path.dirname(fileURLToPath(import.meta.url));
const ROOT   = path.resolve(HERE, "..", "..");
const AUTH   = readFileSync(path.join(ROOT, "lib", "auth.js"), "utf8");
const SERVER = readFileSync(path.join(ROOT, "server.js"), "utf8");

describe("인증 정책 판정", () => {
  test("키 없음 + 비활성 미선언은 거부한다", () => {
    const d = buildAuthDecision("", false, null);
    assert.equal(d.valid, false);
    assert.equal(d.error, "access_key_required");
  });

  test("키 없음 + 비활성 명시는 허용한다", () => {
    const d = buildAuthDecision("", true, null);
    assert.equal(d.valid, true);
    assert.equal(d.authDisabled, true);
    assert.equal(d.keyId, null);
  });

  test("키 일치는 허용하고 불일치는 거부한다", () => {
    assert.equal(buildAuthDecision("k1", false, "k1").valid, true);
    assert.equal(buildAuthDecision("k1", false, "wrong").valid, false);
    assert.equal(buildAuthDecision("k1", false, null).valid, false);
  });
});

describe("HTTP 인증 경로", () => {
  test("validateAuthentication이 키 부재를 무조건 통과시키지 않는다", () => {
    /** 종전 결함: if (!ACCESS_KEY) return { valid: true, ... } */
    assert.doesNotMatch(
      AUTH,
      /if \(!ACCESS_KEY\) \{\s*return \{ valid: true, keyId: null, groupKeyIds: null \};/,
      "키 부재를 무조건 통과로 처리하는 분기가 남아 있다"
    );
  });

  test("키 부재 처리를 단일 정책 함수에 위임한다", () => {
    const fn = AUTH.slice(AUTH.indexOf("export async function validateAuthentication"));
    const head = fn.slice(0, fn.indexOf("/** 1."));
    assert.match(head, /buildAuthDecision\(ACCESS_KEY, AUTH_DISABLED/);
  });

  test("관리 경로도 키 부재를 거부한다", () => {
    const fn = AUTH.slice(AUTH.indexOf("export function validateMasterKey"));
    assert.match(fn, /if \(!ACCESS_KEY\) return false;/);
  });
});

describe("기동 게이트", () => {
  test("키 없고 비활성 미선언이면 기동을 중단한다", () => {
    assert.match(SERVER, /if \(!ACCESS_KEY && !AUTH_DISABLED\) \{/);
    const block = SERVER.slice(SERVER.indexOf("if (!ACCESS_KEY && !AUTH_DISABLED) {"));
    assert.match(block.slice(0, 600), /process\.exit\(/);
  });

  test("기동 게이트가 listen보다 먼저 있다", () => {
    const gate   = SERVER.indexOf("if (!ACCESS_KEY && !AUTH_DISABLED) {");
    const listen = SERVER.indexOf("server.listen(PORT");
    assert.ok(gate >= 0 && listen >= 0);
    assert.ok(gate < listen, "게이트가 listen 뒤에 있으면 포트가 먼저 열린다");
  });
});
