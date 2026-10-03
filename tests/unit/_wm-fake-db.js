/**
 * 작업 기억 행 시험용 메모리 DB 대역
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * WorkingMemoryRows가 보내는 네 가지 문장(조회, id 지정 삭제, 세션 삭제, 만료 삭제)의 의미만
 * 흉내 낸다. 문장 종류는 SQL의 모양으로, 조건 값은 매개변수로 읽는다. 실제 SQL의 동작은
 * tests/db-concurrency의 작업 기억 시험이 일회용 DB에서 확인한다.
 */

/**
 * @returns {{
 *   rows: Object[],
 *   calls: Array<{sql: string, params: unknown[]}>,
 *   queryWithAgentVector: Function,
 *   insertFragment: (fragment: Object) => string
 * }}
 */
export function createFakeWmDb() {
  const rows  = [];
  const calls = [];

  /** FragmentWriter.insert가 기록하는 열 가운데 작업 기억 행이 쓰는 것만 담는다. */
  function insertFragment(fragment) {
    const hash = `${fragment.hash_scope ?? ""}\n${fragment.content}`;
    const dup  = rows.find(r => r.content_hash === hash && r.key_id === (fragment.key_id ?? null));
    if (dup) return dup.id;
    rows.push({
      id              : fragment.id,
      content         : fragment.content,
      content_hash    : hash,
      type            : fragment.type,
      topic           : fragment.topic,
      agent_id        : fragment.agent_id,
      workspace       : fragment.workspace ?? null,
      key_id          : fragment.key_id ?? null,
      importance      : fragment.importance,
      estimated_tokens: fragment.estimated_tokens,
      session_id      : fragment.session_id ?? null,
      source          : fragment.source ?? null,
      ttl_tier        : fragment.ttl_tier,
      valid_to        : fragment.valid_to ?? null,
      created_at      : new Date(fragment.created_at ?? Date.now())
    });
    return fragment.id;
  }

  async function queryWithAgentVector(_agent, sql, params = []) {
    calls.push({ sql, params });
    const isSelect = /^\s*SELECT/i.test(sql);
    if (isSelect) {
      const [sessionId, source, cutoff] = params;
      const found = rows
        .filter(r => r.session_id === sessionId && r.source === source
          && r.valid_to !== null && r.created_at.getTime() > Date.parse(cutoff))
        .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
      return { rows: found.map(r => ({ ...r })), rowCount: found.length };
    }

    let doomed;
    if (/id = ANY/.test(sql)) {
      const [sessionId, source, ids] = params;
      doomed = rows.filter(r => r.session_id === sessionId && r.source === source
        && r.valid_to !== null && ids.includes(r.id));
    } else if (/created_at </.test(sql)) {
      const [source, cutoff] = params;
      doomed = rows.filter(r => r.source === source && r.valid_to !== null
        && r.session_id !== null && r.created_at.getTime() < Date.parse(cutoff));
    } else {
      const [sessionId, source] = params;
      doomed = rows.filter(r => r.session_id === sessionId && r.source === source && r.valid_to !== null);
    }
    for (const r of doomed) rows.splice(rows.indexOf(r), 1);
    return { rows: [], rowCount: doomed.length };
  }

  return { rows, calls, queryWithAgentVector, insertFragment };
}
