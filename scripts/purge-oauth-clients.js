#!/usr/bin/env node
/**
 * 미사용 OAuth DCR 클라이언트 정리
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 대상: last_used_at IS NULL, 등록 후 기준일(기본 30일) 경과, 키에 묶이지 않은 클라이언트.
 * 한 번이라도 쓰인 클라이언트와 키에 묶인 클라이언트는 지우지 않는다.
 * DB 접속 설정은 서버와 같은 경로(lib/config.js의 POSTGRES_*, DOTENV_CONFIG_PATH)를 쓴다.
 *
 * 사용:
 *   node scripts/purge-oauth-clients.js                      후보 수와 표본 출력(삭제 없음)
 *   node scripts/purge-oauth-clients.js --older-than-days 45
 *   node scripts/purge-oauth-clients.js --execute            실제 삭제(200건씩)
 *
 * 삭제는 되돌릴 수 없다. 실행 전 pg_dump -t agent_memory.oauth_clients 로 표를 보관한다.
 */

import { DB_HOST, DB_PORT, DB_NAME }              from "../lib/config.js";
import { getPrimaryPool, shutdownPool }           from "../lib/tools/db.js";
import { purgeUnusedClients }                     from "../lib/admin/OAuthClientStore.js";

const args    = process.argv.slice(2);
const KNOWN   = new Set(["--execute", "--older-than-days"]);
const execute = args.includes("--execute");
const daysIdx = args.indexOf("--older-than-days");
const days    = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 30;

const unknown = args.filter((a, i) => a.startsWith("--") && !KNOWN.has(a) && !(daysIdx >= 0 && i === daysIdx + 1));
if (unknown.length) {
  console.error(`unknown option: ${unknown.join(" ")}`);
  process.exit(2);
}
if (!DB_HOST || !DB_NAME) {
  console.error("database settings are required (POSTGRES_HOST, POSTGRES_DB)");
  process.exit(2);
}

console.error(`target: ${DB_HOST}:${DB_PORT}/${DB_NAME} mode: ${execute ? "execute" : "dry-run"} older-than-days: ${days}`);

try {
  const result = await purgeUnusedClients(getPrimaryPool(), { olderThanDays: days, execute });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`purge-oauth-clients failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await shutdownPool();
}
