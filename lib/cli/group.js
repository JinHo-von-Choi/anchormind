/**
 * CLI: group - API 키 그룹과 멤버 권한 관리
 *
 * 서브명령:
 *   list                                   그룹 목록
 *   create <name> [--description TEXT]     그룹 만들기
 *   delete <group> --confirm               그룹 지우기(멤버십만 지우고 키와 파편은 그대로 둔다)
 *   members <group>                        멤버와 권한
 *   add <group> <key> [--permissions LIST] 멤버 넣기(기본 read,share,link)
 *   set <group> <key> --permissions LIST   멤버 권한 바꾸기
 *   remove <group> <key>                   멤버 빼기
 *   limit <group> <n|none>                 그룹 파편 상한(멤버 키 전체의 살아 있는 파편 수)
 * <group>과 <key>는 id 또는 이름이다. 바꾸는 명령은 관리 API와 같은 이름의 감사 이벤트를 outbox에 남긴다.
 *
 * 로컬 전용이며 서버와 같은 DB 설정(.env)으로 붙는다. Redis가 켜져 있으면 바뀐 멤버 키 id를 실행 중인 서버에
 * 알려 바로 반영하고, 아니면 서버가 키 상태 재확인 주기(MEMENTO_SESSION_KEY_RECHECK_MS, 기본 30초) 안에 반영한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 */

import { getPrimaryPool, shutdownPool }              from "../tools/db.js";
import {
  listApiKeys, listKeyGroups, createKeyGroup, deleteKeyGroup, removeKeyFromGroup, updateGroupFragmentLimit
} from "../admin/ApiKeyStore.js";
import {
  addGroupMember, groupMemberKeyIds, listGroupMembersWithPermissions, setGroupMemberPermissions
} from "../admin/group-access.js";
import { broadcastKeyInvalidation }             from "../keys/invalidation.js";
import { redisClient }                          from "../redis.js";
import { GROUP_MEMBER_PERMISSIONS, GroupPermissionError } from "../memory/groupGrants.js";
import { AUDIT_TOPIC, buildAuditPayload }           from "../logging/audit-event.js";
import { OUTBOX_INSERT_SQL }                        from "../outbox/outbox-sql.js";

export const usage = [
  "Usage: memento-mcp group <subcommand> [options]",
  "",
  "Manage API key groups and per-member permissions (local only, uses the server .env database settings).",
  "",
  "Subcommands:",
  "  list                                   List groups",
  "  create <name> [--description TEXT]     Create a group",
  "  delete <group> --confirm               Delete a group (keys and fragments stay)",
  "  members <group>                        List members and their permissions",
  "  add <group> <key> [--permissions LIST] [--shared-workspaces LIST|all]",
  "                                         Add a member (default: read,share,link, all workspaces shared)",
  "  set <group> <key> [--permissions LIST] [--shared-workspaces LIST|all]",
  "                                         Replace a member's permissions and/or shared workspaces",
  "  remove <group> <key>                   Remove a member",
  "  limit <group> <n|none>                 Set the group fragment limit (live fragments of all member keys)",
  "",
  "<group> and <key> accept an id or a name.",
  `Permissions: ${GROUP_MEMBER_PERMISSIONS.join(", ")}`,
  "  read    read fragments of members that have share",
  "  share   let members that have read see this key's fragments",
  "  link    link fragments of other members this key can read",
  "  amend   amend fragments of other members this key can read",
  "  forget  forget fragments of other members this key can read (by id only)",
  "",
  "--shared-workspaces limits what share exposes: other members read this key's fragments only when their",
  "request workspace is in the list (they then see that workspace and this key's global fragments). Default: all.",
  "",
  "Options:",
  "  --json   Print the result as JSON",
  "",
  "With Redis enabled, a running server applies the change at once; otherwise within",
  "MEMENTO_SESSION_KEY_RECHECK_MS (default 30 seconds)."
].join("\n");

/** 명령 사용 오류 */
export class GroupCliError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "GroupCliError";
  }
}

/**
 * --permissions 값("read,share" 또는 빈 문자열)을 배열로 만든다. 값이 없으면 undefined다.
 *
 * @param {unknown} raw
 * @returns {string[]|undefined}
 */
export function parsePermissionsOption(raw) {
  // iron-laws: ignore[IL-307] undefined는 옵션을 주지 않았다는 뜻이다
  if (raw === undefined) return undefined;
  // iron-laws: ignore[IL-307] 값 없이 준 옵션은 빈 목록이다
  if (raw === true) return [];
  return String(raw).split(",").map((p) => p.trim()).filter(Boolean);
}

