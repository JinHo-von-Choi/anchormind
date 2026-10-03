/**
 * importRuntime - 가져오기 실행 의존성
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * admin 가져오기와 CLI 가져오기가 쓰는 관문, 쓰기 객체, 링크 저장소, 프로필을 한곳에서 만든다.
 * 서버 로거와 메모리 모듈은 가져오기를 실행할 때만 불러오도록 동적 import를 쓴다. 두 진입점은
 * 모두 소유자 경로다(관리 API는 마스터 인증, CLI는 서버 호스트의 DB 계정).
 */

import { SCHEMA } from "../schema.js";

/**
 * @param {"admin"|"cli"} kind
 * @param {Object}        [options]
 * @param {string|null}   [options.keyId=null]   - 기록할 대상 키. null은 마스터 범위
 * @param {boolean}       [options.restore=false] - 저장된 값을 되살리는 가져오기
 * @returns {Promise<{profile: Object, entry: string, gate: Object, writer: Object, linkStore: Object, withTransaction: Function}>}
 */
export async function loadImportRuntime(kind, { keyId = null, restore = false } = {}) {
  const [{ importProfile, IMPORT_DEFAULTS }, { WriteGate, WRITE_ENTRIES, RESTORE_STEPS }, { FragmentWriter }, { LinkStore }, { withTransaction }] =
    await Promise.all([
      import("../write/FragmentImporter.js"),
      import("../write/WriteGate.js"),
      import("../write/FragmentWriter.js"),
      import("../link/LinkStore.js"),
      import("../../tools/db.js")
    ]);

  const steps   = restore ? RESTORE_STEPS : {};
  const profile = importProfile(IMPORT_DEFAULTS[kind], { keyId, owner: true, restore });

  let gate;
  if (kind === "admin") {
    const { createServerWriteGate } = await import("../write/serverWriteGate.js");
    gate = createServerWriteGate({ steps });
  } else {
    gate = new WriteGate({ steps });
  }

  return {
    profile,
    entry    : kind === "admin" ? WRITE_ENTRIES.ADMIN_IMPORT : WRITE_ENTRIES.CLI_IMPORT,
    gate,
    writer   : new FragmentWriter(),
    linkStore: new LinkStore(),
    withTransaction
  };
}

/**
 * 대상 키가 api_keys에 있는지 확인한다.
 *
 * @param {{ query: Function }} pool
 * @param {string} keyId
 * @returns {Promise<boolean>}
 */
export async function targetKeyExists(pool, keyId) {
  const { rows } = await pool.query(`SELECT 1 FROM ${SCHEMA}.api_keys WHERE id = $1`, [keyId]);
  return rows.length > 0;
}
