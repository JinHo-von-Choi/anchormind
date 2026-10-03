/**
 * CLI: audit - 감사 해시 체인 검증
 *
 * 서브명령:
 *   verify [--from-seq N] [--max-rows N] [--json]   admin_audit_events 체인을 다시 계산해 확인한다
 *
 * 로컬 전용이다. 서버와 같은 환경 변수로 DB에 붙어 AuditStore.verify를 실행한다. 체인이 끊겼으면 끊긴
 * seq와 사유를 출력하고 종료 코드 1로 끝난다(bin/memento.js가 예외를 종료 코드 1로 바꾼다).
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

export const usage = [
  "Usage: memento-mcp audit verify [options]",
  "",
  "Recompute the admin_audit_events hash chain and report the first break.",
  "",
  "Options:",
  "  --from-seq <n>   Start at this seq and link it to the previous row (default: oldest row)",
  "  --max-rows <n>   Stop after this many rows (default: 1000000)",
  "  --json           Print the result as JSON",
  "",
  "Exit code is 1 when the chain is broken.",
].join("\n");

/** 체인이 끊겼을 때 던진다. 메시지가 CLI 출력의 마지막 줄이 된다. */
export class AuditChainBrokenError extends Error {
  /** @param {{ seq: number, reason: string }} broken */
  constructor(broken) {
    super(`audit chain broken at seq ${broken.seq} (${broken.reason})`);
    this.name   = "AuditChainBrokenError";
    this.broken = broken;
  }
}

/**
 * 양의 정수 옵션. 없으면 undefined.
 *
 * @param {object} args
 * @param {string} name
 * @returns {number|undefined}
 */
export function positiveIntOption(args, name) {
  const raw = args[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw === true || !Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

/**
 * 검증 결과를 사람이 읽는 줄로 바꾼다.
 *
 * @param {object} result AuditStore.verify 결과
 * @returns {string[]}
 */
export function formatVerifyResult(result) {
  if (result.checked === 0 && result.broken === null) return ["audit chain: no rows to check"];
  const lines = [
    `audit chain: ${result.ok ? "intact" : "BROKEN"}`,
    `  checked : ${result.checked} row(s), seq ${result.firstSeq ?? "-"} .. ${result.lastSeq ?? "-"}`,
    `  anchor  : ${result.anchor ?? "-"} ${result.anchorHash ?? ""}`.trimEnd()
  ];
  if (result.ok) {
    lines.push(`  head    : ${result.headHash ?? "-"}`);
    if (!result.complete) lines.push("  stopped at --max-rows before the end of the chain");
  } else {
    lines.push(`  break   : seq ${result.broken.seq} (${result.broken.reason})`);
  }
  return lines;
}

export default async function audit(args) {
  const sub = args._?.[0];
  if (sub !== "verify") throw new Error(`unknown audit subcommand: ${sub ?? "(none)"}. Run "memento-mcp audit --help"`);

  const fromSeq = positiveIntOption(args, "from-seq");
  const maxRows = positiveIntOption(args, "max-rows");

  const { getPrimaryPool, shutdownPool } = await import("../tools/db.js");
  const { AuditStore }                   = await import("../logging/AuditStore.js");
  let result;
  try {
    result = await new AuditStore(getPrimaryPool()).verify({ fromSeq: fromSeq ?? null, ...(maxRows ? { maxRows } : {}) });
  } finally {
    await shutdownPool();
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatVerifyResult(result).join("\n"));
  if (!result.ok) throw new AuditChainBrokenError(result.broken);
}
