#!/usr/bin/env node
/**
 * 원본 파편이 없는 case_events 요약 정리
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 대상: source_fragment_id 가 있으나 그 id 의 파편 행이 fragments 에 없는 case_events.
 * 요약(summary)을 "[삭제됨]"으로 바꾼다. 이벤트 행, 유형, 순서, 엣지는 그대로 둔다.
 * 닫힌(valid_to 지정) 파편은 행이 남아 있으므로 대상이 아니다.
 * forget 삭제 연쇄(MEMENTO_FORGET_CASCADE=on)가 켜진 뒤에는 forget 이 같은 트랜잭션에서 요약을 바꾸므로,
 * 이 스크립트는 스위치가 꺼진 동안의 forget 과 다른 삭제 경로(만료 정리, 병합)가 남긴 요약을 정리한다.
 * DB 접속 설정은 서버와 같은 경로(lib/config.js의 POSTGRES_*, DOTENV_CONFIG_PATH)를 쓴다.
 *
 * 사용:
 *   node scripts/purge-orphan-case-summaries.js                     대상 수와 event_id 표본 출력(변경 없음)
 *   node scripts/purge-orphan-case-summaries.js --execute           실제 변경(기본 500건씩)
 *   node scripts/purge-orphan-case-summaries.js --execute --batch 200
 *
 * 변경은 되돌릴 수 없다. 실행 전 pg_dump -t agent_memory.case_events 로 표를 보관한다.
 */

import { DB_HOST, DB_PORT, DB_NAME }                         from "../lib/config.js";
import { getPrimaryPool, shutdownPool }                      from "../lib/tools/db.js";
import { purgeOrphanCaseSummaries, ORPHAN_PURGE_BATCH }      from "../lib/memory/write/ForgetCascade.js";

const args     = process.argv.slice(2);
const KNOWN    = new Set(["--execute", "--batch"]);
const execute  = args.includes("--execute");
const batchIdx = args.indexOf("--batch");
const batch    = batchIdx >= 0 ? Number(args[batchIdx + 1]) : ORPHAN_PURGE_BATCH;

const unknown = args.filter((a, i) => !KNOWN.has(a) && !(batchIdx >= 0 && i === batchIdx + 1));
if (unknown.length) {
  console.error(`unknown option: ${unknown.join(" ")}`);
  process.exit(2);
}
if (!Number.isInteger(batch) || batch < 1 || batch > 10000) {
  console.error("--batch must be an integer between 1 and 10000");
  process.exit(2);
}
if (!DB_HOST || !DB_NAME) {
  console.error("database settings are required (POSTGRES_HOST, POSTGRES_DB)");
  process.exit(2);
}

console.error(`target: ${DB_HOST}:${DB_PORT}/${DB_NAME} mode: ${execute ? "execute" : "dry-run"} batch: ${batch}`);

try {
  const result = await purgeOrphanCaseSummaries(getPrimaryPool(), { execute, batchSize: batch });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`purge-orphan-case-summaries failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await shutdownPool();
}
