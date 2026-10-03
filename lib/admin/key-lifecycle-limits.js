/**
 * API 키 수명 설정의 기본값과 상한
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * lib/config.js의 기동 검사와 lib/admin/key-lifecycle.js의 호출 시점 판독이 같은 값을 쓴다. 다른 모듈을 가져오지 않는다.
 */

/** MEMENTO_KEY_ROTATION_GRACE_HOURS 기본값과 상한(시간) */
export const DEFAULT_KEY_ROTATION_GRACE_HOURS   = 24;
export const MAX_KEY_ROTATION_GRACE_HOURS       = 720;

/** MEMENTO_KEY_LAST_USED_INTERVAL_SEC 기본값과 상한(초) */
export const DEFAULT_KEY_LAST_USED_INTERVAL_SEC = 60;
export const MAX_KEY_LAST_USED_INTERVAL_SEC     = 86_400;