/**
 * --shared-workspaces 값. "all"은 전체 공유(null), 그 밖은 쉼표로 나눈 목록이다. 값이 없으면 undefined다.
 *
 * @param {unknown} raw
 * @returns {string[]|null|undefined}
 */
export function parseSharedOption(raw) {
  // iron-laws: ignore[IL-307] undefined는 옵션을 주지 않았다는 뜻이다
  if (raw === undefined) return undefined;
  // iron-laws: ignore[IL-307] 값 없이 준 옵션은 빈 목록이다
  if (raw === true) return [];
  const text = String(raw).trim();
  // iron-laws: ignore[IL-307] null은 API에서 전체 공유를 뜻한다
  if (text === "all") return null;
  return text.split(",").map((w) => w.trim()).filter(Boolean);
}

/**
 * id 또는 이름으로 하나를 고른다. 이름이 여럿과 맞으면 거부한다.
 *
 * @param {Array<{ id: string, name: string }>} rows
 * @param {unknown} ref
 * @param {string} kind
 * @returns {{ id: string, name: string }}
 */
export function pickOne(rows, ref, kind) {
  if (typeof ref !== "string" || ref === "") throw new GroupCliError(`${kind} is required`);
  const byId = rows.find((r) => r.id === ref);
  if (byId) return byId;
  const byName = rows.filter((r) => r.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new GroupCliError(`${kind} name "${ref}" matches ${byName.length} entries; use the id`);
  throw new GroupCliError(`${kind} not found: ${ref}`);
}

/**
 * 공유 workspace 표시 문자열.
 *
 * @param {string[]|null|undefined} list
 * @returns {string}
 */
function sharedLabel(list) {
  if (!Array.isArray(list)) return "all";
  return list.length === 0 ? "(none)" : list.join(",");
}

/**
 * 그룹 목록의 상한 표시. 상한이 있으면 사용량과 함께 쓴다.
 *
 * @param {{ fragment_limit?: number|null, fragment_count?: number|null }} g
 * @returns {string}
 */
function limitLabel(g) {
  return g.fragment_limit == null ? "limit=none" : `fragments=${g.fragment_count ?? 0}/${g.fragment_limit}`;
}

/**
 * limit 값("none" 또는 0 이상 정수)을 읽는다.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseLimitArg(raw) {
  // iron-laws: ignore[IL-307] null은 상한 없음을 뜻한다
  if (raw === "none") return null;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  throw new GroupCliError('limit must be "none" or a non-negative integer');
}

/**
 * 감사 이벤트를 outbox에 남긴다. 실행 중인 서버의 outbox 작업자가 감사 체인에 옮긴다.
 *
 * @param {string} action
 * @param {string} groupId
 * @param {object} detail
 */
async function recordAudit(action, groupId, detail) {
  const payload = buildAuditPayload({
    action,
    actor : "system",
    target: { type: "key_group", id: groupId },
    detail: { channel: "cli", ...detail }
  });
  await getPrimaryPool().query(OUTBOX_INSERT_SQL, [AUDIT_TOPIC, `key_group:${groupId}`, JSON.stringify(payload), 0]);
}

/** CLI가 Redis에 붙었으면 연결을 닫는다. 붙지 않은 지연 연결 클라이언트는 연결 없이 끝낸다. */
async function closeRedisClient() {
  if (redisClient.status === "ready") await redisClient.quit().catch(() => redisClient.disconnect());
  else redisClient.disconnect?.();
}

/** 그룹 하나를 대상으로 하는 서브명령. (group, pos, args) → 결과 */
const GROUP_COMMANDS = {
  async members(group) {
    const members = await listGroupMembersWithPermissions(group.id);
    return { data: members, text: members.map((m) => `${m.id}  ${m.name}  ${m.permissions.join(",") || "(none)"}  shared=${sharedLabel(m.shared_workspaces)}`).join("\n") || "(no members)" };
  },
  async limit(group, pos) {
    const limit  = parseLimitArg(pos[1]);
    const result = await updateGroupFragmentLimit(group.id, limit);
    if (result.belowUsage) throw new GroupCliError(`group ${group.name} already holds ${result.used} fragments; the limit cannot be lower`);
    await broadcastKeyInvalidation(await groupMemberKeyIds(group.id));
    await recordAudit("admin.group.fragment_limit_update", group.id, { before: { fragment_limit: result.previous }, after: { fragment_limit: limit } });
    return { data: result, text: `${group.name}  limit ${result.previous ?? "none"} -> ${limit ?? "none"}  used=${result.used}` };
  },
  async delete(group, _pos, args) {
    if (args.confirm !== true) return { data: { applied: false }, text: `would delete group ${group.name} (${group.id}). Run again with --confirm to apply.` };
    const members = await groupMemberKeyIds(group.id);
    await deleteKeyGroup(group.id);
    await broadcastKeyInvalidation(members);
    await recordAudit("admin.group.delete", group.id, {});
    return { data: { applied: true, id: group.id }, text: `deleted ${group.id}` };
  }
};

/** 그룹과 멤버 키 하나를 대상으로 하는 서브명령. (group, key, args) → 결과 */
const MEMBER_COMMANDS = {
  async add(group, key, args) {
    const result = await addGroupMember(key.id, group.id, parsePermissionsOption(args.permissions), parseSharedOption(args["shared-workspaces"]));
    await broadcastKeyInvalidation(await groupMemberKeyIds(group.id));
    await recordAudit("admin.group.member_add", group.id, { memberKeyId: key.id, permissions: result.permissions, sharedWorkspaces: result.sharedWorkspaces });
    return { data: result, text: `${result.added ? "added" : "already a member:"} ${key.name}  ${result.permissions.join(",")}  shared=${sharedLabel(result.sharedWorkspaces)}` };
  },
  async set(group, key, args) {
    const perms  = parsePermissionsOption(args.permissions);
    const shared = parseSharedOption(args["shared-workspaces"]);
    if (perms === undefined && shared === undefined) throw new GroupCliError("--permissions or --shared-workspaces is required");
    const result = await setGroupMemberPermissions(group.id, key.id, { permissions: perms, sharedWorkspaces: shared });
    if (!result) throw new GroupCliError(`${key.name} is not a member of ${group.name}`);
    await broadcastKeyInvalidation(await groupMemberKeyIds(group.id));
    await recordAudit("admin.group.member_permissions", group.id, {
      memberKeyId: key.id, previous: result.previous, permissions: result.permissions,
      previousSharedWorkspaces: result.previousSharedWorkspaces, sharedWorkspaces: result.sharedWorkspaces
    });
    return { data: result, text: `${key.name}  ${result.previous.join(",") || "(none)"} -> ${result.permissions.join(",") || "(none)"}  shared=${sharedLabel(result.sharedWorkspaces)}` };
  },
  async remove(group, key) {
    const before = await groupMemberKeyIds(group.id);
    const result = await removeKeyFromGroup(key.id, group.id);
    await broadcastKeyInvalidation([...before, key.id]);
    if (result.removed) await recordAudit("admin.group.member_remove", group.id, { memberKeyId: key.id });
    return { data: result, text: result.removed ? `removed ${key.name}` : `${key.name} was not a member` };
  }
};

/**
 * 서브명령을 실행하고 출력할 결과를 돌려준다.
 *
 * @param {string} sub
 * @param {string[]} pos 서브명령 뒤의 위치 인자
 * @param {object} args
 * @returns {Promise<{ text: string, data: unknown }>}
 */
async function run(sub, pos, args) {
  if (sub === "list") {
    const groups = await listKeyGroups();
    return { data: groups, text: groups.map((g) => `${g.id}  ${g.name}  members=${g.member_count}  ${limitLabel(g)}`).join("\n") || "(no groups)" };
  }
  if (sub === "create") {
    if (!pos[0]) throw new GroupCliError("group name is required");
    const group = await createKeyGroup({ name: pos[0], description: typeof args.description === "string" ? args.description : null });
    await recordAudit("admin.group.create", group.id, {});
    return { data: group, text: `created ${group.id}  ${group.name}` };
  }
  const groupCommand  = Object.hasOwn(GROUP_COMMANDS, sub) ? GROUP_COMMANDS[sub] : null;
  const memberCommand = Object.hasOwn(MEMBER_COMMANDS, sub) ? MEMBER_COMMANDS[sub] : null;
  if (!groupCommand && !memberCommand) throw new GroupCliError(`unknown group subcommand: ${sub}`);

  const group = pickOne(await listKeyGroups(), pos[0], "group");
  if (groupCommand) return groupCommand(group, pos, args);
  return memberCommand(group, pickOne(await listApiKeys(), pos[1], "key"), args);
}

/**
 * @param {object} args parseArgs 결과
 * @param {{ out?: Function }} [deps]
 */
export default async function group(args, { out = console.log } = {}) {
  const [sub, ...pos] = args._ ?? [];
  if (!sub) throw new GroupCliError('subcommand is required. Run "memento-mcp group --help"');
  try {
    const result = await run(sub, pos.map(String), args);
    out(args.json ? JSON.stringify(result.data, null, 2) : result.text);
    return result.data;
  } catch (err) {
    if (err instanceof GroupPermissionError) throw new GroupCliError(err.message);
    throw err;
  } finally {
    await shutdownPool();
    await closeRedisClient();
  }
}
