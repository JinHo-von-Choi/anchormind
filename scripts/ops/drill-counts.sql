-- 복구 훈련 행 수 질의
--
-- 작성자: 최진호
-- 작성일: 2026-10-03
--
-- agent_memory 스키마의 모든 표의 정확한 행 수, schema_migrations의 최대 파일 이름,
-- HNSW 색인 수와 유효 색인 수를 한 줄 JSON으로 돌려준다. 행 내용은 읽지 않는다.
-- backup.sh가 덤프와 같은 스냅숏에서 실행해 매니페스트로 남기고, restore-verify.mjs가
-- 복구본에서 같은 질의를 실행해 대조한다.

SELECT json_build_object(
  'tables', (
    SELECT COALESCE(json_object_agg(t.table_name, t.row_count ORDER BY t.table_name), '{}'::json)
      FROM (
        SELECT c.relname AS table_name,
               (xpath('/row/c/text()',
                      query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')
               ))[1]::text::bigint AS row_count
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'agent_memory'
           AND c.relkind IN ('r', 'p')
           AND NOT c.relispartition
      ) t
  ),
  'schemaMigrationsMax', (SELECT max(filename) FROM agent_memory.schema_migrations),
  'hnsw', (
    SELECT json_build_object('total', count(*), 'valid', count(*) FILTER (WHERE i.indisvalid))
      FROM pg_index i
      JOIN pg_class ic     ON ic.oid = i.indexrelid
      JOIN pg_namespace n  ON n.oid = ic.relnamespace
      JOIN pg_am am        ON am.oid = ic.relam
     WHERE n.nspname = 'agent_memory'
       AND am.amname = 'hnsw'
  )
)::text;
