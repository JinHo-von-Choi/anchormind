/**
 * CLI: retention - 키·workspace별 자동 정리 설정과 보존 기간 확인, 변경
 *
 * 서브명령:
 *   status [--key KEY]                                  전역 모드와 범위별 설정. --key가 없으면 모든 키에서
 *                                                       자동 정리가 꺼졌거나 재개를 기다리거나 만료 없음인 범위
 *   preview <key> [--workspace W]                       그 범위에서 자동 정리를 켜면 다음 주기에 손댈 파편 수
 *   set <key> [--workspace W] [--auto-cleanup on|off] [--no-expiry|--inherit-expiry]
 *       [--resume-after-days N] [--confirm]             자동 정리와 만료 없음을 바꾼다. --confirm이 없으면 바뀔
 *                                                       내용만 보인다
 * <key>는 id 또는 이름이다. 보존 일수는 관리 콘솔의 Set Policy 또는 관리 API PUT /keys/:id/retention으로 바꾼다.
 * 바꾸는 명령은 관리 API와 같은 이름의 감사 이벤트(admin.key.retention_scope_update)를 outbox에 남기고, Redis가 켜져
 * 있으면 실행 중인 서버에 알린다. Redis가 없으면 서버는 최대 1분 뒤에 반영한다.
 *
 * 로컬 전용이며 서버와 같은 DB 설정(.env)으로 붙는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-23
 */
import { getPrimaryPool, shutdownPool } from "../tools/db.js";
import { listApiKeys }                  from "../admin/ApiKeyStore.js";
import {
  listRetentionScopes, listAllRetentionScopes, previewRetentionScope, setRetentionScope, normalizeScopeInput,
  RetentionPolicyError, RESUME_AFTER_DAYS, changedScopeFields
} from "../admin/RetentionPolicyStore.js";
import { pickOne, GroupCliError }       from "./group.js";
import { broadcastKeyInvalidation }     from "../keys/invalidation.js";
import { redisClient }                  from "../redis.js";
import { AUDIT_TOPIC, buildAuditPayload } from "../logging/audit-event.js";
import { OUTBOX_INSERT_SQL }            from "../outbox/outbox-sql.js";

export const usage = [
  "Usage: memento-mcp retention <subcommand> [options]",
  "",
  "Show and change automatic cleanup and retention per key or workspace",
  "(local only, uses the server .env database settings).",
  "",
  "With automatic cleanup off, consolidation never deletes, merges, supersedes or demotes fragments",
  "in that scope. Fragments are removed only by forget or by an expired retention period.",
  "",
  "Subcommands:",
  "  status [--key KEY]                     Global mode and the settings of one key. Without --key,",
  "                                         every scope with cleanup off, resume pending or no expiry",
  "  preview <key> [--workspace W]          Fragments the next cycle would touch if cleanup were on",
  "  set <key> [--workspace W] [--auto-cleanup on|off] [--no-expiry|--inherit-expiry]",
  "      [--resume-after-days N] [--confirm]",
  `                                         Change the scope. Turning cleanup back on waits N days`,
  `                                         (default ${RESUME_AFTER_DAYS.default}, 0 = now). Without --confirm only shows the change.`,
  "",
  "<key> accepts an id or a name. Without --workspace the setting applies to the whole key.",
  "Retention periods in days are set in the admin console (Set Policy) or with PUT /keys/:id/retention.",
  "",
  "Options:",
  "  --json   Print the result as JSON"
].join("\n");

/** 감사 이벤트를 outbox에 남긴다. */
async function recordAudit(keyId, detail) {
  const payload = buildAuditPayload({
    action: "admin.key.retention_scope_update", actor: "system", target: { type: "api_key", id: keyId },
    detail: { channel: "cli", ...detail }
  });
  await getPrimaryPool().query(OUTBOX_INSERT_SQL, [AUDIT_TOPIC, `api_key:${keyId}`, JSON.stringify(payload), 0]);
}

async function closeRedisClient() {
  if (redisClient.status === "ready") await redisClient.quit().catch(() => redisClient.disconnect());
  else redisClient.disconnect?.();
}

/** 범위 하나의 사람이 읽는 설명 */
function describeEffective(e) {
  const cleanup = e.mode === "manual" ? `auto cleanup off (${e.modeSource})` : "auto cleanup on";
  const expiry  = e.expiry === null ? "no retention period"
    : e.expiry === "none" ? `no expiry (${e.expirySource})`
    : `delete after ${e.expiry} days (${e.expirySource})`;
  return `${cleanup}, ${expiry}`;
}

function globalLine(g) {
  if (g.mode === "manual") return "global: MEMENTO_RETENTION_MODE=manual (automatic cleanup off for every key)";
  if (g.pending)           return `global: auto, waiting until ${g.autoAfter} (MEMENTO_RETENTION_AUTO_AFTER)`;
  return "global: auto";
}

function previewLines(p) {
  const c = p.counts;
  return [
    `  expired delete          ${c.expiredDelete}`,
    `  permanent -> cold       ${c.permanentDemote}`,
    `  session_reflect purge   ${c.reflectionPurge}`,
    `  review auto-reject      ${c.reviewExpire}`,
    `  exact duplicates closed ${c.exactDuplicates}`,
    `  retention period expiry ${c.retentionExpire} (applies in either mode)`,
    `  not counted: ${p.notCounted.join(", ")}`
  ];
}

