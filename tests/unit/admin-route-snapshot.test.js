/**
 * 관리 콘솔 엔드포인트 계약 스냅샷 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 콘솔이 호출하는 경로 집합을 소스에서 추출해 고정한다. 콘솔 자체는 리팩토링
 * 대상이 아니므로, 서버가 같은 URL을 계속 받아주기만 하면 UI는 그대로 동작한다.
 *
 * 경로 판정이 리터럴 비교, 정규식, endsWith, subPath 분기 네 가지 형태로
 * 흩어져 있어 각각을 정규화해 하나의 목록으로 만든다. 리팩토링이 경로를
 * 지우거나 이름을 바꾸면 이 목록이 달라지고 시험이 실패한다.
 *
 * 의도적인 표면 변경 시 SNAPSHOT_UPDATE=1 로 갱신하고 사유를 CHANGELOG에 남긴다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

const HERE          = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR     = path.resolve(HERE, "..", "..", "lib", "admin");
const SNAPSHOT_PATH = path.join(HERE, "..", "fixtures", "admin-routes.snapshot.json");

const ADMIN_BASE_LITERAL = "/v1/internal/model/nothing";

/**
 * 소스 조각 하나를 표준 경로 표기로 바꾼다.
 * 상수 보간과 정규식 캡처를 각각 기저 경로와 `:param`으로 환원한다.
 *
 * @param {string} raw
 * @returns {string}
 */
function canonicalize(raw) {
  return raw
    .replace(/\$\{ADMIN_BASE\}/g, ADMIN_BASE_LITERAL)
    .replace(/\$\{SESSION_PREFIX\}/g, `${ADMIN_BASE_LITERAL}/sessions`)
    .replace(/\$\{MEMORY_PREFIX\}/g, `${ADMIN_BASE_LITERAL}/memory`)
    /** 선택 그룹 `(\/history)?`는 경로가 둘임을 뜻하므로 표기를 남긴다. */
    .replace(/\((\\\/[a-z-]+)\)\?/gi, (_, g) => `${g.replace(/\\\//, "/")}?`)
    /** 남은 캡처 그룹은 전부 경로 변수다. 문자 클래스를 통째로 삼킨다. */
    .replace(/\((?:\[[^\]]*\]|[^)])*\)/g, ":param")
    .replace(/\\\//g, "/")
    .replace(/[\^$]/g, "");
}

/**
 * 관리자 소스 전체에서 경로 판정 지점을 추출한다.
 *
 * @returns {string[]} 정렬된 경로 목록
 */
export function extractAdminRoutes() {
  const found = new Set();

  /** 여러 줄에 걸친 match() 호출을 한 줄로 눌러 패턴 하나로 잡는다. */
  const flatten = (src) => src.replace(/\s+/g, " ");

  for (const file of readdirSync(ADMIN_DIR).filter(f => f.endsWith(".js"))) {
    const src  = readFileSync(path.join(ADMIN_DIR, file), "utf8");
    const flat = flatten(src);

    /** 형태 1: pathname 리터럴·템플릿 비교 */
    for (const m of flat.matchAll(/url\.pathname\s*(?:!==|===)\s*[`"]([^`"]+)[`"]/g)) {
      found.add(canonicalize(m[1]));
    }
    /** 형태 2: pathname === 상수 식별자 (SESSION_PREFIX 단독 비교) */
    for (const m of flat.matchAll(/url\.pathname\s*===\s*(SESSION_PREFIX|MEMORY_PREFIX|ADMIN_BASE)\b/g)) {
      found.add(canonicalize(`\${${m[1]}}`));
    }
    /** 형태 3: new RegExp 템플릿 매칭 */
    for (const m of flat.matchAll(/(url\.pathname|subPath)\.match\(\s*new RegExp\(\s*`([^`]+)`/g)) {
      found.add(prefixFor(m[1]) + canonicalize(m[2]));
    }
    /** 형태 4: 정규식 리터럴 매칭 */
    for (const m of flat.matchAll(/(url\.pathname|subPath)\.match\(\s*\/((?:\[[^\]]*\]|[^/\\]|\\.)+)\//g)) {
      found.add(prefixFor(m[1]) + canonicalize(m[2]));
    }
    /** 형태 4-2: 라우트 표의 exact() / regex() 판정기 */
    for (const m of flat.matchAll(/exact\(\s*`([^`]+)`\s*\)/g)) {
      found.add(canonicalize(m[1]));
    }
    for (const m of flat.matchAll(/regex\(\s*new RegExp\(\s*`([^`]+)`\s*\)\s*\)/g)) {
      found.add(canonicalize(m[1]));
    }

    /** 형태 5: endsWith 접미 판정 */
    for (const m of flat.matchAll(/url\.pathname\.endsWith\("([^"]+)"\)/g)) {
      found.add(`${ADMIN_BASE_LITERAL}${m[1]}`);
    }
    /** 형태 6: MEMORY_PREFIX 이하 subPath 리터럴 분기 */
    for (const m of flat.matchAll(/subPath\s*===\s*"([^"]+)"/g)) {
      found.add(`${ADMIN_BASE_LITERAL}/memory${m[1]}`);
    }
    for (const m of flat.matchAll(/subPath\.startsWith\("([^"]+)"\)/g)) {
      found.add(`${ADMIN_BASE_LITERAL}/memory${m[1].replace(/\/$/, "")}/:param`);
    }
  }

  return [...found]
    .map(p => p.replace(/\/+$/, ""))
    .filter(p => p.startsWith(ADMIN_BASE_LITERAL))
    .sort();
}

/** subPath 기준 매칭은 MEMORY_PREFIX가 이미 벗겨진 상태이므로 되붙인다. */
function prefixFor(receiver) {
  return receiver === "subPath" ? `${ADMIN_BASE_LITERAL}/memory` : "";
}

describe("관리 콘솔 경로 스냅샷", () => {
  const current = extractAdminRoutes();

  if (process.env.SNAPSHOT_UPDATE === "1") {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + "\n");
  }

  test("스냅샷 파일이 존재한다", () => {
    assert.ok(existsSync(SNAPSHOT_PATH), `스냅샷이 없다. SNAPSHOT_UPDATE=1 로 생성하라: ${SNAPSHOT_PATH}`);
  });

  test("경로 목록이 스냅샷과 일치한다", () => {
    assert.deepEqual(current, JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")));
  });

  test("모든 경로가 관리자 기저 경로 아래에 있다", () => {
    for (const p of current) {
      assert.ok(p.startsWith(ADMIN_BASE_LITERAL), `기저 경로 밖: ${p}`);
    }
  });

  test("콘솔 핵심 경로가 빠지지 않았다", () => {
    const required = ["/stats", "/activity", "/keys", "/groups", "/auth", "/memory/overview", "/memory/fragments", "/search"];
    for (const suffix of required) {
      assert.ok(current.includes(`${ADMIN_BASE_LITERAL}${suffix}`), `핵심 경로 누락: ${suffix}`);
    }
  });

  test("추출기가 빈 목록을 내면 실패로 본다", () => {
    assert.ok(current.length >= 20, `추출된 경로가 ${current.length}건뿐이다. 추출기가 깨졌을 수 있다`);
  });
});
