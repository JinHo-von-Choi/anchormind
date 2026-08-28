/**
 * FeedbackSampler - 쓰기 계열 도구 응답에 tool_feedback 요청 힌트를 확률적으로 동봉
 *
 * 작성자: 최진호
 * 작성일: 2026-08-06
 *
 * 자발적 피드백만으로는 표본이 성공 사례에 편중된다. 저장·수정·삭제 직후
 * 일정 확률로 평가를 요청해 표본을 넓히되, 세션당 상한과 쿨다운으로
 * 힌트가 소음이 되지 않게 한다.
 *
 * Redis 미가용 시 상한·쿨다운은 적용되지 않는다(fail-open). 힌트는 부가 정보일
 * 뿐이므로 카운터를 읽지 못한다고 해서 도구 응답을 막지 않는다.
 */

import { MEMORY_CONFIG } from "#config/memory";
import { redisClient }   from "../../redis.js";

const COUNT_PREFIX = "frag:fbhint:count:";
const CD_PREFIX    = "frag:fbhint:cd:";
const COUNT_TTL_S  = 86400;

/** 설정 블록을 안전하게 꺼낸다. 미정의 시 비활성 취급. */
function samplingConfig() {
  return MEMORY_CONFIG?.feedback?.sampling ?? { enabled: false, rates: {} };
}

/**
 * 도구 이름과 확률표를 대조해 이번 호출을 표집할지 판정한다 (순수 함수).
 *
 * rates에 없는 도구는 언제나 false. rng를 주입하면 결정적으로 검증 가능하다.
 *
 * @param {string} toolName
 * @param {Object} options
 *   - rates {Object} 도구명 → 0~1 확률
 *   - rng   {Function} 0 이상 1 미만 난수 생성기 (기본 Math.random)
 * @returns {boolean}
 */
export function shouldSample(toolName, { rates, rng = Math.random } = {}) {
  const table = rates ?? {};
  const rate  = table[toolName];
  if (typeof rate !== "number" || !(rate > 0)) return false;
  return rng() < rate;
}

/**
 * tool_feedback 요청 힌트 객체를 생성한다 (순수 함수).
 *
 * @param {string} toolName
 * @returns {{ signal: string, suggestion: string, trigger: string, args: Object }}
 */
export function buildFeedbackHint(toolName) {
  return {
    signal    : "feedback_sampled",
    suggestion: `방금 ${toolName} 결과가 의도한 대로 유용했는지 tool_feedback으로 평가해 주세요. ` +
                  `relevant=false인 경우 irrelevance_reason도 함께 보내면 원인별 개선에 반영됩니다.`,
    trigger   : "tool_feedback",
    args      : {
      tool_name   : toolName,
      trigger_type: "sampled"
    }
  };
}

/**
 * 세션 상한·쿨다운까지 반영해 최종 힌트를 반환한다.
 *
 * Redis에 접근할 수 없으면 상한·쿨다운 없이 확률 판정 결과만 따른다.
 *
 * @param {string} toolName
 * @param {string} sessionId
 * @param {Object} [options]
 *   - rng   {Function} 난수 생성기 주입 (테스트용)
 *   - redis {Object}   Redis 클라이언트 주입 (테스트용). null이면 미가용 취급
 * @returns {Promise<Object|null>} 힌트 객체 또는 null
 */
export async function maybeFeedbackHint(toolName, sessionId, { rng, redis } = {}) {
  const config = samplingConfig();
  if (!config.enabled) return null;
  if (!shouldSample(toolName, { rates: config.rates, rng })) return null;

  const client = redis !== undefined ? redis : resolveRedis();
  if (!client || !sessionId) return buildFeedbackHint(toolName);

  try {
    const cdKey    = `${CD_PREFIX}${sessionId}`;
    const acquired = await client.set(cdKey, "1", "EX", config.cooldownSeconds, "NX");
    if (!acquired) return null;

    const countKey = `${COUNT_PREFIX}${sessionId}`;
    const count    = await client.incr(countKey);
    if (count === 1) await client.expire(countKey, COUNT_TTL_S);
    if (count > config.maxHintsPerSession) return null;

    return buildFeedbackHint(toolName);
  } catch {
    /** fail-open: 카운터 조회 실패가 도구 응답 품질을 좌우해서는 안 된다. */
    return buildFeedbackHint(toolName);
  }
}

/** 준비된 Redis 클라이언트만 반환한다. 스텁·미연결 상태는 미가용으로 본다. */
function resolveRedis() {
  return redisClient && redisClient.status === "ready" ? redisClient : null;
}
