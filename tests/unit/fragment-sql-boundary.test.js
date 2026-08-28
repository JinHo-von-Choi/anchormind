/**
 * 파편 표 직접 접근 경계 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * `fragments` 표를 직접 다루는 SQL이 코드 전반에 흩어져 있다. 컬럼 하나를
 * 바꾸려면 어디를 봐야 하는지 알 수 없고, 새 질의를 쓸 때 기존 질의의 규약을
 * 따랐는지 확인할 방법도 없다.
 *
 * 전부를 FragmentReader와 FragmentWriter로 옮기는 것은 답이 아니다. 그 둘이
 * 수천 줄짜리 만능 객체가 되어 모듈화라는 본래 목적과 어긋난다. 대신 현재
 * 분포를 기록해 두고 늘어나는 것을 막는다. 새 질의는 데이터 계층을 거치거나,
 * 여기에 사유와 함께 등록해야 한다.
 *
 * 숫자를 올릴 때는 그 질의가 왜 데이터 계층 밖에 있어야 하는지 판단이
 * 선행돼야 한다. 판단 없이 숫자만 올리면 이 가드는 의미를 잃는다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB  = path.resolve(HERE, "..", "..", "lib");

/** 파일별 fragments 직접 접근 허용 개수. */
const ALLOWED = {
  "admin/ApiKeyStore.js": 1,
  "admin/admin-export.js": 2,
  "admin/admin-keys.js": 1,
  "admin/admin-memory.js": 12,
  "admin/admin-routes.js": 6,
  "cli/export.js": 2,
  "cli/import.js": 2,
  "cli/inspect.js": 1,
  "cli/stats.js": 5,
  "memory/FragmentIndex.js": 1,
  "memory/consolidate/ConsolidatorGC.js": 12,
  "memory/consolidate/FragmentGC.js": 11,
  "memory/consolidate/MemoryConsolidator.js": 23,
  "memory/consolidate/MorphemeBackfill.js": 2,
  "memory/consolidate/UtilityBaseline.js": 1,
  "memory/embedding/EmbeddingWorker.js": 4,
  "memory/embedding/SyntheticQueryWorker.js": 3,
  "memory/link/ContradictionDetector.js": 12,
  "memory/link/GraphLinker.js": 11,
  "memory/link/LinkStore.js": 7,
  "memory/link/TemporalLinker.js": 1,
  "memory/processors/EpisodeContinuityService.js": 1,
  "memory/processors/MemoryRecaller.js": 1,
  "memory/read/CaseRecall.js": 1,
  "memory/read/ContextBuilder.js": 1,
  "memory/read/FragmentReader.js": 13,
  "memory/read/HistoryReconstructor.js": 1,
  "memory/read/KeyNameEnricher.js": 1,
  "memory/read/RecallSuggestionEngine.js": 2,
  "memory/read/StitchSourceLoader.js": 1,
  "memory/read/SyntheticQuerySearch.js": 1,
  "memory/read/TopicResolver.js": 1,
  "memory/read/quotaQueries.js": 1,
  "memory/signals/CaseRewardBackprop.js": 1,
  "memory/signals/RecallBenchmark.js": 1,
  "memory/signals/SpreadingActivation.js": 2,
  "memory/write/BatchRememberProcessor.js": 1,
  "memory/write/ConflictResolver.js": 2,
  "memory/write/FragmentWriter.js": 21,
  "memory/write/RememberPostProcessor.js": 1,
  "tools/reconstruct.js": 1,
  "tools/resources.js": 4,
};

/** 데이터 계층. 여기에 있는 질의는 제자리에 있는 것이다. */
const DATA_LAYER = new Set([
  "memory/read/FragmentReader.js",
  "memory/write/FragmentWriter.js"
]);

const FRAGMENT_SQL = /(FROM|INTO|UPDATE|DELETE FROM)\s+\$\{SCHEMA\}\.fragments\b/g;

/** lib 아래 모든 js 파일을 수집한다. */
function collect(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) collect(p, acc);
    else if (name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

/** 파일별 fragments 직접 접근 수를 센다. */
export function countFragmentSql() {
  const counts = {};
  for (const file of collect(LIB)) {
    const rel = path.relative(LIB, file);
    if (rel === path.join("memory", "schema.js")) continue;
    const n = (readFileSync(file, "utf8").match(FRAGMENT_SQL) || []).length;
    if (n > 0) counts[rel.split(path.sep).join("/")] = n;
  }
  return counts;
}

describe("파편 표 접근 경계", () => {
  const counts = countFragmentSql();

  test("등록되지 않은 파일이 파편 표를 직접 다루지 않는다", () => {
    const unexpected = Object.keys(counts).filter(f => !(f in ALLOWED));
    assert.deepEqual(unexpected, [], `경계 밖 신규 접근: ${unexpected.join(", ")}`);
  });

  test("파일별 접근 수가 기록된 값을 넘지 않는다", () => {
    for (const [file, n] of Object.entries(counts)) {
      assert.ok(n <= ALLOWED[file],
        `${file}: ${n}곳 (허용 ${ALLOWED[file]}곳). 새 질의는 데이터 계층을 거쳐야 한다`);
    }
  });

  test("이미 정리된 항목이 목록에 남아 있지 않다", () => {
    const dead = Object.keys(ALLOWED).filter(f => !(f in counts));
    assert.deepEqual(dead, [], `정리된 항목은 목록에서 지운다: ${dead.join(", ")}`);
  });

  test("데이터 계층이 여전히 가장 많은 접근을 보유한다", () => {
    for (const f of DATA_LAYER) {
      assert.ok(counts[f] > 0, `${f}가 파편 표를 다루지 않는다. 데이터 계층이 비었을 수 있다`);
    }
  });

  test("스키마 이름은 한곳에서만 선언된다", () => {
    const offenders = [];
    for (const file of collect(LIB)) {
      const rel = path.relative(LIB, file).split(path.sep).join("/");
      if (rel === "memory/schema.js") continue;
      if (/const SCHEMA\s*=\s*"agent_memory"/.test(readFileSync(file, "utf8"))) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], `스키마 이름을 다시 선언한 파일: ${offenders.join(", ")}`);
  });

  test("보간되지 않는 스키마 표기가 없다", () => {
    const offenders = [];
    for (const file of collect(LIB)) {
      const src = readFileSync(file, "utf8");
      /** 큰따옴표 문자열 안의 ${SCHEMA}는 치환되지 않아 없는 스키마를 가리킨다. */
      if (/"[^"\n]*\$\{SCHEMA\}[^"\n]*\.\w/.test(src)) {
        offenders.push(path.relative(LIB, file).split(path.sep).join("/"));
      }
    }
    assert.deepEqual(offenders, [], `템플릿 리터럴이 아닌 문자열에 스키마 보간: ${offenders.join(", ")}`);
  });
});
