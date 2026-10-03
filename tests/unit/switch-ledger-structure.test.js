/**
 * 스위치 대장 구조 검사
 *
 * 레지스트리(config/switches.js)의 모든 스위치가 .env.example, docs/configuration.md,
 * docs/configuration.en.md에 있고 문서 기본값과 맞는지, 환경 변수 도우미(envBool, envEnum)로 읽는
 * 불리언과 열거가 레지스트리나 명시 제외 목록에 있는지 본다. 값 목록 전체를 고정하지 않는다.
 * 새 스위치를 추가하면서 대장이나 문서를 빠뜨리면 실패한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";
import { fileURLToPath } from "node:url";

import { SWITCHES } from "../../config/switches.js";
import { helperReadNames, listJs } from "./switch-source-helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * 도우미로 읽지만 기능 개폐 스위치가 아니어서 대장에 넣지 않는 변수와 그 이유.
 */
const NOT_A_SWITCH = new Map([
  ["MEMENTO_SEMANTIC_THRESHOLD_MODE",         "유사도 임계값을 적용하는 위치를 고르는 방식 선택이며 기능을 열고 닫지 않는다"],
  ["MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS",   "인증 저장소 장애 응답의 상태 코드 선택이며 기능을 열고 닫지 않는다"],
  ["EMBEDDING_SUPPORTS_DIMS_PARAM",           "기본값이 임베딩 provider에서 정해지는 재정의 값이며 고정 기본값이 없다"]
]);

const WORD = (name) => new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`);

const ENV_EXAMPLE = read(".env.example");
const DOC_KO      = read("docs/configuration.md");
const DOC_EN      = read("docs/configuration.en.md");

describe("대장의 스위치와 문서", () => {
  for (const [label, text] of [[".env.example", ENV_EXAMPLE], ["docs/configuration.md", DOC_KO], ["docs/configuration.en.md", DOC_EN]]) {
    it(`모든 스위치가 ${label}에 있다`, () => {
      const missing = SWITCHES.filter((s) => !WORD(s.name).test(text)).map((s) => s.name);
      assert.deepEqual(missing, [], `${label}에 없는 스위치: ${missing.join(", ")}`);
    });
  }

  /**
   * 표에서 변수 이름 칸 바로 뒤 칸을 기본값으로 읽는다. 이름이 첫 두 칸 중 하나인 행만 본다.
   */
  const documentedDefaults = (text, name) => text.split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .map((cells) => {
      const at = cells.findIndex((c) => c === name || c === `\`${name}\``);
      return at >= 0 && at <= 1 && cells[at + 1] !== undefined ? cells[at + 1].replace(/[`"]/g, "") : null;
    })
    .filter((v) => v !== null);

  for (const [label, text] of [["docs/configuration.md", DOC_KO], ["docs/configuration.en.md", DOC_EN]]) {
    it(`${label}의 표에 적힌 기본값이 대장과 같다`, () => {
      const mismatched = [];
      for (const s of SWITCHES.filter((x) => !x.follows)) {
        for (const cell of documentedDefaults(text, s.name)) {
          const unsetNote = s.kind === "enum" && /^\(.*\)$/.test(cell);
          if (cell !== String(s.default) && !unsetNote) mismatched.push(`${s.name}: 문서 ${cell}, 대장 ${s.default}`);
        }
      }
      assert.deepEqual(mismatched, []);
    });
  }
});

describe("도우미로 읽는 스위치", () => {
  const sources = [
    ...listJs(path.join(ROOT, "lib")),
    ...listJs(path.join(ROOT, "config")),
    path.join(ROOT, "server.js")
  ];
  const allRead    = new Set();
  for (const file of sources) for (const n of helperReadNames(readFileSync(file, "utf8"))) allRead.add(n);
  const configRead = helperReadNames(read("lib/config.js"));
  const registered = new Set(SWITCHES.map((s) => s.name));

  it("lib/config.js에서 불리언과 열거로 읽는 변수가 추출된다", () => {
    assert.ok(configRead.size >= 20, `추출된 변수가 ${configRead.size}개뿐이다. 읽기 형식이 바뀌었을 수 있다`);
    assert.ok(configRead.has("MEMENTO_CONFIG_STRICT"));
  });

  it("도우미로 읽는 불리언과 열거는 대장에 있거나 제외 목록에 이유와 함께 있다", () => {
    const loose = [...allRead].filter((n) => !registered.has(n) && !NOT_A_SWITCH.has(n));
    assert.deepEqual(loose, [], `대장에 없는 스위치: ${loose.join(", ")}`);
  });

  it("MEMENTO_ 접두 변수도 같은 규칙을 따른다", () => {
    const loose = [...configRead].filter((n) => n.startsWith("MEMENTO_") && !registered.has(n) && !NOT_A_SWITCH.has(n));
    assert.deepEqual(loose, []);
  });

  it("제외 목록의 변수는 실제로 도우미로 읽히고 대장에는 없으며 이유가 적혀 있다", () => {
    for (const [name, reason] of NOT_A_SWITCH) {
      assert.ok(allRead.has(name), `${name}은 더 이상 도우미로 읽히지 않는다`);
      assert.ok(!registered.has(name), `${name}은 대장에도 있다`);
      assert.ok(reason.length > 0, name);
    }
  });
});

describe("대장의 연결 지점", () => {
  it("기동 경로가 요약 줄을 기록한다", () => {
    const server = read("server.js");
    assert.match(server, /import \{ currentSwitchLine \}\s+from "\.\/config\/switches\.js"/);
    assert.match(server, /logInfo\(currentSwitchLine\(\)\)/);
  });

  it("관리 stats 응답이 switches 요약을 담는다", () => {
    const routes = read("lib/admin/admin-routes.js");
    assert.match(routes, /switches:\s+currentSwitchSummary\(\)/);
  });

  it("보고 스크립트가 .env를 읽는 모듈을 가져오지 않는다", () => {
    const script = read("scripts/switch-report.mjs");
    const specs  = [...script.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(specs, ["../config/switches.js"]);
    const leaf = read("config/switches.js");
    const deps = [...leaf.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(deps, ["../lib/env-parse.js"]);
    assert.ok(!/dotenv|readFile|process\.env/.test(read("lib/env-parse.js")));
  });
});
