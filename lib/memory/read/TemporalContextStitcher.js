/**
 * TemporalContextStitcher - 시간·인과 맥락 통합 조합 계층
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 시간 인접 파편(같은 세션 근접 시각)과 인과 링크(caused_by/resolved_by)를
 * 하나의 서사 구조로 병합한다. 데이터 수집은 기존 경로가 담당하며 이 모듈은
 * 조합·정렬·중복 제거·예산 절삭만 수행하는 순수 계층이다.
 */

/** 전후 맥락으로 인정할 최대 시간 간격 (밀리초) */
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

/** 인과 관계로 취급할 링크 종류 */
const CAUSAL_RELATIONS = new Set(["caused_by", "resolved_by", "contradicts", "part_of"]);

/**
 * 두 시각의 분 단위 차이를 부호와 함께 구한다.
 *
 * @param {string|Date} target
 * @param {string|Date} other
 * @returns {number|null} other가 target보다 이르면 음수
 */
export function deltaMinutes(target, other) {
  const a = new Date(target).getTime();
  const b = new Date(other).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 60000);
}

/**
 * 한 파편에 대한 전후 맥락과 인과 연결을 하나의 구조로 조합한다.
 *
 * @param {Object}   fragment          기준 파편
 * @param {Object}   sources
 * @param {Object[]} [sources.nearby]  같은 세션의 시간 인접 파편
 * @param {Object[]} [sources.linked]  1-hop 링크 파편 (relation_type 포함)
 * @param {Object}   [opts]
 * @param {number}   [opts.windowMs]   전후 인정 시간창
 * @param {number}   [opts.maxSide]    전 구간·후 구간 각각의 최대 건수
 * @param {number}   [opts.maxCausal]  인과 연결 최대 건수
 * @returns {Object|null} 조합할 내용이 없으면 null
 */
export function stitchFragment(fragment, sources = {}, opts = {}) {
  if (!fragment || !fragment.created_at) return null;

  const windowMs  = opts.windowMs  ?? DEFAULT_WINDOW_MS;
  const maxSide   = opts.maxSide   ?? 2;
  const maxCausal = opts.maxCausal ?? 3;

  const nearby = Array.isArray(sources.nearby) ? sources.nearby : [];
  const linked = Array.isArray(sources.linked) ? sources.linked : [];

  /** 인과 연결에 이미 등장한 파편은 전후 맥락에서 제외해 같은 내용이 두 번 노출되지 않게 한다. */
  const causal = linked
    .filter(l => CAUSAL_RELATIONS.has(l.relation_type))
    .slice(0, maxCausal)
    .map(l => ({
      id           : l.id,
      relation_type: l.relation_type,
      content      : l.content,
    }));

  const causalIds = new Set(causal.map(c => c.id));

  const timed = nearby
    .filter(n => n && n.id !== fragment.id && !causalIds.has(n.id) && n.created_at)
    .map(n => ({ ...n, delta: deltaMinutes(fragment.created_at, n.created_at) }))
    .filter(n => n.delta !== null && Math.abs(n.delta) * 60000 <= windowMs);

  const pre = timed
    .filter(n => n.delta < 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, maxSide)
    .map(toContextItem);

  const post = timed
    .filter(n => n.delta >= 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, maxSide)
    .map(toContextItem);

  if (pre.length === 0 && post.length === 0 && causal.length === 0) return null;

  return {
    target: { id: fragment.id, created_at: fragment.created_at },
    pre,
    post,
    causal,
  };
}

/**
 * 시간 인접 파편을 응답용 항목으로 축약한다.
 *
 * @param {Object} n
 * @returns {Object}
 */
function toContextItem(n) {
  return {
    id        : n.id,
    content   : n.content,
    type      : n.type,
    created_at: n.created_at,
    delta_min : n.delta,
  };
}

/**
 * 조합 결과의 대략적 토큰 비용을 센다. 4바이트당 1토큰으로 근사한다.
 *
 * @param {Object} stitch
 * @returns {number}
 */
export function estimateStitchTokens(stitch) {
  if (!stitch) return 0;
  const texts = [
    ...stitch.pre.map(p => p.content || ""),
    ...stitch.post.map(p => p.content || ""),
    ...stitch.causal.map(c => c.content || ""),
  ];
  return texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
}

/**
 * 토큰 예산에 맞춰 조합 결과를 축약한다.
 *
 * 예산 초과 시 전후 각 1건으로 줄이고, 그래도 넘치면 뒤쪽 항목부터 버린다.
 * 앵커·핵심 파편이 스티칭 때문에 예산에서 밀려나는 것을 막는 안전장치다.
 *
 * @param {Array<{fragmentId: string, stitch: Object}>} stitches
 * @param {number} tokenBudget  전체 응답 토큰 예산
 * @param {number} [ratio]      스티칭이 쓸 수 있는 예산 비율
 * @returns {Array<{fragmentId: string, stitch: Object}>}
 */
export function applyStitchBudget(stitches, tokenBudget, ratio = 0.4) {
  const cap = Math.max(0, Math.floor((tokenBudget || 0) * ratio));
  if (cap === 0) return [];

  const total = stitches.reduce((sum, s) => sum + estimateStitchTokens(s.stitch), 0);
  if (total <= cap) return stitches;

  /** 1차 축약: 전후 각 1건으로 제한 */
  const trimmed = stitches.map(s => ({
    fragmentId: s.fragmentId,
    stitch    : {
      ...s.stitch,
      pre : s.stitch.pre.slice(0, 1),
      post: s.stitch.post.slice(0, 1),
    },
  }));

  const result = [];
  let   used   = 0;
  for (const item of trimmed) {
    const cost = estimateStitchTokens(item.stitch);
    if (used + cost > cap) break;
    used += cost;
    result.push(item);
  }
  return result;
}

/**
 * 조합 결과를 사람이 읽는 트리 문자열로 만든다.
 *
 * @param {Object} stitch
 * @param {string} targetContent 기준 파편 본문
 * @returns {string[]} 줄 배열
 */
export function renderStitch(stitch, targetContent = "") {
  if (!stitch) return [];

  const lines = [`- (Main Target) ${truncate(targetContent, 120)} (${formatTime(stitch.target.created_at)})`];

  for (const p of stitch.pre) {
    lines.push(`  - Pre-Context (${p.delta_min}분): ${truncate(p.content, 100)} (${formatTime(p.created_at)})`);
  }
  for (const p of stitch.post) {
    lines.push(`  - Post-Context (+${p.delta_min}분): ${truncate(p.content, 100)} (${formatTime(p.created_at)})`);
  }
  for (const c of stitch.causal) {
    lines.push(`  - Causal Link [${c.relation_type}]: ${truncate(c.content, 100)}`);
  }

  return lines;
}

/**
 * 문자열을 지정 길이로 자르고 잘렸으면 말줄임을 붙인다.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/**
 * ISO 시각을 분 단위까지 표기한다.
 *
 * @param {string|Date} value
 * @returns {string}
 */
function formatTime(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "?";
  return d.toISOString().slice(0, 16).replace("T", " ");
}
