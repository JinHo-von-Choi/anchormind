-- migration-072-fragments-access-hot.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-31
--
-- recall은 결과 파편마다 access_count, accessed_at, ema_activation, ema_last_updated를 갱신한다.
-- access_count와 ema_activation에 색인이 있으면 이 갱신은 HOT이 될 수 없어 fragments의 모든 색인
-- (HNSW 포함)에 새 항목이 들어간다. 두 열의 단일 열 색인을 지운다. 이름은 설치마다 다를 수 있어
-- 정의(fragments 표의 비유일 단일 열 색인, 열이 access_count 또는 ema_activation)로 찾는다.
--
-- HOT 갱신은 같은 페이지에 빈 공간이 있어야 하므로 fillfactor를 90으로 둔다. 새로 쓰는 페이지부터
-- 적용된다. 기존 페이지에 적용하려면 표를 다시 써야 한다(pg_repack 등, 점검 시간에 따로 실행).
--
-- 다른 질의가 잡은 잠금을 오래 기다리지 않게 lock_timeout을 둔다. 시간 안에 못 잡으면 실패하고
-- 적용 이력에 남지 않으므로 다시 실행한다.
-- 멱등: 대상 색인이 없으면 아무것도 지우지 않고, fillfactor 설정은 같은 값을 다시 써도 된다.

SET LOCAL lock_timeout = '3s';

DO $$ DECLARE idx record; BEGIN
  FOR idx IN
    SELECT ns.nspname AS schema_name, ic.relname AS index_name
      FROM pg_index i
      JOIN pg_class ic     ON ic.oid = i.indexrelid
      JOIN pg_class tc     ON tc.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = tc.relnamespace
      JOIN pg_attribute a  ON a.attrelid = tc.oid AND a.attnum = i.indkey[0]
     WHERE ns.nspname = 'agent_memory'
       AND tc.relname = 'fragments'
       AND i.indnatts = 1
       AND NOT i.indisunique
       AND a.attname IN ('access_count', 'ema_activation')
  LOOP
    EXECUTE format('DROP INDEX %I.%I', idx.schema_name, idx.index_name);
  END LOOP;
END $$;

ALTER TABLE agent_memory.fragments SET (fillfactor = 90);
