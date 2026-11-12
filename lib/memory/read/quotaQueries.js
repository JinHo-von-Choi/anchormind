/**
 * 할당량 회계 질의
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 키가 보유한 파편 수를 세는 질의가 여섯 곳에 복제돼 있었다. 관리 콘솔, 할당량
 * 검사기, 일괄 저장, 단건 저장이 각자 같은 SQL을 들고 있어 한도 판정 기준이
 * 갈릴 여지가 있었다.
 *
 * FragmentReader가 아니라 별도 잎 모듈에 둔다. 관리 계층이 파편 수를 세자고
 * 읽기 계층 전체를 끌어올 이유가 없다. 이 파일은 스키마 이름과 질의 실행기에만
 * 의존한다.
 *
 * 회계는 키 범위와 무관하게 전체 행을 세야 하므로 풀로 보내는 질의는 system 주체로 실행한다
 * (lib/tools/row-scope.js). 트랜잭션 클라이언트를 받으면 그 트랜잭션의 주체를 따른다.
 */

import { SCHEMA } from "../schema.js";
import { queryScoped, ROW_SUBJECT } from "../../tools/row-scope.js";

/**
 * 키가 보유한 유효 파편 수를 센다.
 *
 * 격리가 아니라 회계다. 그룹 공유를 보지 않고 키 자신의 파편만 센다. 할당량은
 * 키 단위로 부여되므로 그룹 파편까지 세면 남의 사용량이 내 한도를 잠식한다.
 *
 * 실행기를 인자로 받는 이유는 호출부 넷이 `FOR UPDATE` 잠금을 건 트랜잭션
 * 안에서 이 수를 세야 하기 때문이다. 풀에서 새 커넥션을 잡으면 그 잠금 밖이라
 * 동시 요청이 한도를 넘길 수 있다.
 *
 * @param {{query: Function}} executor 커넥션 풀 또는 트랜잭션 클라이언트
 * @param {string}            keyId
 * @returns {Promise<number>}
 */
export async function countLiveFragments(executor, keyId) {
  return countKeyRows(executor, keyId, "");
}

/**
 * 키 자신의 유효 파편 가운데 추가 조건을 만족하는 행 수. 조건은 이 모듈의 고정 문자열만 받는다.
 *
 * @param {{query: Function}} executor
 * @param {string}            keyId
 * @param {string}            extraCondition 앞에 AND를 붙인 고정 조건 또는 빈 문자열
 * @returns {Promise<number>}
 */
async function countKeyRows(executor, keyId, extraCondition) {
  const { rows } = await queryScoped(executor,
    `SELECT COUNT(*)::int AS count FROM ${SCHEMA}.fragments
      WHERE key_id = $1 AND valid_to IS NULL${extraCondition}`,
    [keyId],
    ROW_SUBJECT.SYSTEM
  );
  return rows[0]?.count ?? 0;
}

/**
 * 키가 보유한 살아 있는 앵커 수를 센다. 키별 앵커 상한(MEMENTO_ANCHOR_LIMIT_PER_KEY)의 회계다.
 * countLiveFragments와 같이 그룹 공유를 보지 않고 키 자신의 앵커만 센다.
 *
 * @param {{query: Function}} executor 커넥션 풀 또는 트랜잭션 클라이언트
 * @param {string}            keyId
 * @returns {Promise<number>}
 */
export async function countLiveAnchors(executor, keyId) {
  return countKeyRows(executor, keyId, " AND is_anchor = TRUE");
}

/**
 * 키가 속한 그룹 가운데 파편 상한(api_key_groups.fragment_limit, migration-077)이 있는 그룹과 그 멤버 키 전체의
 * 살아 있는 파편 수. 상한이 있는 그룹만 돌려준다. 열이 아직 없는 설치에서도 오류 없이 빈 배열이 되도록 행을
 * jsonb로 바꿔 읽는다.
 *
 * lock이 true면 그룹 행을 id 순으로 FOR UPDATE 잠근다. 같은 그룹의 두 멤버가 동시에 저장해도 한쪽이 기다린다.
 * 키 행 잠금(api_keys FOR UPDATE)을 먼저 잡은 뒤 부른다. 잠금 순서는 언제나 키 행 → 그룹 행(id 순)이다.
 *
 * @param {{query: Function}} executor
 * @param {string}            keyId
 * @param {{ lock?: boolean }} [opts]
 * @returns {Promise<Array<{ groupId: string, name: string, limit: number, current: number }>>}
 */
