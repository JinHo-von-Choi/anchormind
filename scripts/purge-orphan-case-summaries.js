#!/usr/bin/env node
/**
 * 원본 파편이 없는 case_events 요약 정리
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 대상: source_fragment_id 가 있으나(빈 문자열 제외) 그 id 의 파편 행이 fragments 에 없는 case_events.
 * 요약(summary)을 "[삭제됨]"으로 바꾼다. 이벤트 행, 유형, 순서, 엣지는 그대로 둔다.
 * 닫힌(valid_to 지정) 파편은 행이 남아 있으므로 대상이 아니다. 모순 해소 기록 파편은 다루지 않는다.
 * forget 삭제 연쇄(MEMENTO_FORGET_CASCADE=on)가 켜진 동안에는 forget 이 같은 트랜잭션에서 요약을 바꾸므로,
 * 이 스크립트는 스위치가 꺼진 동안의 forget 과 다른 삭제 경로(만료 정리, 병합)가 남긴 요약을 정리한다.
 *
 * 접속 대상: --url 또는 표준 PG 환경변수(PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD).
 *            환경 파일과 앱 설정 모듈을 읽지 않는다. 대상이 명시되지 않으면 연결하지 않고 거부한다.
 *            출력은 호스트, 포트, 데이터베이스 이름만 담는다.
 * 실행 모드: 기본은 대상 수와 event_id 표본만 출력한다(변경 없음). 실제 변경은 --execute 와
 *            --i-have-a-backup 이 함께 있어야 하며, 없으면 백업 명령을 알리고 거부한다.
 *
 * 사용:
 *   PGHOST=... PGDATABASE=... PGUSER=... PGPASSWORD=... node scripts/purge-orphan-case-summaries.js
 *   node scripts/purge-orphan-case-summaries.js --url postgresql://... --execute --i-have-a-backup [--batch 200]
 *
 * 종료 코드: 0 성공, 1 실행 실패, 2 인자나 대상 거부.
 */

import path from "node:path";
import { resolveTarget, OnlineIndexUsageError }          from "./ops/online-index-plan.mjs";
import { purgeOrphanCaseSummaries, ORPHAN_PURGE_BATCH }  from "../lib/memory/write/ForgetCascade.js";

/** --execute 와 함께 주는 백업 완료 확인 옵션 */
export const BACKUP_FLAG = "--i-have-a-backup";

const MAX_BATCH = 10_000;

const USAGE = [
  "사용법: node scripts/purge-orphan-case-summaries.js [--url <postgres 주소>] [--execute --i-have-a-backup] [--batch <n>]",
  "  (옵션 없음)          대상 수와 event_id 표본만 출력한다(변경 없음)",
  "  --url <주소>         접속 대상. 없으면 PGHOST, PGDATABASE 등 표준 PG 환경변수",
  "  --execute            요약을 [삭제됨]으로 바꾼다. --i-have-a-backup 이 함께 있어야 한다",
  `  ${BACKUP_FLAG}     pg_dump -t agent_memory.case_events 백업을 마쳤음을 확인한다`,
  `  --batch <n>          한 문장에서 바꾸는 행 수(기본 ${ORPHAN_PURGE_BATCH}, 1~${MAX_BATCH})`,
].join("\n");

/** 값을 받지 않는 옵션과 opts 필드 */
const SWITCH_FLAGS = Object.freeze({ "--execute": "execute", [BACKUP_FLAG]: "backupConfirmed", "--help": "help" });

/** 값을 받는 옵션과 opts 필드, 값 변환 */
const VALUE_FLAGS = Object.freeze({
  "--url"  : ["url", value => value],
  "--batch": ["batch", value => checkedBatch(value)],
});

/** `--name=value`이면 이름과 인라인 값으로 나눈다. */
function splitArg(arg) {
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  return eq > 2 ? { name: arg.slice(0, eq), inline: arg.slice(eq + 1) } : { name: arg, inline: undefined };
}

/** 값을 받는 옵션의 값과 다음 인덱스. */
function takeValue(name, inline, argv, i) {
  const value = inline ?? argv[i + 1];
  if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
    throw new OnlineIndexUsageError(`${name} 에 값이 필요하다`);
  }
  return { value, next: inline === undefined ? i + 1 : i };
}

