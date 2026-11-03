-- migration-075-drop-unused-valid-from-indexes.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-04
--
-- migration-001이 만든 valid_from 색인 둘을 지운다.
--   (valid_from)                               단일 열
--   (agent_id, valid_from) WHERE valid_to IS NULL
-- valid_from을 조건으로 쓰는 질의는 시점 조회(FragmentReader.searchAsOf) 하나이고, 이 질의는
-- valid_to IS NULL OR valid_to > 시각 조건과 키·agent 조건을 함께 써서 두 색인이 맞지 않는다. 운영 통계에서
-- 단일 열 색인은 사용 0회, 복합 색인은 9회였다. 파편을 쓰고 고칠 때마다 두 색인도 갱신되므로 쓰기 비용만 든다.
-- 이름은 설치마다 다를 수 있어(idx_fragments_valid_from, fragments_new_valid_from_idx 등) 정의로 찾는다.
--
-- 다른 질의가 잡은 잠금을 오래 기다리지 않게 lock_timeout을 둔다. 시간 안에 못 잡으면 실패하고
-- 적용 이력에 남지 않으므로 다시 실행한다.
-- 멱등: 대상 색인이 없으면 아무것도 지우지 않는다.

SET LOCAL lock_timeout = '3s';

DO $$ DECLARE idx record; BEGIN
  FOR idx IN
    SELECT ns.nspname AS schema_name, ic.relname AS index_name
      FROM pg_index i
      JOIN pg_class ic     ON ic.oid = i.indexrelid
      JOIN pg_class tc     ON tc.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = tc.relnamespace
     WHERE ns.nspname = 'agent_memory'
       AND tc.relname = 'fragments'
       AND NOT i.indisunique
       AND i.indexprs IS NULL
       AND (
             (i.indnatts = 1
              AND i.indpred IS NULL
              AND (SELECT attname FROM pg_attribute WHERE attrelid = tc.oid AND attnum = i.indkey[0]) = 'valid_from')
          OR (i.indnatts = 2
              AND (SELECT attname FROM pg_attribute WHERE attrelid = tc.oid AND attnum = i.indkey[0]) = 'agent_id'
              AND (SELECT attname FROM pg_attribute WHERE attrelid = tc.oid AND attnum = i.indkey[1]) = 'valid_from')
           )
  LOOP
    EXECUTE format('DROP INDEX %I.%I', idx.schema_name, idx.index_name);
  END LOOP;
END $$;