export async function groupQuotaUsage(executor, keyId, { lock = false } = {}) {
  const { rows: groups } = await executor.query(
    `SELECT g.id, g.name, (to_jsonb(g) ->> 'fragment_limit')::int AS fragment_limit
       FROM ${SCHEMA}.api_key_groups g
       JOIN ${SCHEMA}.api_key_group_members m ON m.group_id = g.id
      WHERE m.key_id = $1
        AND to_jsonb(g) ->> 'fragment_limit' IS NOT NULL
      ORDER BY g.id${lock ? "\n        FOR UPDATE OF g" : ""}`,
    [keyId]
  );
  const out = [];
  for (const g of groups) {
    out.push({ groupId: String(g.id), name: g.name, limit: g.fragment_limit, current: await countGroupLiveFragments(executor, g.id) });
  }
  return out;
}

/**
 * 그룹 멤버 키 전체의 살아 있는 파편 수. 그룹 파편 상한의 회계다.
 *
 * @param {{query: Function}} executor
 * @param {string} groupId
 * @returns {Promise<number>}
 */
export async function countGroupLiveFragments(executor, groupId) {
  const { rows } = await queryScoped(executor,
    `SELECT COUNT(*)::int AS count FROM ${SCHEMA}.fragments
      WHERE valid_to IS NULL
        AND key_id IN (SELECT key_id FROM ${SCHEMA}.api_key_group_members WHERE group_id = $1)`,
    [groupId],
    ROW_SUBJECT.SYSTEM
  );
  return rows[0]?.count ?? 0;
}

/**
 * 키 상한과 그룹 상한 가운데 남은 수가 가장 적은 것. 상한이 하나도 없으면 null이다.
 *
 * @param {number|null} keyLimit
 * @param {number}      keyCurrent
 * @param {Array<{ groupId: string, name: string, limit: number, current: number }>} groups
 * @returns {{ scope: "key"|"group", limit: number, current: number, remaining: number, groupId?: string, groupName?: string }|null}
 */
export function tightestQuota(keyLimit, keyCurrent, groups) {
  const candidates = [];
  if (keyLimit !== null && keyLimit !== undefined) {
    candidates.push({ scope: "key", limit: keyLimit, current: keyCurrent, remaining: Math.max(0, keyLimit - keyCurrent) });
  }
  for (const g of groups) {
    candidates.push({
      scope: "group", limit: g.limit, current: g.current, remaining: Math.max(0, g.limit - g.current),
      groupId: g.groupId, groupName: g.name
    });
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((min, c) => (c.remaining < min.remaining ? c : min));
}

/**
 * 저장 트랜잭션 안에서 키 행과 상한 있는 그룹 행을 잠그고 남은 할당량을 판정한다. 단건 저장, 할당량 검사기,
 * 일괄 저장의 두 단계가 모두 이 판정을 쓴다. 상한이 없으면 null이다.
 *
 * @param {{query: Function}} client 트랜잭션 클라이언트
 * @param {string}            keyId
 * @returns {Promise<ReturnType<typeof tightestQuota>>}
 */
export async function lockQuota(client, keyId) {
  const { rows: [keyRow] } = await client.query(
    `SELECT fragment_limit FROM ${SCHEMA}.api_keys WHERE id = $1 FOR UPDATE`,
    [keyId]
  );
  const keyLimit   = keyRow?.fragment_limit ?? null;
  const keyCurrent = keyLimit === null ? 0 : await countLiveFragments(client, keyId);
  const groups     = await groupQuotaUsage(client, keyId, { lock: true });
  return tightestQuota(keyLimit, keyCurrent, groups);
}

/**
 * 할당량 초과 오류. code는 키 상한과 그룹 상한 모두 fragment_limit_exceeded이고, scope와 groupId로 구분한다.
 *
 * @param {NonNullable<ReturnType<typeof tightestQuota>>} quota
 * @returns {Error & { code: string, current: number, limit: number, scope: string, groupId?: string }}
 */
export function quotaExceededError(quota) {
  const err = new Error(quota.scope === "group"
    ? `Group fragment limit reached for group "${quota.groupName}" (${quota.current}/${quota.limit}). Delete unused fragments or ask an administrator to raise the group limit.`
    : `Fragment limit reached (${quota.current}/${quota.limit}). Delete unused fragments or request a higher limit.`);
  err.code    = "fragment_limit_exceeded";
  err.current = quota.current;
  err.limit   = quota.limit;
  err.scope   = quota.scope;
  if (quota.groupId) err.groupId = quota.groupId;
  return err;
}
