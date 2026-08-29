-- migration-045-fragment-rls.sql
--
-- 작성자: 최진호
-- 작성일: 2026-08-29
--
-- fragments와 fragment_links에 행 수준 보안을 켜고 격리 정책을 건다.
--
-- 배경: memory-schema.sql은 fragments에 RLS를 켜도록 선언하고 있으나, 마이그레이션
-- 누적으로 자라난 데이터베이스에는 적용된 적이 없다. 어떤 마이그레이션도 이 표의
-- RLS를 다루지 않았기 때문이다. 그 결과 키 간 격리가 애플리케이션 질의 필터
-- 한 겹에만 의존한다.
--
-- 정책은 두 축을 본다.
--   agent_id: 종전 memory-schema.sql 정책과 같은 규약을 유지한다.
--   key_id  : app.current_key_id 세션 변수가 지정된 경우에만 적용한다. 값이 비어
--             있으면 키 범위가 없다는 뜻으로 읽고 종전과 같이 agent_id만 본다.
--
-- 이 마이그레이션은 ENABLE까지만 한다. FORCE ROW LEVEL SECURITY와 런타임 역할
-- 분리는 적용하지 않는다. 현재 애플리케이션 계정이 표 소유자이므로 ENABLE만으로는
-- 런타임 질의에 정책이 적용되지 않으며, 따라서 이 변경은 동작을 바꾸지 않는다.
-- 정책이 옳은지 검증한 뒤 별도 마이그레이션에서 FORCE를 건다.
--
-- 되돌리기: ALTER TABLE agent_memory.fragments DISABLE ROW LEVEL SECURITY;
--           ALTER TABLE agent_memory.fragment_links DISABLE ROW LEVEL SECURITY;
--
-- 멱등: ENABLE은 반복 적용해도 무해하며 정책은 DROP 후 재생성한다.

ALTER TABLE agent_memory.fragments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fragment_isolation_policy ON agent_memory.fragments;
CREATE POLICY fragment_isolation_policy ON agent_memory.fragments
    USING (
        (
            agent_id = current_setting('app.current_agent_id', true)
            OR agent_id = 'default'
            OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
        )
        AND (
            COALESCE(current_setting('app.current_key_id', true), '') = ''
            OR key_id IS NOT DISTINCT FROM current_setting('app.current_key_id', true)
            OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
        )
    )
    WITH CHECK (
        (
            agent_id = current_setting('app.current_agent_id', true)
            OR agent_id = 'default'
            OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
        )
        AND (
            COALESCE(current_setting('app.current_key_id', true), '') = ''
            OR key_id IS NOT DISTINCT FROM current_setting('app.current_key_id', true)
            OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
        )
    );

ALTER TABLE agent_memory.fragment_links ENABLE ROW LEVEL SECURITY;

-- 링크는 자체 격리 축이 없고 양 끝 파편의 접근 가능성을 따른다.
DROP POLICY IF EXISTS fragment_links_isolation_policy ON agent_memory.fragment_links;
CREATE POLICY fragment_links_isolation_policy ON agent_memory.fragment_links
    USING (
        current_setting('app.current_agent_id', true) IN ('system', 'admin')
        OR EXISTS (
            SELECT 1 FROM agent_memory.fragments f
             WHERE f.id = fragment_links.from_id
        )
    )
    WITH CHECK (
        current_setting('app.current_agent_id', true) IN ('system', 'admin')
        OR EXISTS (
            SELECT 1 FROM agent_memory.fragments f
             WHERE f.id = fragment_links.from_id
        )
    );

COMMENT ON POLICY fragment_isolation_policy ON agent_memory.fragments
  IS 'agent_id와 app.current_key_id 두 축의 격리. 표 소유자에게는 FORCE 적용 전까지 무효.';
