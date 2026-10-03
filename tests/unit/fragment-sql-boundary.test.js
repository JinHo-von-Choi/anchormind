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
  "admin/ApiKeyStore.js": 2, // 키 삭제 전 그 키의 파편 수(닫힌 파편 포함)를 키 행 잠금과 같은 트랜잭션에서 센다
  "admin/admin-keys.js": 1,
  "admin/admin-memory.js": 12,
  "admin/admin-routes.js": 6,
  "admin/ReviewStore.js": 7, // 검토 대기 목록, 잠금 순서용 결정 대상 사전 조회, 결정 대상 행 잠금과 승인, 거절 상태 변경, 자동 거절의 잠금과 갱신. 결정 기록 표와 같은 트랜잭션에 쓰므로 데이터 계층 객체를 거치지 않는다
  "cli/inspect.js": 1,
  "cli/stats.js": 5,
  "memory/FragmentIndex.js": 1,
  "memory/WorkingMemoryRows.js": 8, // 작업 기억 행의 조회와 삭제는 FragmentIndex의 작업 기억 계약 뒤에서 호출되며, FragmentWriter가 FragmentIndex를 가져오므로 데이터 계층으로 옮기면 가져오기 순환이 생긴다
  "memory/WorkingMemorySql.js": 1, // 키 삭제 트랜잭션이 키 행을 지우기 전에 그 키의 작업 기억 행을 지운다. 질의를 받는 client를 인자로 쓰므로 데이터 계층 객체를 거치지 않는다
  "memory/consolidate/ConsolidatorGC.js": 12,
  "memory/consolidate/FragmentGC.js": 11,
  "memory/consolidate/MemoryConsolidator.js": 26, // semantic_dedup 병합은 잠금, 폐기, linked_to, 합산을 한 트랜잭션 클라이언트로 쓴다
  "memory/consolidate/MorphemeBackfill.js": 2,
  "memory/consolidate/UtilityBaseline.js": 1,
  "memory/consolidate/idOrderedUpdate.js": 3, // id 순 묶음 갱신은 잠금 CTE와 갱신 문장을, 재개형 백필의 후보 id 조회는 같은 조건식을 함께 쓴다
  "memory/embedding/EmbeddingWorker.js": 5, // 배치 저장은 id 순 잠금 CTE와 갱신 문장을 함께 쓴다
  "memory/embedding/SyntheticQueryWorker.js": 3,
  "memory/link/ContradictionDetector.js": 12,
  "memory/link/GraphLinker.js": 11,
  "memory/link/LinkStore.js": 9, // 가져온 링크의 양 끝 linked_to 갱신은 id 순 잠금 CTE와 갱신 문장을 함께 쓴다
  "memory/link/TemporalLinker.js": 1,
  "memory/processors/EpisodeContinuityService.js": 1,
  "memory/processors/MemoryRecaller.js": 1,
  "memory/read/CaseRecall.js": 2,
  "memory/CaseEventStore.js": 1,
  "memory/read/ContextBuilder.js": 1,
  "memory/read/FragmentReader.js": 17, // recall 예산 선택의 저장 토큰 수 조회(getStoredTokenCounts), 모순 감사 기록의 원본 등급 조회(getTrustTiers)
  "memory/read/HistoryReconstructor.js": 1,
  "memory/read/KeyNameEnricher.js": 1,
  "memory/read/ProvenanceLoader.js": 1, // 답 꾸러미, recall 응답, context core 후보의 출처 열(source, origin, trust_tier)을 대체 체인 조회와 같은 recall의 agent, 키, workspace 범위 절로 읽는다. 답 꾸러미 source 조회를 옮겨 와 AnswerPackLoader에는 직접 접근이 없다. FragmentReader 메서드로 옮기면 그 범위 절을 중복한다
  "memory/read/RecallSuggestionEngine.js": 2,
  "memory/read/StitchSourceLoader.js": 1,
  "memory/read/SyntheticQuerySearch.js": 1,
  "memory/read/TopicResolver.js": 1,
  "memory/read/quotaQueries.js": 1,
  "memory/signals/CaseRewardBackprop.js": 1,
  "memory/signals/RecallBenchmark.js": 1,
  "memory/signals/SpreadingActivation.js": 2,
  "memory/transfer/FragmentExporter.js": 1, // 내보내기는 호출자가 넘긴 조건과 연결로 파편 열 전체를 id 순 묶음으로 읽는다. 관리 API와 CLI가 함께 쓴다
  "memory/write/BatchRememberProcessor.js": 1,
  "memory/write/ConflictResolver.js": 2,
  "memory/write/DedupScope.js": 1, // 중복 판정 사전 조회. insert, amend, batch_remember가 같은 질의와 같은 범위 판정을 쓴다
  "memory/write/ForgetCascade.js": 3, // forget 삭제 연쇄의 잠금 문장과 삭제 문장(실행은 FragmentWriter.deleteWithCascade), 고아 요약 정리의 원본 파편 존재 조회
  "memory/write/FragmentWriter.js": 24, // 가져오기의 id 충돌 판정은 같은 id 행의 키 소속을 조회한다, archive 전에 현재 파편을 FOR UPDATE로 재조회, 접근 기록 갱신 3경로와 linked_to 정리 2경로는 id 순 잠금 CTE와 갱신 문장을 함께 쓴다
  "memory/write/RememberPostProcessor.js": 1,
  "memory/write/rowLock.js": 2, // 여러 행 쓰기 경로가 공유하는 id 순 잠금 문장과 잠근 행 삭제 문장
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
