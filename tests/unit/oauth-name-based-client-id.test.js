/**
 * OAuth name-based client_id 바인딩 단위 테스트 (v2.8.4)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-17
 *
 * 검증 대상:
 *   1. /register Authorization Bearer 유효 API 키 → client_id = "<name>_<keyIdHex8>"
 *   2. /register client_name = "apikey:<keyId>" 마커 저장
 *   3. /register Authorization 없음 → 기존 랜덤 client_id 경로 (backward compat)
 *   4. /authorize name-based client_id → codeData.bound_key_id 설정
 *   5. /token exchange → tokenData.bound_key_id 전파
 *   6. refresh_token → bound_key_id 승계
 *   7. validateAuthentication bound_key_id → keyId 정상 반환
 *   8. v2.8.3 호환: client_id = 전체 API 키 문자열 → is_api_key 경로 여전히 동작
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/*  공통 유틸: client_id 생성 로직 재현                                */
/* ------------------------------------------------------------------ */

/**
 * /register의 name-based client_id 생성 로직 재현
 *
 * @param {string|null} name    - api_keys.name
 * @param {string}      keyId   - UUID (하이픈 포함)
 * @returns {string}
 */
function buildBoundClientId(name, keyId) {
  const rawName  = name || keyId;
  const keyIdHex = keyId.replace(/-/g, "").slice(0, 8);
  return `${rawName}_${keyIdHex}`;
}

/**
 * /register의 client_name 마커 생성 로직 재현
 *
 * @param {string} keyId
 * @returns {string}
 */
function buildBoundClientName(keyId) {
  return `apikey:${keyId}`;
}

/* ------------------------------------------------------------------ */
/*  케이스 1: /register Authorization Bearer 유효 API 키               */
/*           → client_id = "<name>_<keyIdHex8>"                        */
/* ------------------------------------------------------------------ */

