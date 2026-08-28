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
 * 읽기 계층 전체를 끌어올 이유가 없다. 이 파일은 스키마 이름 외에 아무것도
 * 의존하지 않는다.
 */

import { SCHEMA } from "../schema.js";

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
  const { rows } = await executor.query(
    `SELECT COUNT(*)::int AS count FROM ${SCHEMA}.fragments
      WHERE key_id = $1 AND valid_to IS NULL`,
    [keyId]
  );
  return rows[0]?.count ?? 0;
}
