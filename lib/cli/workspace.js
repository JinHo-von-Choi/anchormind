/**
 * CLI: workspace - 키별 workspace 별칭과 병합
 *
 * 서브명령:
 *   suggest [--key KEY]                         별칭 후보(경로형 workspace와 같은 이름의 일반 workspace)
 *   aliases <key>                               키의 별칭 목록
 *   alias <key> <alias> <workspace|none>        별칭 설정(none은 삭제)
 *   merge <key> <from> <to> [--confirm]         from 파편을 to로 옮긴다(--confirm 없으면 미리보기)
 * <key>는 id 또는 이름이다. 바꾸는 명령은 관리 API와 같은 이름의 감사 이벤트를 outbox에 남긴다.
 *
 * 로컬 전용이며 서버와 같은 DB 설정(.env)으로 붙는다. Redis가 켜져 있으면 별칭 변경을 실행 중인 서버에 알린다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 */

import { getPrimaryPool, shutdownPool } from "../tools/db.js";
import { listApiKeys }                  from "../admin/ApiKeyStore.js";
import {
  listWorkspaceAliases, setWorkspaceAlias, suggestWorkspaceAliases, mergeWorkspace, normalizeAliasInput, WorkspaceAliasError
} from "../admin/WorkspaceAliasStore.js";
import { pickOne, GroupCliError }       from "./group.js";
import { broadcastKeyInvalidation }     from "../keys/invalidation.js";
import { redisClient }                  from "../redis.js";
import { deindexRows, FragmentIndex }   from "../memory/FragmentIndex.js";
import { AUDIT_TOPIC, buildAuditPayload } from "../logging/audit-event.js";
import { OUTBOX_INSERT_SQL }            from "../outbox/outbox-sql.js";

export const usage = [
  "Usage: memento-mcp workspace <subcommand> [options]",
  "",
  "Manage per-key workspace aliases and merge workspaces that split under several names",
  "(local only, uses the server .env database settings).",
  "",
  "Subcommands:",
  "  suggest [--key KEY]                    Alias candidates: path-like workspaces whose last segment is",
  "                                         already a workspace of the same key",
  "  aliases <key>                          List a key's aliases",
  "  alias <key> <alias> <workspace|none>   Map requests for <alias> to <workspace> (none removes the alias)",
  "  merge <key> <from> <to> [--confirm]    Move fragments stored under <from> to <to>. Without --confirm",
  "                                         only counts. Fragments whose content already exists under <to>",
  "                                         stay under <from> and are closed. A retention policy set on",
  "                                         <from> moves to <to>; if <to> has one too, the stricter",
  "                                         keeping rule wins (cleanup off, no expiry, longer period).",
  "",
  "<key> accepts an id or a name.",
  "",
  "Options:",
  "  --json   Print the result as JSON"
].join("\n");

/**
 * 감사 이벤트를 outbox에 남긴다.
 *
 * @param {string} action
 * @param {string} keyId
 * @param {object} detail
 */
async function recordAudit(action, keyId, detail) {
  const payload = buildAuditPayload({ action, actor: "system", target: { type: "api_key", id: keyId }, detail: { channel: "cli", ...detail } });
  await getPrimaryPool().query(OUTBOX_INSERT_SQL, [AUDIT_TOPIC, `api_key:${keyId}`, JSON.stringify(payload), 0]);
}

/** 병합으로 옮기는 보존 정책 한 줄 */
function policyLine({ result }, applied) {
  const expiry  = result.no_expiry ? "no expiry" : (result.max_age_days ? `delete after ${result.max_age_days} days` : "expiry inherited");
  const resumes = result.auto_resume_at && new Date(result.auto_resume_at).getTime() > Date.now();
  const cleanup = !result.auto_lifecycle ? "auto cleanup off"
    : (resumes ? `auto cleanup resumes ${result.auto_resume_at}` : "auto cleanup on");
  return `${applied ? "retention policy moved" : "retention policy would move"} to ${result.workspace}: ${cleanup}, ${expiry}`;
}

async function closeRedisClient() {
  if (redisClient.status === "ready") await redisClient.quit().catch(() => redisClient.disconnect());
  else redisClient.disconnect?.();
}

/**
 * @param {string} sub
 * @param {string[]} pos
 * @param {object} args
 * @returns {Promise<{ text: string, data: unknown }>}
 */
async function run(sub, pos, args) {
  if (sub === "suggest") {
    const keyId = typeof args.key === "string" ? pickOne(await listApiKeys(), args.key, "key").id : null;
    const list  = await suggestWorkspaceAliases(keyId);
    return {
      data: list,
      text: list.map((s) => `${s.keyId}  ${s.alias} -> ${s.workspace}  (${s.aliasFragments} / ${s.workspaceFragments} fragments)`).join("\n")
        || "(no candidates)"
    };
  }

  const key = pickOne(await listApiKeys(), pos[0], "key");
  if (sub === "aliases") {
    const list = await listWorkspaceAliases(key.id);
    return { data: list, text: list.map((a) => `${a.alias} -> ${a.workspace}`).join("\n") || "(no aliases)" };
  }
  if (sub === "alias") {
    if (pos[2] === undefined) throw new GroupCliError("alias needs <alias> and <workspace|none>");
    const result = await setWorkspaceAlias(key.id, normalizeAliasInput(pos[1], pos[2] === "none" ? null : pos[2]));
    await recordAudit("admin.key.workspace_alias_update", key.id, { alias: result.alias, before: { workspace: result.previous }, after: { workspace: result.workspace } });
    await broadcastKeyInvalidation([key.id]);
    return { data: result, text: `${key.name}  ${result.alias}: ${result.previous ?? "(none)"} -> ${result.workspace ?? "(none)"}` };
  }
  if (sub === "merge") {
    const [, from, to] = pos;
    const apply  = args.confirm === true;
    const result = await mergeWorkspace(key.id, from, to, { apply });
    if (apply) {
      await deindexRows(result.closedRows);
      const index = new FragmentIndex();
      for (const id of result.ids) await index.evictCachedFragment(id, key.id);
      await recordAudit("admin.key.workspace_merge", key.id, {
        from, to, moved: result.moved, closedDuplicates: result.closedDuplicates,
        ...(result.retentionPolicy ? { retentionPolicy: result.retentionPolicy.result } : {})
      });
      if (result.retentionPolicy) await broadcastKeyInvalidation([key.id]);
    }
    const { closedRows: _rows, ids: _ids, ...summary } = result;
    const policy = result.retentionPolicy ? `\n${policyLine(result.retentionPolicy, apply)}` : "";
    return {
      data: summary,
      text: (apply
        ? `merged ${from} -> ${to}: moved=${result.moved} closedDuplicates=${result.closedDuplicates}`
        : `would move ${result.moved} fragments and close ${result.closedDuplicates} duplicates (${from} -> ${to}). Run again with --confirm to apply.`) + policy
    };
  }
  throw new GroupCliError(`unknown workspace subcommand: ${sub}`);
}

/**
 * @param {object} args parseArgs 결과
 * @param {{ out?: Function }} [deps]
 */
export default async function workspace(args, { out = console.log } = {}) {
  const [sub, ...pos] = args._ ?? [];
  if (!sub) throw new GroupCliError('subcommand is required. Run "memento-mcp workspace --help"');
  try {
    const result = await run(sub, pos.map(String), args);
    out(args.json ? JSON.stringify(result.data, null, 2) : result.text);
    return result.data;
  } catch (err) {
    if (err instanceof WorkspaceAliasError) throw new GroupCliError(err.message);
    throw err;
  } finally {
    await shutdownPool();
    await closeRedisClient();
  }
}
