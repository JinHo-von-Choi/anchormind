-- migration-080-fragment-rls-key-list.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-04
--
-- fragments 행 수준 보안 정책(migration-045)의 키 축을 키 목록으로 넓힌다. 그룹 멤버는 자기 키와 같은 그룹에서
-- 읽을 수 있는 키의 파편을 함께 읽으므로, 키 하나(app.current_key_id)만 보는 정책으로는 FORCE를 켤 수 없다.
--   app.current_key_ids  질의의 키 격리 절이 넣은 키 목록(쉼표로 잇는다, lib/tools/key-scope-ids.js)
--   app.current_key_id   종전 단일 키 값. 계속 받는다
-- 두 값이 모두 비어 있으면 키 범위가 없다는 뜻으로 읽고 agent_id만 본다(종전과 같다).
--
-- 이 마이그레이션도 FORCE를 걸지 않는다. 애플리케이션이 표 소유자로 접속하는 동안 정책은 런타임 질의에 적용되지
-- 않으므로 동작은 바뀌지 않는다. 적용 절차는 docs/operations/row-level-security.md에 있다.
-- 멱등: 정책을 DROP 후 다시 만든다.

DROP POLICY IF EXISTS fragment_isolation_policy ON agent_memory.fragments;
CREATE POLICY fragment_isolation_policy ON agent_memory.fragments
    USING (
        (
            agent_id = current_setting('app.current_agent_id', true)
            OR agent_id = 'default'
            OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
        )
        AND (
            (COALESCE(current_setting('app.current_key_id', true), '') = ''
             AND COALESCE(current_setting('app.current_key_ids', true), '') = '')
            OR key_id = NULLIF(current_setting('app.current_key_id', true), '')
            OR key_id = ANY(string_to_array(NULLIF(current_setting('app.current_key_ids', true), ''), ','))
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
            (COALESCE(current_setting('app.current_key_id', true), '') = ''
             AND COALESCE(current_setting('app.current_key_ids', true), '') = '')
            OR key_id = NULLIF(current_setting('app.current_key_id', true), '')
            OR key_id = ANY(string_to_array(NULLIF(current_setting('app.current_key_ids', true), ''), ','))
            OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
        )
    );

COMMENT ON POLICY fragment_isolation_policy ON agent_memory.fragments
  IS 'agent_id와 키 범위(app.current_key_id, app.current_key_ids) 두 축의 격리. 표 소유자에게는 FORCE 적용 전까지 무효.';
