/**
 * 중복 판정 색인 대역
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * FragmentWriter와 BatchRememberProcessor가 보내는 질의 중 중복 판정에 관계된 것만 흉내 낸다.
 * 유일 색인 집합(indexes: 유효, invalid: indisvalid가 내려갔지만 유일성은 강제하는 색인)을 정해 두면
 * PostgreSQL처럼
 *   - ON CONFLICT 대상 색인이 유효 색인에 없으면 42P10
 *   - 대상 색인과 충돌하면 기존 행을 병합(importance 큰 값, is_anchor OR)하고 기존 id 반환
 *   - 대상이 아닌 색인과 충돌하면 그 색인 이름을 담은 23505
 *   - 한 문장이 같은 기존 행을 두 번 고치면 21000
 *   - 트랜잭션 안의 오류 뒤에는 ROLLBACK 또는 ROLLBACK TO SAVEPOINT 전까지 25P02
 * 로 응답한다. 문장 하나는 원자적으로 적용한다.
 */

import { DEDUP_INDEXES } from "../../lib/memory/write/DedupScope.js";

const ws = (w) => (w == null ? "" : String(w));

/** 색인별 행 키. 해당 경로(키 보유, 마스터)가 아니면 null */
const INDEX_KEYS = {
  [DEDUP_INDEXES.keyLegacy]   : r => (r.key_id != null ? `${r.key_id}|${r.content_hash}` : null),
  [DEDUP_INDEXES.masterLegacy]: r => (r.key_id == null ? r.content_hash : null),
  [DEDUP_INDEXES.keyScoped]   : r => (r.key_id != null ? `${r.key_id}|${r.content_hash}|${ws(r.workspace)}` : null),
  [DEDUP_INDEXES.masterScoped]: r => (r.key_id == null ? `${r.content_hash}|${ws(r.workspace)}` : null)
};

const TARGETS = [
  ["ON CONFLICT (key_id, content_hash) WHERE key_id IS NOT NULL", DEDUP_INDEXES.keyLegacy],
  ["ON CONFLICT (content_hash) WHERE key_id IS NULL", DEDUP_INDEXES.masterLegacy],
  ["ON CONFLICT (key_id, content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NOT NULL", DEDUP_INDEXES.keyScoped],
  ["ON CONFLICT (content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NULL", DEDUP_INDEXES.masterScoped]
];

function pgError(code, message, constraint) {
  const err = new Error(message);
  err.code  = code;
  if (constraint) err.constraint = constraint;
  return err;
}

/**
 * INSERT 바인딩에서 행을 읽는다. 단건(FragmentWriter)은 32열, batch는 24열이고, 출처 열
 * (origin, observed_client, trust_tier)이 붙은 문장은 행마다 3열이 더 있다.
 */
function insertedRows(sql, params) {
  const stride = (sql.includes("idempotency_key") ? 32 : 24) + (sql.includes("trust_tier") ? 3 : 0);
  const rows   = [];
  for (let i = 0; i < params.length; i += stride) {
    const p = params.slice(i, i + stride);
    rows.push({ id: p[0], importance: p[5], content_hash: p[6], key_id: p[13], is_anchor: p[14], workspace: p[17] });
  }
  return rows;
}

/**
 * @param {{ indexes: string[], invalid?: string[], rows?: Object[] }} opts
 */
