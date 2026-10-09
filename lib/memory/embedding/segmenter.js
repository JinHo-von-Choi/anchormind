/**
 * segmenter - 긴 파편 본문을 겹치는 고정 길이 구간으로 나눈다
 *
 * 작성자: 최진호
 * 작성일: 2026-10-09
 *
 * 최대 1000자인 파편 본문 하나를 임베딩 벡터 하나로 만들면 곁다리 언급("그런데 방금 smoker를 샀어")이 본문의
 * 주된 화제에 희석되어 질문과 멀어진다. 구간별 벡터를 따로 두고 조각별 최대 유사도를 쓰면 이를 회수한다.
 * 분할은 문장부호에 기대지 않는다(한국어는 마침표 없는 문장이 흔하다).
 *
 * 길이와 오프셋의 단위는 모두 코드 포인트다. 대상 판정(SQL char_length)과 같은 단위라야 판정과 분할이 어긋나지 않는다.
 */

/** 분할 규칙의 버전. 규칙이나 기본 파라미터를 바꾸면 올려서 기존 구간이 재생성 대상이 되게 한다. */
export const SEGMENTER_VERSION = 1;

const SNAP_DISTANCE = 40;

/**
 * 구간 식별자. 분할 설정과 규칙 버전을 담아 설정이 바뀌면 기존 행이 낡은 것으로 판정되게 한다.
 *
 * @param {{windowChars: number, strideChars: number, maxSegments: number}} cfg
 * @returns {string}
 */
export function segmentVersion(cfg) {
  return `v${SEGMENTER_VERSION}-w${cfg.windowChars}-s${cfg.strideChars}-m${cfg.maxSegments}`;
}

const isBreak = ch => ch === " " || ch === "\n" || ch === "\t" || ch === "\r";

/**
 * 시작 경계를 가까운 공백 뒤로 당긴다(최대 SNAP_DISTANCE). 공백이 없으면 그대로 둔다.
 */
function snapStart(cp, pos, floor) {
  if (pos <= floor) return floor;
  for (let d = 0; d <= SNAP_DISTANCE && pos - d > floor; d++) {
    if (isBreak(cp[pos - d - 1])) return pos - d;
  }
  return pos;
}

/**
 * 끝 경계를 가까운 공백 앞으로 당긴다(최대 SNAP_DISTANCE). 공백이 없으면 그대로 둔다.
 */
function snapEnd(cp, pos, ceil) {
  if (pos >= ceil) return ceil;
  for (let d = 0; d <= SNAP_DISTANCE && pos - d > 0; d++) {
    if (isBreak(cp[pos - d])) return pos - d;
  }
  return pos;
}

/**
 * 본문을 구간 목록으로 나눈다.
 *
 * - 본문이 minChars 이하이면 빈 배열이다(본문 벡터로 충분하다).
 * - 창은 항상 앞으로 전진하고 마지막 창은 본문 끝에 맞춘다.
 * - 구간 수가 maxSegments를 넘으면 간격을 늘려 전체 범위를 덮는다(끝부분을 버리지 않는다).
 * - 공백뿐인 구간은 만들지 않는다.
 *
 * @param {string} content
 * @param {{windowChars?: number, strideChars?: number, minChars?: number, maxSegments?: number}} [opts]
 * @returns {Array<{idx: number, start: number, end: number, text: string}>}
 */
export function splitIntoSegments(content, opts = {}) {
  const windowChars = opts.windowChars ?? 300;
  const strideChars = opts.strideChars ?? 150;
  const minChars    = opts.minChars    ?? 400;
  const maxSegments = opts.maxSegments ?? 12;

  if (typeof content !== "string") return [];
  const cp = Array.from(content);
  if (cp.length <= minChars) return [];

  const lastStart = cp.length - windowChars;
  let   starts    = [];
  for (let s = 0; s < lastStart; s += strideChars) starts.push(s);
  starts.push(Math.max(lastStart, 0));

  if (starts.length > maxSegments) {
    /** 간격을 늘려 maxSegments개로 전체 범위를 덮는다 */
    const step = lastStart / (maxSegments - 1);
    starts = Array.from({ length: maxSegments }, (_, i) => Math.round(i * step));
  }

  const out  = [];
  let   prev = -1;
  for (let i = 0; i < starts.length; i++) {
    const rawStart = starts[i];
    const rawEnd   = Math.min(rawStart + windowChars, cp.length);
    const floor    = i === 0 ? 0 : out[out.length - 1]?.start ?? 0;
    const start    = i === 0 ? 0 : Math.max(snapStart(cp, rawStart, floor + 1), prev + 1);
    const end      = i === starts.length - 1 ? cp.length : snapEnd(cp, rawEnd, cp.length);
    if (end <= start) continue;
    const text = cp.slice(start, end).join("");
    if (text.trim() === "") continue;
    if (out.length > 0 && start === out[out.length - 1].start && end === out[out.length - 1].end) continue;
    out.push({ idx: out.length, start, end, text });
    prev = start;
  }
  return out;
}
