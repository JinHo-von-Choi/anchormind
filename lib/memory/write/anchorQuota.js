/**
 * 키별 앵커 상한의 쓰기 트랜잭션 안 판정
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 쓰기 관문은 앵커 지정을 트랜잭션 밖에서 판정하므로, 같은 키의 동시 요청이 모두 상한 아래의 수를 보고
 * 통과할 수 있다. 관문은 키의 앵커 지정을 허용한 쓰기 값(생성 후보, 갱신 열)에 상한 표식을 달고,
 * 기록 경로(FragmentWriter.insertDetailed, FragmentWriter.update, BatchRememberProcessor)는 쓰기
 * 트랜잭션 안에서 키별 트랜잭션 수준 advisory 잠금을 잡은 뒤 살아 있는 앵커 수를 다시 센다.
 * 상한에 이르렀으면 표식의 exceed()를 부른다. exceed()는 warn에서 위반을 돌려주고(기록 경로가 앵커
 * 지정을 거둔다), enforce에서 SymbolicPolicyViolationError를 던진다(트랜잭션이 되돌려진다).
 *
 * 잠금 순서: api_keys 행 잠금(할당량 재확인) 다음, 파편 행 잠금과 INSERT 앞이다(docs/concurrency.md).
 * 잠금은 두 정수 키 형식(namespace, hashtext(key_id))이라 한 정수 키 advisory 잠금과 겹치지 않는다.
 */

import { getPrimaryPool }   from "../../tools/db.js";
import { buildSearchPath }  from "../../config.js";
import { SCHEMA }           from "../schema.js";
import { countLiveAnchors } from "../read/quotaQueries.js";
import { logWarn }          from "../../logger.js";

/** 앵커 상한 advisory 잠금의 첫 번째 키 */
export const ANCHOR_QUOTA_LOCK_NAMESPACE = 70321;

/** 키 하나의 앵커 상한 잠금 문장. $1은 namespace, $2는 key_id다. */
export const ANCHOR_QUOTA_LOCK_SQL = "SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))";

const QUOTAS = new WeakMap();

/**
 * 관문이 허용한 키 앵커 지정의 쓰기 값에 상한 표식을 단다. WriteGate 밖에서 부르지 않는다.
 *
 * @param {Object} value
 * @param {{keyId: string, limit: number, exceed: () => Object}} quota
 * @returns {Object} 같은 값
 */
export function attachAnchorQuota(value, quota) {
  QUOTAS.set(value, quota);
  return value;
}

/**
 * 쓰기 값의 상한 표식. 없으면 null이다.
 *
 * @param {unknown} value
 * @returns {{keyId: string, limit: number, exceed: () => Object}|null}
 */
export function anchorQuotaOf(value) {
  return typeof value === "object" && value !== null ? (QUOTAS.get(value) ?? null) : null;
}

/**
 * 키의 앵커 상한 잠금을 잡고 살아 있는 앵커 수를 센다. 열린 트랜잭션 안에서만 부른다.
 *
 * @param {{query: Function}} client
 * @param {string}            keyId
 * @returns {Promise<number>}
 */
export async function lockAndCountAnchors(client, keyId) {
  await client.query(ANCHOR_QUOTA_LOCK_SQL, [ANCHOR_QUOTA_LOCK_NAMESPACE, keyId]);
  return countLiveAnchors(client, keyId);
}

/**
 * 생성 후보 하나의 상한을 판정한다. 상한에 이르렀으면 exceed()의 위반을 후보에 싣고 앵커 지정을 거둔다.
 *
 * @param {{query: Function}} client
 * @param {Object} fragment
 * @param {{keyId: string, limit: number, exceed: () => Object}} quota
 * @returns {Promise<void>}
 */
