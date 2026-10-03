-- migration-060-admin-users.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-03
--
-- 관리자 계정과 DB 세션.
--
--   admin_users           로컬 관리자 계정. 비밀번호는 scrypt 해시 문자열(비용 매개변수와 salt를 행마다 담는다).
--                         TOTP 비밀은 MEMENTO_ADMIN_SEAL_KEY로 봉인한 값만 담는다(키 버전 포함).
--                         totp_last_step은 마지막으로 받은 TOTP 시간 단계이며 같은 코드의 재사용을 막는다.
--   admin_role_bindings   역할 바인딩. workspace NULL은 전역 바인딩이다. 역할 이름은 앱의 프리셋 표가 검사한다.
--   admin_sessions        관리 세션. 토큰은 해시만 담는다. family_id는 로그인 한 번에서 이어지는 회전 계열이고
--                         absolute_expires_at은 계열의 절대 만료, last_seen_at은 유휴 만료 판정에 쓴다.
--   admin_recovery_codes  복구 코드 해시. used_at이 있으면 다시 쓸 수 없다.
--   admin_identities      외부 신원(OIDC issuer, subject)과 계정의 대응. 확장 지점이며 로그인 경로는 아직 쓰지 않는다.
--
-- admin_audit_events.actor_kind에 관리자 계정 행위자(admin)를 더한다. 제약 이름에 기대지 않고 actor_kind를
-- 검사하는 CHECK 제약을 정의로 찾아 바꾼다.
--
-- 모두 새 작은 표다. 대형 표 목록(fragments, fragment_links, case_events, search_events)에 속하지 않는다.
--
-- 멱등: CREATE TABLE / INDEX IF NOT EXISTS, 제약 교체는 같은 정의로 다시 만든다.

CREATE TABLE IF NOT EXISTS agent_memory.admin_users (
    id                     UUID        PRIMARY KEY,
    username               TEXT        NOT NULL,
    username_norm          TEXT        NOT NULL,
    password_hash          TEXT        NOT NULL,
    status                 TEXT        NOT NULL DEFAULT 'active',
    totp_secret_sealed     TEXT,
    totp_enabled_at        TIMESTAMPTZ,
    totp_last_step         BIGINT,
    totp_pending_sealed    TEXT,
    totp_enroll_token_hash TEXT,
    totp_enroll_expires_at TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at          TIMESTAMPTZ,
    created_by             TEXT,
    CONSTRAINT admin_users_username_norm_key UNIQUE (username_norm),
    CONSTRAINT admin_users_status_check CHECK (status IN ('active', 'disabled')),
    CONSTRAINT admin_users_username_check CHECK (length(username) BETWEEN 1 AND 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_enroll_token
    ON agent_memory.admin_users (totp_enroll_token_hash)
    WHERE totp_enroll_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_memory.admin_role_bindings (
    id         BIGSERIAL   PRIMARY KEY,
    user_id    UUID        NOT NULL REFERENCES agent_memory.admin_users(id) ON DELETE CASCADE,
    role       TEXT        NOT NULL,
    workspace  TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    CONSTRAINT admin_role_bindings_role_check CHECK (role ~ '^[a-z][a-z_]{0,31}$'),
    CONSTRAINT admin_role_bindings_workspace_check CHECK (workspace IS NULL OR length(workspace) BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_role_bindings_unique
    ON agent_memory.admin_role_bindings (user_id, role, COALESCE(workspace, ''));

CREATE INDEX IF NOT EXISTS idx_admin_role_bindings_role
    ON agent_memory.admin_role_bindings (role);

CREATE TABLE IF NOT EXISTS agent_memory.admin_sessions (
    id                  UUID        PRIMARY KEY,
    family_id           UUID        NOT NULL,
    user_id             UUID        NOT NULL REFERENCES agent_memory.admin_users(id) ON DELETE CASCADE,
    token_hash          TEXT        NOT NULL,
    csrf_hash           TEXT        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    absolute_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    revoke_reason       TEXT,
    created_ip          TEXT,
    CONSTRAINT admin_sessions_token_hash_key UNIQUE (token_hash),
    CONSTRAINT admin_sessions_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$' AND csrf_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_active
    ON agent_memory.admin_sessions (user_id)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_admin_sessions_family
    ON agent_memory.admin_sessions (family_id);

CREATE TABLE IF NOT EXISTS agent_memory.admin_recovery_codes (
    user_id    UUID        NOT NULL REFERENCES agent_memory.admin_users(id) ON DELETE CASCADE,
    code_hash  TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_at    TIMESTAMPTZ,
    PRIMARY KEY (user_id, code_hash),
    CONSTRAINT admin_recovery_codes_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS agent_memory.admin_identities (
    issuer        TEXT        NOT NULL,
    subject       TEXT        NOT NULL,
    user_id       UUID        NOT NULL REFERENCES agent_memory.admin_users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,
    PRIMARY KEY (issuer, subject)
);

CREATE INDEX IF NOT EXISTS idx_admin_identities_user
    ON agent_memory.admin_identities (user_id);

DO $$ DECLARE c record; BEGIN
    IF to_regclass('agent_memory.admin_audit_events') IS NULL THEN
        RETURN;
    END IF;
    FOR c IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'agent_memory.admin_audit_events'::regclass
           AND contype  = 'c'
           AND pg_get_constraintdef(oid) LIKE '%actor_kind%'
    LOOP
        EXECUTE format('ALTER TABLE agent_memory.admin_audit_events DROP CONSTRAINT %I', c.conname);
    END LOOP;
    ALTER TABLE agent_memory.admin_audit_events
        ADD CONSTRAINT admin_audit_events_actor_kind_check
        CHECK (actor_kind IN ('master', 'key', 'admin', 'anonymous', 'system'));
END $$;

COMMENT ON TABLE agent_memory.admin_users
  IS '로컬 관리자 계정. 비밀번호는 scrypt 해시 문자열, TOTP 비밀은 봉인 값만 담는다.';
COMMENT ON COLUMN agent_memory.admin_users.password_hash
  IS 'scrypt 해시 문자열($scrypt$ln=,r=,p=$salt$hash). 비용 매개변수와 salt를 행마다 담는다.';
COMMENT ON COLUMN agent_memory.admin_users.totp_secret_sealed
  IS 'MEMENTO_ADMIN_SEAL_KEY로 봉인한 TOTP 비밀(AES-256-GCM, 키 버전 포함).';
COMMENT ON COLUMN agent_memory.admin_users.totp_last_step
  IS '마지막으로 받은 TOTP 시간 단계. 이 값 이하의 단계는 받지 않는다.';
COMMENT ON TABLE agent_memory.admin_sessions
  IS '관리 세션. 토큰과 CSRF 토큰은 sha256 해시만 담는다. family_id는 회전 계열이다.';
COMMENT ON TABLE agent_memory.admin_identities
  IS '외부 신원(OIDC)과 관리자 계정의 대응. 확장 지점이다.';
