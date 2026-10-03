/**
 * 스위치 대장 시험이 공유하는 소스 탐색 도우미
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { readdirSync } from "node:fs";
import path            from "node:path";

/**
 * 소스에서 envBool, envEnum으로 읽는 변수 이름을 모은다.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function helperReadNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/\benv(?:Bool|Enum)\(\s*"([A-Z][A-Z0-9_]*)"/g)) names.add(m[1]);
  for (const loop of source.matchAll(/for \(const name of \[([\s\S]*?)\]\) env(?:Bool|Enum)\(name/g)) {
    for (const m of loop[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)) names.add(m[1]);
  }
  return names;
}

/**
 * 디렉터리 아래 .js 파일을 재귀로 모은다.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}