async function applyToFragment(client, fragment, quota) {
  if (fragment.is_anchor !== true) return;
  const count = await lockAndCountAnchors(client, quota.keyId);
  if (count < quota.limit) return;
  const violation    = quota.exceed();
  fragment.is_anchor = false;
  fragment.validation_warnings = [
    ...(Array.isArray(fragment.validation_warnings) ? fragment.validation_warnings : []),
    violation
  ];
}

/**
 * 상한 표식이 달린 생성 후보를 기록한다. 호출자 트랜잭션(client)이 있으면 그 안에서, 없으면 자체
 * 트랜잭션을 열어 잠금, 재계산, 기록을 한 트랜잭션으로 실행한다.
 *
 * @template T
 * @param {{query: Function}|undefined} externalClient
 * @param {Object}  fragment
 * @param {{keyId: string, limit: number, exceed: () => Object}} quota
 * @param {(client: {query: Function}) => Promise<T>} write
 * @returns {Promise<T>}
 */
export async function insertWithAnchorQuota(externalClient, fragment, quota, write) {
  if (externalClient) {
    await applyToFragment(externalClient, fragment, quota);
    return write(externalClient);
  }
  const client = await getPrimaryPool().connect();
  try {
    await client.query(buildSearchPath(SCHEMA));
    await client.query("BEGIN");
    await applyToFragment(client, fragment, quota);
    const result = await write(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(rbErr => logWarn(`[anchorQuota] rollback failed: ${rbErr.message}`));
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 갱신 열의 상한을 판정한다. 현재 행이 앵커가 아닌데 앵커로 바꾸는 갱신이고 상한에 이르렀으면
 * exceed()를 부르고 is_anchor를 뺀 갱신 열을 돌려준다. 그 밖에는 받은 값을 그대로 돌려준다.
 * 파편 행 잠금 앞에서 부른다.
 *
 * @param {{query: Function}} client
 * @param {Object} updates
 * @param {Object|null} existing
 * @returns {Promise<Object>}
 */
export async function applyAnchorQuotaToUpdate(client, updates, existing) {
  const quota = anchorQuotaOf(updates);
  if (!quota || updates.is_anchor !== true || existing?.is_anchor === true) return updates;
  const count = await lockAndCountAnchors(client, quota.keyId);
  if (count < quota.limit) return updates;
  quota.exceed();
  const { is_anchor: _dropped, ...rest } = updates;
  return rest;
}

/**
 * 일괄 저장 항목의 상한을 입력 순서로 판정한다. 잠금은 한 번 잡고 배치 안에서 지정 수를 이어 센다.
 * 상한을 넘는 항목은 warn이면 앵커 지정을 거두고 항목 결과에 경고를 싣고, enforce이면 항목 결과를
 * 실패로 바꾸고 validFragments에서 뺀다(배열을 제자리에서 고친다).
 *
 * @param {{query: Function}} client
 * @param {Array<{index: number, fragment: Object}>} validFragments
 * @param {Array<Object>} results
 * @returns {Promise<void>}
 */
export async function applyAnchorQuotaToBatch(client, validFragments, results) {
  const marked = validFragments.filter(item => item.fragment.is_anchor === true && anchorQuotaOf(item.fragment));
  if (marked.length === 0) return;

  const { keyId, limit } = anchorQuotaOf(marked[0].fragment);
  let   count            = await lockAndCountAnchors(client, keyId);
  const rejected         = new Set();
  for (const item of marked) {
    if (count < limit) { count++; continue; }
    try {
      const violation         = anchorQuotaOf(item.fragment).exceed();
      item.fragment.is_anchor = false;
      const result            = results[item.index];
      result.validation_warnings = [...(result.validation_warnings ?? []), violation.rule];
    } catch (err) {
      results[item.index] = { index: item.index, id: null, success: false, error: err.message };
      rejected.add(item);
    }
  }
  for (let i = validFragments.length - 1; i >= 0; i--) {
    if (rejected.has(validFragments[i])) validFragments.splice(i, 1);
  }
}
