/**
 * 관리 능력 목록과 역할 프리셋
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 역할은 능력 묶음이다. 프리셋 하나는 { 능력: 방식 } 표이고, 방식은 그 역할이 능력을 쓰는 범위다.
 *   O  허용(바인딩 범위 전체)
 *   W  위임 workspace 한정(바인딩 workspace 안)
 *   M  메타만(내용은 해시와 길이로 가린다)
 *   S  키 범위 한정(API 키 주체)
 * 판정은 방식과 관계없이 같은 결정 표(AdminAuthz.decide)를 따른다. 방식 M은 응답 마스킹을 켠다.
 *
 * 역할을 늘릴 때는 ROLE_PRESETS에 한 줄을 더하고 결정 표 시험에 한 행을 더한다.
 */

/** 능력 이름 전체. 판정, 라우트 표, explain이 이 목록만 받는다. */
export const CAPABILITIES = Object.freeze([
  "mem.read",
  "mem.write",
  "mem.anchor",
  "mem.delete.soft",
  "mem.delete.hard",
  "mem.bulk",
  "mem.merge",
  "review.decide",
  "export.data",
  "import.data",
  "key.manage",
  "key.policy",
  "egress.policy",
  "ws.create",
  "ws.quota",
  "retention.manage",
  "legal_hold.manage",
  "erasure.request",
  "erasure.execute",
  "job.dry_run",
  "job.apply",
  "audit.read",
  "audit.export",
  "webhook.manage",
  "usage.read",
  "quality.read",
  "oauth_client.manage",
  "admin_user.manage",
  "system.update"
]);

const CAPABILITY_SET = new Set(CAPABILITIES);

/**
 * 능력 표의 행마다 하나씩 고른 대표 능력. 한 행에 능력이 둘인 경우(mem.bulk와 mem.merge 등) 앞의 것을 쓴다.
 */
export const REPRESENTATIVE_CAPABILITIES = Object.freeze([
  "mem.read",
  "mem.write",
  "mem.anchor",
  "mem.delete.soft",
  "mem.delete.hard",
  "mem.bulk",
  "review.decide",
  "export.data",
  "import.data",
  "key.manage",
  "key.policy",
  "egress.policy",
  "ws.create",
  "retention.manage",
  "legal_hold.manage",
  "erasure.request",
  "erasure.execute",
  "job.dry_run",
  "job.apply",
  "audit.read",
  "webhook.manage",
  "usage.read",
  "oauth_client.manage",
  "admin_user.manage",
  "system.update"
]);

/** 능력 사용 방식 */
export const CAP_MODES = Object.freeze({ OPEN: "O", WORKSPACE: "W", META: "M", KEY: "S" });

/** 여러 바인딩이 같은 능력을 줄 때 고르는 방식의 우선순위(앞이 넓다) */
export const CAP_MODE_ORDER = Object.freeze(["O", "W", "S", "M"]);

/** owner만 가지는 능력 */
export const OWNER_ONLY_CAPABILITIES = Object.freeze([
  "legal_hold.manage",
  "erasure.execute",
  "admin_user.manage",
  "system.update"
]);

/** 라우트 표 표지: 인증 없이 부르는 라우트(로그인) */
export const CAP_PUBLIC = "public";

/** 라우트 표 표지: 인증된 주체면 누구나 부르는 라우트(자기 정보) */
export const CAP_AUTHENTICATED = "authenticated";

/** 라우트 표에 없는 관리 경로가 요구하는 능력. owner만 통과한다. */
export const UNLISTED_ROUTE_CAP = "system.update";

/**
 * 모든 능력에 같은 방식을 주는 프리셋을 만든다.
 *
 * @param {string[]} caps
 * @param {string}   mode
 * @returns {Readonly<Record<string, string>>}
 */
function uniformPreset(caps, mode) {
  return Object.freeze(Object.fromEntries(caps.map((cap) => [cap, mode])));
}

const OWNER_ONLY = new Set(OWNER_ONLY_CAPABILITIES);

/** Core 역할 프리셋 */
export const ROLE_PRESETS = Object.freeze({
  owner   : uniformPreset(CAPABILITIES, "O"),
  admin   : uniformPreset(CAPABILITIES.filter((cap) => !OWNER_ONLY.has(cap)), "O"),
  reviewer: Object.freeze({ "mem.read": "W", "review.decide": "W" }),
  auditor : Object.freeze({
    "mem.read"    : "M",
    "export.data" : "M",
    "audit.read"  : "O",
    "audit.export": "O",
    "usage.read"  : "O",
    "quality.read": "O"
  }),
  viewer  : Object.freeze({ "mem.read": "W", "usage.read": "W", "quality.read": "W" }),
  service : Object.freeze({ "mem.read": "S", "mem.write": "S", "mem.anchor": "S", "mem.delete.soft": "S" })
});

/** Core 출고 프리셋 이름 */
export const CORE_PRESETS = Object.freeze(Object.keys(ROLE_PRESETS));

/**
 * API 키 permissions 값의 능력 변환. 표에 없는 값은 능력을 주지 않는다.
 */
export const LEGACY_PERMISSION_CAPS = Object.freeze({
  read  : Object.freeze(["mem.read"]),
  write : Object.freeze(["mem.write", "mem.delete.soft"]),
  anchor: Object.freeze(["mem.anchor"])
});

/**
 * @param {unknown} cap
 * @returns {boolean}
 */
export function isCapability(cap) {
  return typeof cap === "string" && CAPABILITY_SET.has(cap);
}

/**
 * API 키 permissions 배열을 능력 집합으로 바꾼다.
 *
 * @param {unknown} permissions
 * @returns {Set<string>}
 */
export function capabilitiesFromPermissions(permissions) {
  const caps = new Set();
  if (!Array.isArray(permissions)) return caps;
  for (const perm of permissions) {
    if (typeof perm !== "string" || !Object.hasOwn(LEGACY_PERMISSION_CAPS, perm)) continue;
    for (const cap of LEGACY_PERMISSION_CAPS[perm]) caps.add(cap);
  }
  return caps;
}
