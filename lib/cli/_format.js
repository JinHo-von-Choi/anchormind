/**
 * CLI 출력 포맷 유틸리티 — renderTable / renderJson / renderCsv / resolveFormat / print
 *
 * 외부 의존성 없음. 박스 드로잉 문자(┌┬┐─│) 사용 금지 — 파이프/하이픈만.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

/** 총 출력 너비 상한 (파이프 포함) */
const MAX_WIDTH = 80;

/**
 * 셀 값을 문자열로 변환.
 * null/undefined → "", 객체 → JSON 한 줄.
 */
function cellStr(val) {
  if (val === null || val === undefined) return "";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

/**
 * 문자열을 maxLen 이하로 절단. 초과 시 마지막 문자를 "…"으로 대체.
 */
function truncate(s, maxLen) {
  if (maxLen <= 0) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

/**
 * rows 배열을 파이프/하이픈 테이블로 렌더링.
 *
 * @param {object[]} rows    - 데이터 행 배열
 * @param {string[]} columns - 출력할 열 이름 목록 (rows 키와 일치)
 * @returns {string}
 */
export function renderTable(rows, columns) {
  if (!rows || rows.length === 0) return "(no data)";

  // 각 열의 헤더 길이를 초기 최대값으로 설정
  const widths = columns.map(c => c.length);

  // 데이터 셀 최대 길이 수집
  for (const row of rows) {
    for (let i = 0; i < columns.length; i++) {
      const s = cellStr(row[columns[i]]);
      if (s.length > widths[i]) widths[i] = s.length;
    }
  }

  // 전체 너비 계산: "| col1 | col2 | ... |"
  // 각 열: " " + cell + " " + "|" = width + 3, 맨 앞 "|" 1
  const rawTotal = 1 + widths.reduce((acc, w) => acc + w + 3, 0);

  // rawTotal이 MAX_WIDTH를 초과하면 열 너비를 균등 축소
  if (rawTotal > MAX_WIDTH) {
    const overhead   = 1 + columns.length * 3; // "|" 경계 + 공백
    const available  = Math.max(MAX_WIDTH - overhead, columns.length); // 셀 총 가용
    const perCol     = Math.max(1, Math.floor(available / columns.length));
    for (let i = 0; i < widths.length; i++) {
      widths[i] = Math.min(widths[i], perCol);
    }
  }

  // 헤더 행
  const headerCells = columns.map((c, i) => c.padEnd(widths[i]));
  const headerRow   = "| " + headerCells.join(" | ") + " |";

  // 구분선: "| -|-| " 스타일 — 각 열 너비만큼 하이픈
  const sepCells = widths.map(w => "-".repeat(w));
  const sepRow   = "|-" + sepCells.join("-|-") + "-|";

  // 데이터 행
  const dataRows = rows.map(row => {
    const cells = columns.map((c, i) => truncate(cellStr(row[c]), widths[i]).padEnd(widths[i]));
    return "| " + cells.join(" | ") + " |";
  });

  return [headerRow, sepRow, ...dataRows].join("\n");
}

/**
 * 단일 객체를 "Field | Value" 2열 테이블로 렌더링.
 * inspect 등 단일 레코드 출력용.
 */
export function renderFieldTable(obj) {
  const rows = Object.entries(obj).map(([k, v]) => ({ field: k, value: v }));
  return renderTable(rows, ["field", "value"]);
}

/**
 * JSON 직렬화.
 * @param {*}       obj
 * @param {boolean} pretty - true이면 2-space indent
 */
export function renderJson(obj, pretty = true) {
  return JSON.stringify(obj, null, pretty ? 2 : 0);
}

/**
 * RFC 4180 CSV 렌더링.
 * 콤마, 큰따옴표, 개행을 포함하는 셀은 큰따옴표로 감싸고 내부 큰따옴표를 "" 이스케이프.
 */
export function renderCsv(rows, columns) {
  function escapeCell(val) {
    const s = cellStr(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  const header   = columns.map(escapeCell).join(",");
  const dataRows = rows.map(row => columns.map(c => escapeCell(row[c])).join(","));
  return [header, ...dataRows].join("\n");
}

/**
 * 출력 포맷 결정.
 * 우선순위: args.format > (args.json → "json") > TTY 감지 ("table" or "json")
 *
 * @param {object} args
 * @param {string} [fallback] - TTY 미감지 시 기본값 (지정 없으면 "json")
 * @returns {"table"|"json"|"csv"|string}
 */
export function resolveFormat(args, fallback) {
  if (args.format) return args.format;
  if (args.json)   return "json";
  if (process.stdout.isTTY) return "table";
  return fallback ?? "json";
}

/**
 * 결과를 포맷에 따라 stdout 출력.
 *
 * @param {object[]|object} result  - 출력 대상 (배열이면 테이블/CSV, 객체이면 fieldTable/JSON)
 * @param {{ format: string, columns?: string[], fieldMode?: boolean }} opts
 */
export function print(result, { format, columns, fieldMode = false } = {}) {
  const fmt = format ?? "json";

  if (fmt === "json") {
    console.log(renderJson(result));
    return;
  }

  if (fmt === "csv") {
    const rows = Array.isArray(result) ? result : [result];
    const cols = columns ?? Object.keys(rows[0] ?? {});
    console.log(renderCsv(rows, cols));
    return;
  }

  // table
  if (fieldMode || !Array.isArray(result)) {
    const obj = Array.isArray(result) ? result[0] : result;
    console.log(renderFieldTable(obj ?? {}));
    return;
  }

  const cols = columns ?? Object.keys(result[0] ?? {});
  console.log(renderTable(result, cols));
}
