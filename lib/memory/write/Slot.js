/**
 * Slot - 현재 값 슬롯
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * remember의 slot("주체.속성")은 값이 바뀌는 사실의 자리다. 같은 키, workspace, agent의 같은 슬롯에 새 값이 오면
 * 이전 값을 자동으로 대체한다(valid_to, superseded_by). 판정을 임베딩 유사도에 맡기지 않는다. 슬롯은 키워드
 * slot:<이름>으로 저장해 키워드 색인(L1, L2)으로 찾는다. recall의 slot은 이 키워드를 검색어에 더하고 의도를 state로 둔다.
 *
 * 순수 함수와 SQL 조각만 둔다.
 */

import { SCHEMA } from "../schema.js";

/** 슬롯 이름 최대 길이 */
export const SLOT_MAX_LENGTH = 128;

/** 슬롯 키워드 접두어 */
export const SLOT_KEYWORD_PREFIX = "slot:";

/**
 * 슬롯 이름을 정규화한다. 앞뒤 공백을 지우고 소문자로 바꾸며 안쪽 공백은 밑줄로 바꾼다. 비거나 길면 null이다.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeSlot(raw) {
  if (typeof raw !== "string") return null;
  const slot = raw.trim().toLowerCase().replace(/\s+/g, "_");
  return slot === "" || slot.length > SLOT_MAX_LENGTH ? null : slot;
}

/**
 * 슬롯의 키워드.
 *
 * @param {string} slot - normalizeSlot 결과
 * @returns {string}
 */
export function slotKeyword(slot) {
  return `${SLOT_KEYWORD_PREFIX}${slot}`;
}

/**
 * 키워드 목록에 슬롯 키워드를 더한다(중복 없음).
 *
 * @param {unknown} keywords
 * @param {string} slot
 * @returns {string[]}
 */
export function withSlotKeyword(keywords, slot) {
  const list = Array.isArray(keywords) ? keywords.filter(k => typeof k === "string") : [];
  const kw   = slotKeyword(slot);
  return list.includes(kw) ? list : [...list, kw];
}

/**
 * recall 인자의 slot을 검색어로 바꾼다. 슬롯 키워드를 keywords에 더하고 intent가 없으면 state로 둔다. 같은 인자에
 * 여러 번 불러도 결과가 같다. slot이 없거나 형식에 맞지 않으면 인자를 바꾸지 않는다.
 *
 * @param {Object} args - recall 인자(바꾼다)
 * @returns {Object} args
 */
export function applySlotQuery(args) {
  const slot = normalizeSlot(args?.slot);
  if (slot === null) return args;
  args.keywords = withSlotKeyword(args.keywords, slot);
  args.intent ??= "state";
  return args;
}

/**
 * 새 파편($1)과 같은 범위(key_id, workspace, agent_id)의 같은 slot($2 슬롯 키워드) 열린 파편 가운데, 가장 늦게
 * 저장된 하나(저장 시각, 같으면 id 순)를 뺀 나머지 id와 그 가장 늦은 파편 id(latest_id). 새 파편 자신도 대상이다.
 *
 * 쓰기마다 자기 행을 커밋한 뒤 이 조회로 가장 늦은 값 하나만 남긴다. 두 값이 동시에 저장돼도 나중에 실행된
 * 조회는 두 행을 모두 보므로 열린 값이 하나로 줄어든다.
 */
export const STALE_SLOT_VALUES_SQL = `
  WITH scope AS (
    SELECT o.id, o.created_at
      FROM ${SCHEMA}.fragments o
      JOIN ${SCHEMA}.fragments n ON n.id = $1
     WHERE o.keywords @> ARRAY[$2]::text[]
       AND o.valid_to IS NULL
       AND o.key_id    IS NOT DISTINCT FROM n.key_id
       AND o.workspace IS NOT DISTINCT FROM n.workspace
       AND o.agent_id  = n.agent_id
  ), latest AS (
    SELECT id FROM scope ORDER BY created_at DESC, id DESC LIMIT 1
  )
  SELECT s.id, (SELECT id FROM latest) AS latest_id
    FROM scope s
   WHERE s.id <> (SELECT id FROM latest)
   ORDER BY s.created_at, s.id`;