export function makeFakeDb({ indexes, invalid = [], rows = [] }) {
  const db = {
    rows      : rows.map(r => ({ importance: 0.5, is_anchor: false, workspace: null, ...r })),
    indexes   : new Set(indexes),
    invalid   : new Set(invalid),
    statements: [],
    inTx      : false,
    aborted   : false
  };

  const enforced    = () => [...db.indexes, ...db.invalid];
  const conflictsOn = (index, row, exceptId) => {
    const key = INDEX_KEYS[index](row);
    if (key === null) return null;
    return db.rows.find(r => r.id !== exceptId && INDEX_KEYS[index](r) === key) ?? null;
  };

  function insert(sql, params) {
    let arbiter = null;
    if (sql.includes("ON CONFLICT")) {
      const hit = TARGETS.find(([text]) => sql.includes(text));
      if (!hit || !db.indexes.has(hit[1])) {
        throw pgError("42P10", "there is no unique or exclusion constraint matching the ON CONFLICT specification");
      }
      arbiter = hit[1];
    }
    const staged  = [];
    const touched = new Set();
    const out     = [];
    const visible = () => [...db.rows, ...staged];
    for (const row of insertedRows(sql, params)) {
      const key      = arbiter ? INDEX_KEYS[arbiter](row) : null;
      const existing = key === null ? null : visible().find(r => INDEX_KEYS[arbiter](r) === key);
      if (existing) {
        if (touched.has(existing.id)) throw pgError("21000", "ON CONFLICT DO UPDATE command cannot affect row a second time");
        touched.add(existing.id);
        existing.importance = Math.max(existing.importance, row.importance);
        existing.is_anchor  = existing.is_anchor || row.is_anchor;
        out.push({ id: existing.id });
        continue;
      }
      for (const index of enforced()) {
        const k = INDEX_KEYS[index](row);
        if (k !== null && visible().some(r => INDEX_KEYS[index](r) === k)) {
          throw pgError("23505", `duplicate key value violates unique constraint "${index}"`, index);
        }
      }
      staged.push({ ...row });
      out.push({ id: row.id });
    }
    db.rows.push(...staged);
    return { rows: out, rowCount: out.length };
  }

  function updateContent(sql, params) {
    const row   = db.rows.find(r => r.id === params[0]);
    const match = /content_hash = \$(\d+)/.exec(sql);
    if (!row) return { rows: [] };
    if (match) {
      const next = { ...row, content_hash: params[Number(match[1]) - 1] };
      for (const index of enforced()) {
        if (conflictsOn(index, next, row.id)) {
          throw pgError("23505", `duplicate key value violates unique constraint "${index}"`, index);
        }
      }
      row.content_hash = next.content_hash;
    }
    return { rows: [{ ...row }] };
  }

  function lookup(sql, params) {
    const hashes    = params[0];
    const keyId     = sql.includes("key_id IS NULL") ? null : params[1];
    const excludeId = sql.includes("id <> $") ? params.at(-1) : null;
    return {
      rows: db.rows
        .filter(r => hashes.includes(r.content_hash) && (r.key_id ?? null) === keyId && r.id !== excludeId)
        .map(r => ({ id: r.id, workspace: r.workspace, content_hash: r.content_hash }))
    };
  }

  function run(sql, params = []) {
    const text = String(sql).trim();
    db.statements.push(text);

    if (text === "BEGIN")    { db.inTx = true; db.aborted = false; return { rows: [] }; }
    if (text === "COMMIT" || text === "ROLLBACK") { db.inTx = false; db.aborted = false; return { rows: [] }; }
    if (text.startsWith("ROLLBACK TO SAVEPOINT")) { db.aborted = false; return { rows: [] }; }
    if (db.aborted) throw pgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
    if (text.startsWith("SAVEPOINT") || text.startsWith("RELEASE SAVEPOINT") || text.startsWith("SET ")) return { rows: [] };

    if (text.includes("pg_index")) {
      return { rows: [...[...db.indexes].map(name => ({ name, valid: true })), ...[...db.invalid].map(name => ({ name, valid: false }))] };
    }
    if (text.startsWith("SELECT id, workspace, content_hash")) return lookup(text, params);
    if (/FROM agent_memory\.fragments WHERE id = \$1 FOR UPDATE/.test(text)) {
      return { rows: db.rows.filter(r => r.id === params[0]).map(r => ({ agent_id: "default", ...r })) };
    }
    if (/^INSERT INTO agent_memory\.fragments\s/.test(text)) return insert(text, params);
    if (/^UPDATE agent_memory\.fragments\s/.test(text))      return updateContent(text, params);
    return { rows: [] };
  }

  db.query = async (sql, params) => {
    try {
      return run(sql, params);
    } catch (err) {
      if (db.inTx) db.aborted = true;
      throw err;
    }
  };

  db.client = () => ({ query: db.query, release: () => {} });
  db.pool   = () => ({ connect: async () => db.client() });
  db.byId   = (id) => db.rows.find(r => r.id === id) ?? null;
  return db;
}
