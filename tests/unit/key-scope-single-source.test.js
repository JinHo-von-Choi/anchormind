/**
 * 키 격리 표현 단일화 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 격리 절을 동적으로 조립하는 지점은 전부 keyScope 모듈을 거쳐야 한다. 새 질의를
 * 쓸 때 어느 표현이 맞는지 다시 판단하는 상황을 막는 것이 목적이다.
 *
 * 고정 위치 파라미터로 격리 조건을 박아 넣은 질의는 예외로 둔다. 조건이 무조건
 * 붙고 파라미터 번호가 질의마다 정해져 있어 판단의 여지가 없기 때문이다. 아래
 * 허용 목록에 파일별 개수로 적어 두었고, 개수가 늘면 시험이 실패한다.
 *
 * 격리가 아닌 질의도 예외다. 할당량 회계, 그룹 멤버십 조회, 멱등키 범위 판정은
 * 대상이 다른 별개 연산이므로 격리 생성기를 쓰면 오히려 의미가 틀어진다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB  = path.resolve(HERE, "..", "..", "lib");

/**
 * 격리 조건을 직접 쓴 지점이 남아 있어도 되는 파일과 그 개수.
 *
 * 값을 올리려면 그 지점이 왜 생성기를 쓸 수 없는지 판단이 선행돼야 한다.
 * 판단 없이 숫자만 올리면 이 가드는 의미를 잃는다.
 */
const ALLOWED = {
  /** 고정 위치 파라미터로 격리를 박은 질의와 격리가 아닌 회계·멤버십 질의 */
  "admin/ApiKeyStore.js": 2,
  "admin/admin-keys.js": 1,
  "memory/CaseEventStore.js": 2,
  "memory/consolidate/MemoryConsolidator.js": 2,
  "memory/link/ContradictionDetector.js": 2,
  "memory/processors/EpisodeContinuityService.js": 1,
  "memory/read/FragmentReader.js": 1,
  "memory/read/GraphNeighborSearch.js": 1,
  "memory/read/RecallSuggestionEngine.js": 2,
  "memory/read/quotaQueries.js": 1,
  "memory/signals/SearchParamAdaptor.js": 1,
  "memory/write/FragmentWriter.js": 4,
  "symbolic/ClaimStore.js": 4,
  "tools/resources.js": 2,
};

/** 격리 조건을 직접 쓴 것으로 보이는 줄인지 판정한다. */
function isRawScopeLine(line) {
  if (!/key_id/.test(line)) return false;
  if (/keyScope(Clause|Scalar|Group|Nullable|Condition)/.test(line)) return false;
  if (!/key_id\s*(=\s*ANY\(|IS NOT DISTINCT FROM|=\s*\$)/.test(line)) return false;
  if (/DO UPDATE|ON CONFLICT/.test(line)) return false;
  if (/^\s*(\*|\/\*|\/\/)/.test(line)) return false;
  if (/logWarn|logInfo|logError/.test(line)) return false;
  return true;
}

/** lib 아래 모든 js 파일을 수집한다. */
function collect(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) collect(p, acc);
    else if (name.endsWith(".js") && p !== path.join(LIB, "memory", "keyScope.js")) acc.push(p);
  }
  return acc;
}

/** 파일별 잔여 지점 수를 센다. */
export function countRawScopeSites() {
  const counts = {};
  for (const file of collect(LIB)) {
    const rel = path.relative(LIB, file);
    const n   = readFileSync(file, "utf8").split("\n").filter(isRawScopeLine).length;
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

describe("키 격리 표현 단일화", () => {
  const counts = countRawScopeSites();

  test("허용 목록에 없는 파일에는 직접 작성한 격리 조건이 없다", () => {
    const unexpected = Object.keys(counts).filter(f => !(f in ALLOWED));
    assert.deepEqual(unexpected, [], `생성기를 쓰지 않은 파일: ${unexpected.join(", ")}`);
  });

  test("허용 파일의 잔여 지점이 기록된 수를 넘지 않는다", () => {
    for (const [file, n] of Object.entries(counts)) {
      assert.ok(n <= ALLOWED[file], `${file}: ${n}곳 (허용 ${ALLOWED[file]}곳). 새 지점은 생성기를 써야 한다`);
    }
  });

  test("허용 목록에 죽은 항목이 없다", () => {
    const dead = Object.keys(ALLOWED).filter(f => !(f in counts));
    assert.deepEqual(dead, [], `이미 정리된 항목은 목록에서 지운다: ${dead.join(", ")}`);
  });

  test("판정기가 생성기 호출을 잔여 지점으로 세지 않는다", () => {
    assert.equal(isRawScopeLine('const c = keyScopeScalar(params, "key_id", keyId);'), false);
    assert.equal(isRawScopeLine("      query += ` AND key_id = $${params.length}`;"), true);
  });
});
