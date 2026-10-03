/**
 * 민감 정보 패턴 표 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 규칙 표가 다른 모듈을 가져오지 않는 잎 모듈이고, 저장 경로 스캐너와 로거가 같은 표를 쓰는지 본다.
 */

import { describe, it }  from "node:test";
import assert            from "node:assert/strict";
import { readFileSync }  from "node:fs";
import path              from "node:path";
import { fileURLToPath } from "node:url";

import { patternsFor }       from "../../lib/security/sensitivePatterns.js";
import { REDACT_PATTERNS }   from "../../lib/logger.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

/** 주석을 뺀 소스 */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("민감 정보 패턴 표", () => {
  it("규칙 표는 모듈을 가져오지 않고 환경과 설정을 읽지 않는다", () => {
    const src = code("lib/security/sensitivePatterns.js");
    assert.doesNotMatch(src, /^\s*import\s/m);
    assert.doesNotMatch(src, /\brequire\s*\(/);
    assert.doesNotMatch(src, /\bimport\s*\(/);
    assert.doesNotMatch(src, /process\.env/);
    assert.doesNotMatch(src, /dotenv/);
  });

  it("스캐너는 규칙 표만 가져온다", () => {
    const imports = [...code("lib/security/SensitiveScanner.js").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["./sensitivePatterns.js"]);
  });

  it("스캐너와 규칙 표는 로그와 파일을 기록하지 않는다", () => {
    for (const rel of ["lib/security/SensitiveScanner.js", "lib/security/sensitivePatterns.js"]) {
      assert.doesNotMatch(code(rel), /console\.|logger|logInfo|logWarn|logError|writeFile/, rel);
    }
  });

  it("로거의 마스킹 패턴은 규칙 표의 로그용 항목과 같은 정규식 객체다", () => {
    const table = patternsFor("log");
    assert.equal(REDACT_PATTERNS.length, table.length);
    REDACT_PATTERNS.forEach((entry, i) => {
      assert.equal(entry.pattern, table[i].pattern, table[i].id);
      assert.equal(entry.replacement, table[i].log, table[i].id);
    });
  });

  it("로거 소스는 마스킹 패턴을 따로 정의하지 않는다", () => {
    const src = code("lib/logger.js");
    assert.match(src, /patternsFor\("log"\)/);
    assert.doesNotMatch(src, /Authorization\\s/);
  });
});
