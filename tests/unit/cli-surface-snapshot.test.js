/**
 * CLI 표면 계약 스냅샷 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 서브명령 목록, 원격 미지원 명령 목록, `--help` 출력의 골격을 고정한다.
 * cli-completion.test.js가 서브명령 수만 검사하던 축을 옵션까지 넓힌 것이다.
 *
 * 도움말 본문의 설명 문구는 자유롭게 고칠 수 있어야 하므로 계약에서 뺀다.
 * 명령 이름과 옵션 플래그만 본다.
 *
 * 의도적인 표면 변경 시 SNAPSHOT_UPDATE=1 로 갱신하고 사유를 CHANGELOG에 남긴다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { execFileSync }   from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

const HERE          = path.dirname(fileURLToPath(import.meta.url));
const ROOT          = path.resolve(HERE, "..", "..");
const BIN           = path.join(ROOT, "bin", "memento.js");
const SNAPSHOT_PATH = path.join(HERE, "..", "fixtures", "cli-surface.snapshot.json");

/**
 * `--help` 출력에서 계약에 해당하는 토큰만 뽑는다.
 * Commands 절의 첫 낱말과 Options 절의 플래그가 대상이다.
 *
 * @param {string} help
 * @returns {{commands: string[], options: string[]}}
 */
export function parseHelpSurface(help) {
  const lines    = help.split("\n");
  const commands = [];
  const options  = [];
  let   section  = null;

  for (const line of lines) {
    if (/^Commands:/.test(line)) { section = "commands"; continue; }
    if (/^Options:/.test(line))  { section = "options";  continue; }
    if (/^\S/.test(line))        { section = null;       continue; }

    const trimmed = line.trim();
    if (!trimmed) continue;
    if (section === "commands") {
      const name = trimmed.split(/\s/)[0];
      if (/^[a-z][a-z-]*$/.test(name)) commands.push(name);
    } else if (section === "options") {
      const flag = trimmed.split(/\s/)[0];
      if (flag.startsWith("--")) options.push(flag);
    }
  }
  return { commands: commands.sort(), options: options.sort() };
}

const helpText = execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
const source   = readFileSync(BIN, "utf8");

/** COMMANDS 객체와 LOCAL_ONLY_COMMANDS 집합을 소스에서 그대로 읽는다. */
function readCommandTable() {
  const block = source.match(/const COMMANDS = \{([\s\S]*?)\n\};/);
  const local = source.match(/const LOCAL_ONLY_COMMANDS = new Set\(\[([\s\S]*?)\]\)/);
  return {
    registered: [...block[1].matchAll(/^\s*([a-z][a-z-]*):/gm)].map(m => m[1]).sort(),
    localOnly : [...local[1].matchAll(/"([a-z][a-z-]*)"/g)].map(m => m[1]).sort()
  };
}

describe("CLI 표면 스냅샷", () => {
  const current = { ...readCommandTable(), help: parseHelpSurface(helpText) };

  if (process.env.SNAPSHOT_UPDATE === "1") {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + "\n");
  }

  test("스냅샷 파일이 존재한다", () => {
    assert.ok(existsSync(SNAPSHOT_PATH), `스냅샷이 없다. SNAPSHOT_UPDATE=1 로 생성하라: ${SNAPSHOT_PATH}`);
  });

  test("서브명령과 옵션 목록이 스냅샷과 일치한다", () => {
    assert.deepEqual(current, JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")));
  });

  test("도움말에 등록된 모든 서브명령이 나타난다", () => {
    for (const cmd of current.registered) {
      assert.ok(current.help.commands.includes(cmd), `--help에 서브명령 "${cmd}" 누락`);
    }
  });

  test("원격 미지원 목록은 등록된 명령의 부분집합이다", () => {
    for (const cmd of current.localOnly) {
      assert.ok(current.registered.includes(cmd), `LOCAL_ONLY_COMMANDS의 "${cmd}"가 COMMANDS에 없다`);
    }
  });

  test("parseHelpSurface는 설명 문구를 계약에 넣지 않는다", () => {
    const a = parseHelpSurface("Commands:\n  serve    Start it\n\nOptions:\n  --json   As JSON\n");
    const b = parseHelpSurface("Commands:\n  serve    전혀 다른 설명\n\nOptions:\n  --json   다른 설명\n");
    assert.deepEqual(a, b);
  });
});
