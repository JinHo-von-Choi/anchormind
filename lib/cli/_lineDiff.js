/**
 * 줄 단위 diff
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 두 문자열을 줄로 나눠 최장 공통 부분 수열(LCS)로 유지(" "), 삭제("-"), 추가("+") 줄 목록을 만든다.
 * 시간과 공간은 O(n*m)이다. 표의 칸 수가 MAX_CELLS를 넘으면 원본 전체 삭제 뒤 새 내용 전체 추가로
 * 대신한다(init이 다루는 설정 파일은 수백 줄 이하다).
 */

const MAX_CELLS = 4_000_000;

/**
 * 끝의 줄바꿈 하나를 뺀 줄 배열. 빈 문자열은 줄이 없다.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  if (text === "") return [];
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

/**
 * suffix LCS 길이 표. table[i][j]는 a[i..], b[j..]의 LCS 길이다.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Uint32Array[]}
 */
function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/**
 * @param {string} before
 * @param {string} after
 * @returns {Array<{ op: " "|"-"|"+", line: string }>}
 */
export function diffLines(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return [...a.map(line => ({ op: "-", line })), ...b.map(line => ({ op: "+", line }))];
  }

  const table = lcsTable(a, b);
  const out   = [];
  let   i     = 0;
  let   j     = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", line: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ op: "-", line: a[i++] });
    } else {
      out.push({ op: "+", line: b[j++] });
    }
  }
  while (i < a.length) out.push({ op: "-", line: a[i++] });
  while (j < b.length) out.push({ op: "+", line: b[j++] });
  return out;
}