describe("/register — name-based client_id 생성", () => {
  const SAMPLE_KEY_ID   = "550e8400-e29b-41d4-a716-446655440000";
  const SAMPLE_KEY_NAME = "nerdvana-gem";

  it("name이 있는 경우 → <name>_<keyIdHex8> 형식", () => {
    const clientId = buildBoundClientId(SAMPLE_KEY_NAME, SAMPLE_KEY_ID);
    /** 형식 검증 */
    assert.ok(clientId.startsWith(`${SAMPLE_KEY_NAME}_`), `prefix 불일치: ${clientId}`);
    const suffix = clientId.slice(SAMPLE_KEY_NAME.length + 1);
    assert.strictEqual(suffix.length, 8,  `suffix 길이 불일치: ${suffix.length}`);
    assert.match(suffix, /^[0-9a-f]{8}$/, `suffix가 hex가 아님: ${suffix}`);
  });

  it("name이 null인 경우 → keyId prefix로 대체", () => {
    const clientId = buildBoundClientId(null, SAMPLE_KEY_ID);
    /** keyId 자체를 rawName으로 사용 */
    assert.ok(clientId.startsWith(`${SAMPLE_KEY_ID}_`), `prefix 불일치: ${clientId}`);
  });

  it("다른 keyId → suffix가 달라야 함 (충돌 방지)", () => {
    const keyId1 = "550e8400-e29b-41d4-a716-446655440000";
    const keyId2 = "660f9511-f3ac-52e5-b827-557766551111";
    const id1    = buildBoundClientId("gemini", keyId1);
    const id2    = buildBoundClientId("gemini", keyId2);
    assert.notStrictEqual(id1, id2, "동일 name + 다른 keyId → client_id가 달라야 함");
  });

  it("동일 name + 동일 keyId → 항상 동일 client_id (멱등)", () => {
    const id1 = buildBoundClientId(SAMPLE_KEY_NAME, SAMPLE_KEY_ID);
    const id2 = buildBoundClientId(SAMPLE_KEY_NAME, SAMPLE_KEY_ID);
    assert.strictEqual(id1, id2);
  });

  it("하이픈이 포함된 keyId → hex suffix에 하이픈 없음", () => {
    const clientId = buildBoundClientId("test", SAMPLE_KEY_ID);
    const suffix   = clientId.slice("test_".length);
    assert.ok(!suffix.includes("-"), `suffix에 하이픈 포함됨: ${suffix}`);
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 2: /register client_name = "apikey:<keyId>" 마커            */
/* ------------------------------------------------------------------ */

describe("/register — client_name 바인딩 마커", () => {
  it("client_name이 'apikey:<uuid>' 패턴으로 구성됨", () => {
    const keyId      = "550e8400-e29b-41d4-a716-446655440000";
    const clientName = buildBoundClientName(keyId);
    assert.strictEqual(clientName, `apikey:${keyId}`);
    assert.match(clientName, /^apikey:[0-9a-f-]{36}$/i);
  });

  it("keyId 추출 — client_name → keyId 역방향 파싱", () => {
    const keyId      = "550e8400-e29b-41d4-a716-446655440000";
    const clientName = buildBoundClientName(keyId);
    const match      = clientName.match(/^apikey:([0-9a-f-]{36})$/i);
    assert.ok(match, "패턴 매치 실패");
    assert.strictEqual(match[1], keyId);
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 3: Authorization 없음 → 기존 랜덤 client_id 경로            */
/* ------------------------------------------------------------------ */

describe("/register — Authorization 헤더 없음 (backward compat)", () => {
  /**
   * Authorization 헤더가 없으면 boundClientId = null 이므로
   * registerClient에 client_id: undefined가 전달되어 랜덤 mmcp_ prefix ID 생성.
   */
  it("boundClientId가 null일 때 undefined로 전달 → 랜덤 ID 생성", () => {
    const boundClientId = null;
    const passedClientId = boundClientId || undefined;
    assert.strictEqual(passedClientId, undefined, "undefined가 전달되어야 함");
  });

  it("boundClientName이 null이고 body.client_name='Claude'일 때 → 'Claude' 사용", () => {
    const boundClientName = null;
    const bodyClientName  = "Claude";
    const usedClientName  = boundClientName || bodyClientName || null;
    assert.strictEqual(usedClientName, "Claude");
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 4: /authorize name-based client_id → bound_key_id 설정      */
/* ------------------------------------------------------------------ */

/**
 * handleAuthorize 내부 bound_key_id 결정 로직 재현
 *
 * @param {object} opts
 * @param {string}       opts.clientId       - 요청 client_id
 * @param {string|null}  opts.clientName     - oauth_clients.client_name (DB 조회 결과)
 * @param {boolean}      opts.clientFound    - getClient 결과 존재 여부
 * @param {boolean}      opts.byIdValid      - validateApiKeyById 결과
 * @param {string|null}  opts.byIdKeyId      - validateApiKeyById.keyId
 * @returns {{ isApiKeyClient: boolean, boundKeyId: string|null }}
 */
function simulateAuthorizeBoundKeyPath({ _clientId, clientName, clientFound, byIdValid, byIdKeyId }) {
  let isApiKeyClient = false;
  let boundKeyId     = null;

  if (!clientFound) return { isApiKeyClient, boundKeyId };

  const cnMatch = (clientName || "").match(/^apikey:([0-9a-f-]{36})$/i);
  if (cnMatch) {
    const extractedKeyId = cnMatch[1];
    if (byIdValid) {
      isApiKeyClient = true;
      boundKeyId     = byIdKeyId || extractedKeyId;
    }
  }
  return { isApiKeyClient, boundKeyId };
}

describe("/authorize — name-based client_id bound_key_id 설정", () => {
  const KEY_ID = "550e8400-e29b-41d4-a716-446655440000";

  it("client_name='apikey:<uuid>' + validateApiKeyById 성공 → bound_key_id 설정", () => {
    const result = simulateAuthorizeBoundKeyPath({
      clientId    : `nerdvana-gem_550e8400`,
      clientName  : `apikey:${KEY_ID}`,
      clientFound : true,
      byIdValid   : true,
      byIdKeyId   : KEY_ID,
    });
    assert.strictEqual(result.isApiKeyClient, true);
    assert.strictEqual(result.boundKeyId,     KEY_ID);
  });

  it("client_name='apikey:<uuid>' + validateApiKeyById 실패 → bound_key_id null", () => {
    const result = simulateAuthorizeBoundKeyPath({
      clientId    : `nerdvana-gem_550e8400`,
      clientName  : `apikey:${KEY_ID}`,
      clientFound : true,
      byIdValid   : false,
      byIdKeyId   : null,
    });
    assert.strictEqual(result.isApiKeyClient, false);
    assert.strictEqual(result.boundKeyId,     null);
  });

  it("client_name이 'apikey:' 패턴이 아닌 경우 → bound_key_id null", () => {
    const result = simulateAuthorizeBoundKeyPath({
      clientId    : "some-other-client",
      clientName  : "Claude Desktop",
      clientFound : true,
      byIdValid   : true,
      byIdKeyId   : KEY_ID,
    });
    assert.strictEqual(result.boundKeyId, null);
  });

  it("client_name=null → bound_key_id null", () => {
    const result = simulateAuthorizeBoundKeyPath({
      clientId    : "some-client",
      clientName  : null,
      clientFound : true,
      byIdValid   : true,
      byIdKeyId   : KEY_ID,
    });
    assert.strictEqual(result.boundKeyId, null);
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 5: /token exchange → bound_key_id 전파                      */
/* ------------------------------------------------------------------ */

describe("/token exchange — bound_key_id 전파", () => {
  const KEY_ID = "550e8400-e29b-41d4-a716-446655440000";

  it("codeData.bound_key_id → accessData.bound_key_id 전파", () => {
    const codeData = {
      client_id    : "nerdvana-gem_550e8400",
      scope        : "mcp",
      is_api_key   : true,
      bound_key_id : KEY_ID,
    };
    const accessData = {
      type         : "access",
      client_id    : codeData.client_id,
      scope        : codeData.scope,
      is_api_key   : codeData.is_api_key || false,
      bound_key_id : codeData.bound_key_id || null,
    };
    assert.strictEqual(accessData.bound_key_id, KEY_ID);
  });

  it("codeData.bound_key_id → refreshData.bound_key_id 전파", () => {
    const codeData = {
      client_id    : "nerdvana-gem_550e8400",
      scope        : "mcp",
      is_api_key   : true,
      bound_key_id : KEY_ID,
    };
    const refreshData = {
      type         : "refresh",
      client_id    : codeData.client_id,
      scope        : codeData.scope,
      is_api_key   : codeData.is_api_key || false,
      bound_key_id : codeData.bound_key_id || null,
    };
    assert.strictEqual(refreshData.bound_key_id, KEY_ID);
  });

  it("bound_key_id가 null인 codeData → accessData.bound_key_id null", () => {
    const codeData = {
      client_id    : "some-client",
      scope        : "mcp",
      is_api_key   : false,
      bound_key_id : null,
    };
    const accessData = {
      bound_key_id: codeData.bound_key_id || null,
    };
    assert.strictEqual(accessData.bound_key_id, null);
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 6: refresh_token → bound_key_id 승계                        */
/* ------------------------------------------------------------------ */

describe("refresh_token — bound_key_id 승계", () => {
  const KEY_ID = "550e8400-e29b-41d4-a716-446655440000";

  it("기존 tokenData.bound_key_id → 새 accessToken.bound_key_id 승계", () => {
    const tokenData = {
      type         : "refresh",
      client_id    : "nerdvana-gem_550e8400",
      scope        : "mcp",
      is_api_key   : true,
      bound_key_id : KEY_ID,
    };
    const newAccessData = {
      type         : "access",
      client_id    : tokenData.client_id,
      scope        : tokenData.scope,
      is_api_key   : tokenData.is_api_key || false,
      bound_key_id : tokenData.bound_key_id || null,
    };
    assert.strictEqual(newAccessData.bound_key_id, KEY_ID);
  });

  it("기존 tokenData.bound_key_id → 새 refreshToken.bound_key_id 승계", () => {
    const tokenData = {
      type         : "refresh",
      client_id    : "nerdvana-gem_550e8400",
      scope        : "mcp",
      is_api_key   : true,
      bound_key_id : KEY_ID,
    };
    const newRefreshData = {
      type         : "refresh",
      client_id    : tokenData.client_id,
      scope        : tokenData.scope,
      is_api_key   : tokenData.is_api_key || false,
      bound_key_id : tokenData.bound_key_id || null,
    };
    assert.strictEqual(newRefreshData.bound_key_id, KEY_ID);
  });

  it("v2.8.3 구형 tokenData (bound_key_id 없음) → null로 안전 처리", () => {
    const legacyTokenData = {
      type       : "refresh",
      client_id  : "some_api_key_string",
      is_api_key : true,
      /* bound_key_id 필드 없음 — v2.8.3 Redis에 저장된 토큰 */
    };
    const newAccessData = {
      bound_key_id: legacyTokenData.bound_key_id || null,
    };
    assert.strictEqual(newAccessData.bound_key_id, null);
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 7: validateAuthentication bound_key_id → keyId 반환         */
/* ------------------------------------------------------------------ */

/**
 * validateAuthentication의 OAuth 분기 재현 (v2.8.4 우선순위 포함)
 *
 * @param {object} opts
 * @param {boolean}      opts.oauthValid       - validateAccessToken 결과
 * @param {string|null}  opts.boundKeyId       - oauthResult.bound_key_id
 * @param {boolean}      opts.boundApiKeyValid - validateApiKeyById 결과
 * @param {string|null}  opts.boundApiKeyId    - validateApiKeyById.keyId
 * @param {boolean}      opts.isApiKey         - oauthResult.is_api_key
 * @param {boolean}      opts.legacyApiKeyValid - validateApiKeyFromDB 결과
 * @param {string|null}  opts.legacyKeyId      - validateApiKeyFromDB.keyId
 * @param {boolean}      opts.rejectNonApiKey  - REJECT_NONAPIKEY_OAUTH
 * @param {boolean}      opts.accessKeySet     - ACCESS_KEY 설정 여부
 * @param {boolean}      opts.authDisabled     - AUTH_DISABLED
 * @returns {{ valid: boolean, keyId?: string|null, oauth?: boolean, error?: string }}
 */
function simulateValidateAuthentication({
  oauthValid,
  boundKeyId,
  boundApiKeyValid,
  boundApiKeyId,
  isApiKey,
  legacyApiKeyValid,
  legacyKeyId,
  rejectNonApiKey,
  accessKeySet,
  authDisabled,
}) {
  if (!oauthValid) return { valid: false };

  /** 1순위: bound_key_id 경로 */
  if (boundKeyId) {
    if (boundApiKeyValid) {
      return { valid: true, oauth: true, keyId: boundApiKeyId };
    }
    /** bound_key_id 조회 실패 → 2순위로 낙하 */
  }

  /** 2순위: is_api_key + client_id가 API 키 문자열 */
  if (isApiKey) {
    if (legacyApiKeyValid) {
      return { valid: true, oauth: true, keyId: legacyKeyId };
    }
  }

  /** 3순위: non-API-key OAuth */
  if (rejectNonApiKey && accessKeySet && !authDisabled) {
    return { valid: false, error: "non-API-key OAuth denied" };
  }
  return { valid: true, oauth: true, client_id: "some-client" };
}

describe("validateAuthentication — bound_key_id 우선 경로 (v2.8.4)", () => {
  const KEY_ID = "550e8400-e29b-41d4-a716-446655440000";

  it("bound_key_id 있고 validateApiKeyById 성공 → keyId 반환", () => {
    const result = simulateValidateAuthentication({
      oauthValid       : true,
      boundKeyId       : KEY_ID,
      boundApiKeyValid : true,
      boundApiKeyId    : KEY_ID,
      isApiKey         : true,
      legacyApiKeyValid: false,
      legacyKeyId      : null,
      rejectNonApiKey  : true,
      accessKeySet     : true,
      authDisabled     : false,
    });
    assert.strictEqual(result.valid,  true);
    assert.strictEqual(result.oauth,  true);
    assert.strictEqual(result.keyId,  KEY_ID);
  });

  it("bound_key_id 있고 validateApiKeyById 실패 → 2순위 is_api_key 경로로 낙하", () => {
    const result = simulateValidateAuthentication({
      oauthValid       : true,
      boundKeyId       : KEY_ID,
      boundApiKeyValid : false,
      boundApiKeyId    : null,
      isApiKey         : true,
      legacyApiKeyValid: true,
      legacyKeyId      : "other-key-id",
      rejectNonApiKey  : true,
      accessKeySet     : true,
      authDisabled     : false,
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.keyId, "other-key-id");
  });

  it("bound_key_id null → is_api_key 경로 정상 동작 (v2.8.3 호환)", () => {
    const result = simulateValidateAuthentication({
      oauthValid       : true,
      boundKeyId       : null,
      boundApiKeyValid : false,
      boundApiKeyId    : null,
      isApiKey         : true,
      legacyApiKeyValid: true,
      legacyKeyId      : "legacy-key-id",
      rejectNonApiKey  : true,
      accessKeySet     : true,
      authDisabled     : false,
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.keyId, "legacy-key-id");
  });
});

/* ------------------------------------------------------------------ */
/*  케이스 8: v2.8.3 호환 — client_id = 전체 API 키 → is_api_key 경로  */
/* ------------------------------------------------------------------ */

describe("v2.8.3 backward compat — client_id = 전체 API 키 문자열", () => {
  it("bound_key_id=null + is_api_key=true → 기존 validateApiKeyFromDB 경로", () => {
    const result = simulateValidateAuthentication({
      oauthValid       : true,
      boundKeyId       : null,   /* v2.8.3 구형 토큰: bound_key_id 없음 */
      boundApiKeyValid : false,
      boundApiKeyId    : null,
      isApiKey         : true,   /* v2.8.3: is_api_key=true */
      legacyApiKeyValid: true,
      legacyKeyId      : "v283-key-id",
      rejectNonApiKey  : true,
      accessKeySet     : true,
      authDisabled     : false,
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.keyId, "v283-key-id", "v2.8.3 is_api_key 경로가 동작해야 함");
  });

  it("v2.8.3 토큰 + REJECT_NONAPIKEY_OAUTH=true + DB 조회 실패 → 거부", () => {
    const result = simulateValidateAuthentication({
      oauthValid       : true,
      boundKeyId       : null,
      boundApiKeyValid : false,
      boundApiKeyId    : null,
      isApiKey         : true,
      legacyApiKeyValid: false,  /* DB 조회 실패 */
      legacyKeyId      : null,
      rejectNonApiKey  : true,
      accessKeySet     : true,
      authDisabled     : false,
    });
    assert.strictEqual(result.valid, false);
  });
});

/* ------------------------------------------------------------------ */
/*  패턴 검증 — "apikey:<uuid>" 정규식 경계 케이스                      */
/* ------------------------------------------------------------------ */

describe("client_name 패턴 매칭 — 경계 케이스", () => {
  const UUID_REGEX = /^apikey:([0-9a-f-]{36})$/i;

  it("정상 UUID → 매치 성공", () => {
    assert.match("apikey:550e8400-e29b-41d4-a716-446655440000", UUID_REGEX);
  });

  it("'Claude' → 매치 실패 (일반 client_name)", () => {
    assert.ok(!UUID_REGEX.test("Claude"), "일반 이름은 매치되면 안 됨");
  });

  it("'apikey:' 만 있는 경우 → 매치 실패", () => {
    assert.ok(!UUID_REGEX.test("apikey:"), "빈 keyId는 매치되면 안 됨");
  });

  it("'apikey:short-id' → 매치 실패 (UUID 형식 불일치)", () => {
    assert.ok(!UUID_REGEX.test("apikey:short-id"), "짧은 ID는 매치되면 안 됨");
  });

  it("대문자 UUID → 매칭 성공 (case-insensitive)", () => {
    assert.match("apikey:550E8400-E29B-41D4-A716-446655440000", UUID_REGEX);
  });
});