/** set 인자를 관리 API와 같은 입력으로 바꾼다. */
function setInput(args) {
  const body = { workspace: typeof args.workspace === "string" ? args.workspace : null };
  if (args["auto-cleanup"] !== undefined) {
    const v = String(args["auto-cleanup"]);
    if (v !== "on" && v !== "off") throw new GroupCliError("--auto-cleanup must be on or off");
    body.autoLifecycle = v === "on";
  }
  /** parseArgs는 --no-expiry를 { expiry: false }로 읽는다 */
  const noExpiry = args.expiry === false || args["no-expiry"] === true;
  if (noExpiry && args["inherit-expiry"] === true) {
    throw new GroupCliError("--no-expiry and --inherit-expiry cannot be used together");
  }
  if (noExpiry)                        body.noExpiry = true;
  if (args["inherit-expiry"] === true) body.noExpiry = false;
  if (args["resume-after-days"] !== undefined) body.resumeAfterDays = Number(args["resume-after-days"]);
  return normalizeScopeInput(body);
}

/** status: --key가 없으면 모든 키의 꺼진 범위, 있으면 그 키의 범위별 적용 값 */
async function statusCommand(args) {
  if (typeof args.key !== "string") {
    const all = await listAllRetentionScopes();
    const rows = all.scopes.map((s) => `${s.key_name}  ${s.workspace ?? "(all workspaces)"}  ` +
      `${s.manual ? "auto cleanup off" : "auto cleanup on"}` +
      `${s.auto_resume_at ? `, resumes ${s.auto_resume_at}` : ""}${s.no_expiry ? ", no expiry" : ""}`);
    return { data: all, text: [globalLine(all.global), ...(rows.length ? rows : ["(no scopes with cleanup off or no expiry)"])].join("\n") };
  }
  const key = pickOne(await listApiKeys(), args.key, "key");
  const s   = await listRetentionScopes(key.id);
  const lines = [
    globalLine(s.global),
    `${key.name} (all workspaces): ${describeEffective(s.keyEffective)}`,
    ...s.workspaces.map((w) => `  ${w.workspace ?? "(no workspace)"}  ${w.fragments} fragments: ${describeEffective(w.effective)}`),
    `quota: ${s.quota.used}${s.quota.limit !== null ? ` / ${s.quota.limit}` : " (no limit)"}`
  ];
  return { data: s, text: lines.join("\n") };
}

/** preview: 그 범위에서 자동 정리를 켜면 다음 주기에 손댈 수 */
async function previewCommand(key, workspace) {
  const p = await previewRetentionScope(key.id, workspace);
  return { data: p, text: [`${key.name} ${workspace ?? "(all workspaces)"}: next cycle with cleanup on`, ...previewLines(p)].join("\n") };
}

/** set --confirm 없이: 바뀔 내용과, 자동 정리를 켜거나 만료 없음을 풀면 미리보기 수 */
async function describePlannedSet(key, workspace, input) {
  const p = input.autoLifecycle === true || input.noExpiry === false ? await previewRetentionScope(key.id, workspace) : null;
  const change = [
    input.autoLifecycle !== undefined ? `auto cleanup ${input.autoLifecycle ? "on" : "off"}` : null,
    input.noExpiry !== undefined ? (input.noExpiry ? "no expiry" : "inherit expiry") : null
  ].filter(Boolean).join(", ");
  const lines = [`would set ${key.name} ${workspace ?? "(all workspaces)"}: ${change}`];
  if (input.autoLifecycle === true) {
    lines.push(input.resumeAfterDays > 0 ? `cleanup resumes ${input.resumeAfterDays} days after the change` : "cleanup resumes immediately");
  }
  if (p) lines.push("next cycle once cleanup runs:", ...previewLines(p));
  lines.push("Run again with --confirm to apply.");
  return { data: { applied: false, input, preview: p }, text: lines.join("\n") };
}

/** set --confirm: 저장하고 감사 이벤트를 남긴 뒤 실행 중인 서버에 알린다 */
async function applySet(key, input) {
  const result = await setRetentionScope(key.id, input);
  await recordAudit(key.id, { workspace: result.workspace, ...changedScopeFields(result.before, result.after) });
  await broadcastKeyInvalidation([key.id]);
  const after = result.after
    ? `${result.after.auto_lifecycle ? "auto cleanup on" : "auto cleanup off"}` +
      `${result.after.auto_resume_at ? ` (resumes ${result.after.auto_resume_at})` : ""}` +
      `${result.after.no_expiry ? ", no expiry" : ""}`
    : "default (policy row removed)";
  return {
    data: { applied: true, ...result },
    text: `${key.name} ${result.workspace ?? "(all workspaces)"}: ${after}\n` +
          "Running servers apply this at once when Redis is on, otherwise within a minute."
  };
}

/**
 * @param {string} sub
 * @param {string[]} pos
 * @param {object} args
 * @returns {Promise<{ data: unknown, text: string }>}
 */
async function run(sub, pos, args) {
  if (sub === "status") return statusCommand(args);
  if (sub !== "preview" && sub !== "set") throw new GroupCliError(`unknown retention subcommand: ${sub}`);
  const key       = pickOne(await listApiKeys(), pos[0], "key");
  const workspace = typeof args.workspace === "string" ? args.workspace : null;
  if (sub === "preview") return previewCommand(key, workspace);
  const input = setInput(args);
  return args.confirm === true ? applySet(key, input) : describePlannedSet(key, workspace, input);
}

/**
 * @param {object} args parseArgs 결과
 * @param {{ out?: Function }} [deps]
 */
export default async function retention(args, { out = console.log } = {}) {
  const [sub, ...pos] = args._ ?? [];
  if (!sub) throw new GroupCliError('subcommand is required. Run "memento-mcp retention --help"');
  try {
    const result = await run(sub, pos.map(String), args);
    out(args.json ? JSON.stringify(result.data, null, 2) : result.text);
    return result.data;
  } catch (err) {
    if (err instanceof RetentionPolicyError) throw new GroupCliError(err.message);
    throw err;
  } finally {
    await shutdownPool();
    await closeRedisClient();
  }
}
