#!/usr/bin/env node
/**
 * 환경 변수 접근 점검
 *
 * lib, bin, config, server.js에서 process.env를 읽는 지점을 구문 분석으로 찾아 두 가지로 분류한다.
 *   startup: 모듈 최상위에서 읽는다. 모듈을 적재할 때 한 번 고정되므로 이후 환경 변경이 반영되지 않는다.
 *   runtime: 함수 안에서 읽는다. 호출할 때마다 읽으므로 환경 변경이 바로 반영된다.
 * lib/cli와 bin은 위 판정과 별개로 cli로 본다. CLI가 읽거나 process.env에 쓰는 값이다.
 *
 * 중앙 모듈(config/env-access.js의 CENTRAL_MODULES)은 어떤 읽기든 허용한다.
 * 그 밖의 파일은 config/env-access.js의 ENV_ACCESS에 파일, 분류, 변수, 사유가 등록돼 있어야 한다.
 * 등록되지 않은 접근, 코드에 없는 등록, 분류가 어긋난 등록은 모두 위반이다.
 *
 * 사용: node scripts/env-access-report.mjs [--strict]   (npm run env-access [-- --strict])
 * 종료 코드: 0 위반 없음, 1 위반 있음(--strict일 때만)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import fs                from "node:fs";
import path              from "node:path";
import { fileURLToPath } from "node:url";
import { parse }         from "acorn";

import { CENTRAL_MODULES, ENV_ACCESS } from "../config/env-access.js";

const ROOT       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["lib", "bin", "config", "server.js"];
const WHOLE_ENV  = "(env)";
const DYNAMIC    = "(dynamic)";
const FUNCTIONS  = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

const isProcessEnv = (node) =>
  node?.type === "MemberExpression" && !node.computed
  && node.object?.type === "Identifier" && node.object.name === "process"
  && node.property?.type === "Identifier" && node.property.name === "env";

const isCentral = (rel) => CENTRAL_MODULES.includes(rel) || rel.startsWith("config/");

/** 소스 트리의 JS 파일을 저장소 기준 상대 경로로 돌려준다. */
export function listSourceFiles(root = ROOT) {
  const out = [];
  const visit = (rel) => {
    const abs = path.join(root, rel);
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      if (/\.(m?js)$/.test(rel)) out.push(rel.split(path.sep).join("/"));
      return;
    }
    for (const name of fs.readdirSync(abs)) visit(path.join(rel, name));
  };
  for (const entry of SCAN_ROOTS) {
    if (fs.existsSync(path.join(root, entry))) visit(entry);
  }
  return out.sort();
}

/** 노드의 자식 노드를 차례로 돌려준다. */
function* children(node) {
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) yield* value.filter((v) => v && typeof v.type === "string");
    else if (value && typeof value.type === "string") yield value;
  }
}

/** process.env.X, process.env["X"], 함수에 넘기는 process.env를 변수 이름으로 풀어 돌려준다. */
function referenceName(node, parent) {
  if (parent?.type === "MemberExpression" && parent.object === node) {
    if (!parent.computed) return parent.property.name;
    return parent.property.type === "Literal" ? String(parent.property.value) : DYNAMIC;
  }
  if (parent?.type === "CallExpression") {
    const next = parent.arguments[parent.arguments.indexOf(node) + 1];
    if (next?.type === "Literal" && typeof next.value === "string") return next.value;
  }
  return WHOLE_ENV;
}

/** 한 파일의 환경 접근을 {file, line, name, scope}로 돌려준다. */
export function scanSource(rel, source) {
  const ast  = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
  const refs = [];
  const walk = (node, parent, insideFunction) => {
    if (isProcessEnv(node)) {
      refs.push({
        file : rel,
        line : node.loc.start.line,
        name : referenceName(node, parent),
        scope: insideFunction ? "runtime" : "startup"
      });
      return;
    }
    const nowInside = insideFunction || FUNCTIONS.has(node.type);
    for (const child of children(node)) walk(child, node, nowInside);
  };
  walk(ast, null, false);
  return refs;
}

/** 파일의 분류. CLI 진입점은 구문 판정과 무관하게 cli다. */
export function kindOf(ref) {
  if (ref.file.startsWith("lib/cli/") || ref.file.startsWith("bin/")) return "cli";
  return ref.scope;
}

/** 저장소 전체의 환경 접근. */
export function scanTree(root = ROOT) {
  const refs = [];
  for (const rel of listSourceFiles(root)) {
    refs.push(...scanSource(rel, fs.readFileSync(path.join(root, rel), "utf8")));
  }
  return refs;
}

/** 등록 대장과 실제 접근을 대조해 위반 목록을 돌려준다. */
export function findViolations(refs, registry = ENV_ACCESS) {
  const violations = [];
  const actual = new Map();
  for (const ref of refs.filter((r) => !isCentral(r.file))) {
    const key = `${ref.file}\u0000${kindOf(ref)}\u0000${ref.name}`;
    if (!actual.has(key)) actual.set(key, ref);
  }

  const registered = new Set();
  for (const entry of registry) {
    for (const name of entry.vars) registered.add(`${entry.file}\u0000${entry.kind}\u0000${name}`);
  }

  for (const [key, ref] of actual) {
    if (!registered.has(key)) {
      violations.push(`등록되지 않은 접근: ${ref.file}:${ref.line} ${ref.name} (${kindOf(ref)}). config/ 아래 중앙 모듈에서 읽거나 config/env-access.js에 사유와 함께 등록한다.`);
    }
  }
  for (const key of registered) {
    if (!actual.has(key)) {
      const [file, kind, name] = key.split("\u0000");
      violations.push(`코드에 없는 등록: ${file} ${name} (${kind}). 이동했거나 분류가 달라졌다면 대장을 고친다.`);
    }
  }
  return violations;
}

function printReport(refs) {
  const rows = new Map();
  for (const ref of refs) {
    const key = `${isCentral(ref.file) ? "central" : "registered"}\u0000${kindOf(ref)}\u0000${ref.name}`;
    rows.set(key, (rows.get(key) ?? 0) + 1);
  }
  const byKind = { startup: new Set(), runtime: new Set(), cli: new Set() };
  for (const key of rows.keys()) {
    const [, kind, name] = key.split("\u0000");
    if (name !== WHOLE_ENV && name !== DYNAMIC) byKind[kind].add(name);
  }
  const out = [
    "## 환경 변수 접근 현황",
    "",
    `접근 지점 ${refs.length}곳, 변수 ${new Set(refs.map((r) => r.name).filter((n) => n !== WHOLE_ENV && n !== DYNAMIC)).size}개`,
    "",
    "| 분류 | 변수 수 | 뜻 |",
    "|------|---------|----|",
    `| startup | ${byKind.startup.size} | 모듈 적재 때 한 번 읽는다 |`,
    `| runtime | ${byKind.runtime.size} | 호출할 때마다 읽는다 |`,
    `| cli | ${byKind.cli.size} | CLI 진입점이 읽거나 쓴다 |`,
    "",
    "한 변수가 여러 분류에 걸칠 수 있어 합은 변수 수보다 클 수 있다.",
    ""
  ];
  process.stdout.write(out.join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refs       = scanTree();
  const violations = findViolations(refs);
  printReport(refs);
  if (violations.length > 0) {
    process.stderr.write(`\n위반 ${violations.length}건\n${violations.map((v) => `- ${v}`).join("\n")}\n`);
    if (process.argv.includes("--strict")) process.exitCode = 1;
  }
}
