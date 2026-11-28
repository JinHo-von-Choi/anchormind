import { SCHEMA } from "../schema.js";

// 비활성화된 정책이나 누락된 마이그레이션도 점검에 남도록 대상 테이블을 명시한다.
const REQUIRED_TABLES = [
  "fragment_digest", "fragment_lineage", "fragment_links", "fragment_segment",
  "fragment_synthetic_query", "fragment_use_events", "fragments", "idempotency_records",
  "lesson_outcomes", "tool_feedback_fragments"
];

/** 현재 연결 역할의 RLS 적용 여부와 소유·우회 권한을 읽는다. */
export async function inspectRuntimeRls(pool) {
  const { rows } = await pool.query({
    text: `
      WITH runtime AS (
        SELECT EXISTS (
          SELECT 1 FROM pg_roles r
           WHERE (r.rolsuper OR r.rolbypassrls)
             AND pg_has_role(current_user, r.oid, 'MEMBER')
        ) AS elevated
      )
      SELECT c.relname AS table,
             pg_has_role(current_user, c.relowner, 'MEMBER') AS owner,
             row_security_active(c.oid) AS active,
             c.relforcerowsecurity AS forced,
             current_setting('app.require_row_scope', true) = 'on' AS scope_required,
             EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                       AND p.polname = 'required_row_scope' AND NOT p.polpermissive
                       AND p.polcmd = '*' AND 0 = ANY(p.polroles)) AS scope_policy,
             NOT EXISTS (
               SELECT 1 FROM (VALUES ('r'), ('a'), ('w'), ('d')) AS required(cmd)
                WHERE NOT EXISTS (
                  SELECT 1 FROM pg_policy p
                   WHERE p.polrelid = c.oid AND p.polpermissive
                     AND p.polcmd IN ('*', required.cmd::"char")
                     AND EXISTS (
                       SELECT 1 FROM unnest(p.polroles) AS roles(role_id)
                        WHERE CASE WHEN role_id = 0 THEN true
                              ELSE pg_has_role(current_user, role_id, 'USAGE') END
                     )
                )
             ) AS has_policy,
             runtime.elevated
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN runtime
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
         AND (c.relname = ANY($2::name[]) OR c.relrowsecurity)
       ORDER BY c.relname`,
    values: [SCHEMA, REQUIRED_TABLES],
    query_timeout: 5_000
  });
  const missing = REQUIRED_TABLES.filter(name => !rows.some(row => row.table === name));
  const ok = missing.length === 0 && rows.every(row =>
    row.active === true && row.has_policy === true && row.owner === false && row.elevated === false
      && (row.scope_required !== true || !REQUIRED_TABLES.includes(row.table) || row.scope_policy === true)
  );
  return { ok, missing, tables: rows };
}
