/**
 * CLI 명령 등록 정합 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * bin/memento.js 의 명령 표, 원격 미지원 목록, lib/cli 구현 파일, 자동완성 목록,
 * --help 출력이 서로 어긋나지 않는지 본다. 명령이나 옵션의 전체 목록은 고정하지 않으므로
 * 명령을 더하거나 빼도 다섯 곳이 함께 맞으면 통과한다.
 */

import { test, describe }   from "node:test";
import assert               from "node:assert/strict";
import { execFileSync }     from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath }    from "node:url";
import path                 from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const BIN  = path.join(ROOT, "bin", "memento.js");
const SRC  = readFileSync(BIN, "utf8");

/** COMMANDS 표에서 명령 이름과 구현 파일 경로를 읽는다. */
function readCommandTable() {
  const block = SRC.match(/const COMMANDS = \{([\s\S]*?)\n\};/);
  assert.ok(block, "bin/memento.js에서 COMMANDS 표를 찾지 못했다");
  return [...block[1].matchAll(/^\s*['"]?([a-z][a-z-]*)['"]?\s*:\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/gm)]
    .map(([, name, rel]) => ({ name, rel, file: path.resolve(path.dirname(BIN), rel) }));
}

/** LOCAL_ONLY_COMMANDS 집합의 이름을 읽는다. */
function readLocalOnly() {
  const block = SRC.match(/const LOCAL_ONLY_COMMANDS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "bin/memento.js에서 LOCAL_ONLY_COMMANDS를 찾지 못했다");
  return [...block[1].matchAll(/["']([a-z][a-z-]*)["']/g)].map(m => m[1]);
}

/** --help 출력의 Commands 절에서 명령 이름만 뽑는다. */
function readHelpCommands(help) {
  const out = [];
  let inSection = false;
  for (const line of help.split("\n")) {
    if (/^Commands:/.test(line)) { inSection = true; continue; }
    if (/^\S/.test(line))        { inSection = false; continue; }
    if (!inSection) continue;
    const name = line.trim().split(/\s/)[0];
    if (/^[a-z][a-z-]*$/.test(name)) out.push(name);
  }
  return out;
}

describe("CLI 명령 표", () => {
  const table = readCommandTable();

  test("명령이 추출되고 이름이 중복되지 않는다", () => {
    assert.ok(table.length >= 10, `추출된 명령이 ${table.length}건뿐이다`);
    assert.equal(new Set(table.map(c => c.name)).size, table.length);
  });

  test("표의 항목 수와 추출된 명령 수가 같다", () => {
    const block    = SRC.match(/const COMMANDS = \{([\s\S]*?)\n\};/)[1];
    const declared = (block.match(/\(\)\s*=>\s*import\(/g) || []).length;
    assert.equal(table.length, declared);
  });

  test("모든 명령의 구현 파일이 존재한다", () => {
    for (const c of table) assert.ok(existsSync(c.file), `${c.name}: ${c.rel} 없음`);
  });

  test("모든 구현 모듈이 기본 내보내기 함수를 가진다", async () => {
    for (const c of table) {
      const mod = await import(c.file);
      assert.equal(typeof mod.default, "function", `${c.name}: default export가 함수가 아니다`);
    }
  });

  test("lib/cli의 명령 구현 파일이 모두 표에 등록되어 있다", () => {
    const registered = new Set(table.map(c => path.basename(c.file)));
    const helpers    = new Set(["parseArgs.js"]);
    for (const file of readdirSync(path.join(ROOT, "lib", "cli")).filter(f => f.endsWith(".js"))) {
      if (file.startsWith("_") || helpers.has(file)) continue;
      assert.ok(registered.has(file), `lib/cli/${file}이 COMMANDS에 등록되지 않았다`);
    }
  });

  test("원격 미지원 목록은 등록된 명령의 부분집합이다", () => {
    const names = new Set(table.map(c => c.name));
    for (const cmd of readLocalOnly()) assert.ok(names.has(cmd), `LOCAL_ONLY_COMMANDS의 "${cmd}"가 COMMANDS에 없다`);
  });

  test("원격 호출을 허용하는 명령 안내가 실제 등록 명령을 가리킨다", () => {
    const names = new Set(table.map(c => c.name));
    const line  = SRC.match(/원격 모드를 지원하는 명령:\s*([^'"`\n]+)/);
    assert.ok(line, "원격 지원 안내 문구를 찾지 못했다");
    const listed = line[1].split(",").map(s => s.trim()).filter(Boolean);
    const local  = new Set(readLocalOnly());
    for (const cmd of listed) {
      assert.ok(names.has(cmd), `안내된 원격 명령 "${cmd}"가 등록되어 있지 않다`);
      assert.ok(!local.has(cmd), `안내된 원격 명령 "${cmd}"가 로컬 전용으로도 표시되어 있다`);
    }
  });
});

describe("CLI 명령 표와 다른 목록의 정합", () => {
  const table = readCommandTable();

  test("--help의 Commands 절이 등록된 모든 명령을 나열한다", () => {
    const help   = execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
    const listed = new Set(readHelpCommands(help));
    for (const c of table) assert.ok(listed.has(c.name), `--help에 "${c.name}" 누락`);
  });

  test("자동완성 목록이 등록된 명령과 같은 집합이다", async () => {
    const { COMMANDS } = await import("../../lib/cli/completion.js");
    assert.deepEqual([...COMMANDS].sort(), table.map(c => c.name).sort());
  });

  test("알 수 없는 명령은 비정상 종료한다", () => {
    assert.throws(
      () => execFileSync(process.execPath, [BIN, "no-such-command"], { stdio: "pipe" }),
      (err) => err.status === 1
    );
  });
});
