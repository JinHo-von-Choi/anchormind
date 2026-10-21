/**
 * exactNeighbors - 같은 묶음 안 벡터들의 정확 코사인 top-k 이웃
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 *
 * semantic_dedup은 (topic, workspace, key_id) 묶음 안에서만 병합 후보를 찾는다. 묶음 크기가
 * 수천 행 이하라 묶음 벡터를 한 번 읽어 모든 쌍을 메모리에서 계산하면 파편마다 KNN 질의를
 * 보내는 것보다 DB 부하가 없고, 근사 색인이 놓치는 이웃도 없다.
 *
 * 쌍마다 한 번만 계산해 양쪽 목록에 넣는다. 행 하나를 끝낼 때마다 이벤트 루프에 양보해
 * 요청 처리를 막지 않는다.
 */

/** pgvector 텍스트 표현: 대괄호 안의 쉼표로 구분한 숫자 */
const VECTOR_TEXT = /^\[-?\d[\d.eE+-]*(,-?\d[\d.eE+-]*)*\]$/;

/**
 * pgvector 텍스트 표현("[0.1,0.2,...]")을 단위 길이 Float32Array로 바꾼다.
 *
 * @param {string|number[]} raw
 * @returns {Float32Array|null} 길이 0 벡터나 해석 불가 값이면 null
 */
export function toUnitVector(raw) {
  let values = raw;
  if (typeof raw === "string") {
    /** pgvector 텍스트 표현만 받는다. 형식이 맞으면 JSON 숫자 배열이다. */
    if (!VECTOR_TEXT.test(raw)) return null;
    values = JSON.parse(raw);
  }
  if (!Array.isArray(values) || values.length === 0) return null;
  const v = Float32Array.from(values);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) return null;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/**
 * 행마다 코사인이 가장 큰 이웃 k개를 구한다.
 *
 * 동률은 상대 인덱스가 작은 쪽을 앞에 둔다. 차원이 다른 벡터 쌍은 비교하지 않는다.
 *
 * @param {Array<Float32Array>} vectors 단위 벡터
 * @param {number} k
 * @param {{ yieldEvery?: () => Promise<void> }} [opts] 행 하나마다 호출할 양보 함수
 * @returns {Promise<Array<Array<{index: number, cosine: number}>>>} 행별 내림차순 이웃
 */
export async function topNeighbors(vectors, k, { yieldEvery = defaultYield } = {}) {
  const n    = vectors.length;
  const best = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    const a = vectors[i];
    for (let j = i + 1; j < n; j++) {
      const b = vectors[j];
      if (a.length !== b.length) continue;
      let dot = 0;
      for (let d = 0; d < a.length; d++) dot += a[d] * b[d];
      pushTop(best[i], { index: j, cosine: dot }, k);
      pushTop(best[j], { index: i, cosine: dot }, k);
    }
    await yieldEvery();
  }
  return best;
}

/** 내림차순(동률은 index 오름차순)을 유지하며 상위 k개만 남긴다. */
function pushTop(list, entry, k) {
  if (k <= 0) return;
  if (list.length === k && !before(entry, list[k - 1])) return;
  let pos = list.length;
  while (pos > 0 && before(entry, list[pos - 1])) pos--;
  list.splice(pos, 0, entry);
  if (list.length > k) list.pop();
}

function before(x, y) {
  return x.cosine > y.cosine || (x.cosine === y.cosine && x.index < y.index);
}

function defaultYield() {
  return new Promise(resolve => setImmediate(resolve));
}