/**
 * 명령행 인자를 읽는다. 오류 메시지는 옵션 이름만 담고 값(주소)은 담지 않는다.
 *
 * @param {string[]} argv
 * @returns {{execute: boolean, backupConfirmed: boolean, help: boolean, batch: number, url: string|undefined}}
 */
export function parsePurgeArgs(argv) {
  const opts = { execute: false, backupConfirmed: false, help: false, batch: ORPHAN_PURGE_BATCH, url: undefined };
  for (let i = 0; i < argv.length; i++) {
    const { name, inline } = splitArg(argv[i]);
    if (!name.startsWith("--")) throw new OnlineIndexUsageError("알 수 없는 인자: (위치 인자)");

    if (Object.hasOwn(SWITCH_FLAGS, name)) {
      if (inline !== undefined) throw new OnlineIndexUsageError(`${name} 은 값을 받지 않는다`);
      opts[SWITCH_FLAGS[name]] = true;
    } else if (Object.hasOwn(VALUE_FLAGS, name)) {
      const [field, convert] = VALUE_FLAGS[name];
      const taken            = takeValue(name, inline, argv, i);
      opts[field]            = convert(taken.value);
      i                      = taken.next;
    } else {
      throw new OnlineIndexUsageError(`알 수 없는 인자: ${name}`);
    }
  }
  return opts;
}

/** --batch 값을 검사한다. */
function checkedBatch(text) {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH) {
    throw new OnlineIndexUsageError(`--batch 는 1 이상 ${MAX_BATCH} 이하의 정수여야 한다`);
  }
  return n;
}

/**
 * 실행 전에 받아 둘 백업 명령. 사용자와 비밀번호는 담지 않는다(PGUSER, PGPASSWORD 로 준다).
 *
 * @param {{host: string, port: number, database: string}} config
 * @returns {string}
 */
export function backupCommand(config) {
  return `pg_dump -h ${config.host} -p ${config.port} -d ${config.database} -t agent_memory.case_events -Fc -f case_events.dump`;
}

/** 출력용 대상 표시: 호스트, 포트, 데이터베이스만 */
function targetLabel(config) {
  return `${config.host}:${config.port}/${config.database}`;
}

/** pg 연결을 연다. 기본 연결 함수. */
async function connectWithPg(config) {
  const { default: pg } = await import("pg");
  const client = new pg.Client(config);
  await client.connect();
  return client;
}

/**
 * 진입점. 종료 코드를 돌려준다.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {{connect?: Function, out?: Function, err?: Function}} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, env, deps = {}) {
  const out = deps.out ?? (line => process.stdout.write(`${line}\n`));
  const err = deps.err ?? (line => process.stderr.write(`${line}\n`));
  try {
    const opts = parsePurgeArgs(argv);
    if (opts.help) { out(USAGE); return 0; }

    const { config } = resolveTarget({ url: opts.url }, env);
    const backup     = backupCommand(config);
    err(`[purge-orphan-case-summaries] 대상: ${targetLabel(config)} 모드: ${opts.execute ? "execute" : "dry-run"} 묶음: ${opts.batch}`);
    if (opts.execute && !opts.backupConfirmed) {
      throw new OnlineIndexUsageError(
        `변경 전에 백업을 받는다: ${backup} . 백업을 마쳤으면 --execute ${BACKUP_FLAG} 로 다시 실행한다`
      );
    }
    if (opts.execute) err(`[purge-orphan-case-summaries] 백업 확인됨. 복구 기준 백업: ${backup}`);

    const client = await (deps.connect ?? connectWithPg)(config);
    try {
      const result = await purgeOrphanCaseSummaries(client, { execute: opts.execute, batchSize: opts.batch });
      out(JSON.stringify(result, null, 2));
    } finally {
      await client.end();
    }
    if (!opts.execute) {
      err(`[purge-orphan-case-summaries] 변경하지 않았다. 바꾸려면 ${backup} 로 백업한 뒤 --execute ${BACKUP_FLAG} 를 준다`);
    }
    return 0;
  } catch (e) {
    const usage = e instanceof OnlineIndexUsageError;
    err(`[purge-orphan-case-summaries] ${usage ? "거부" : "실패"}: ${e.message}`);
    return usage ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2), process.env).then(code => process.exit(code));
}
