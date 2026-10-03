#!/usr/bin/env node
/**
 * import 순환 검사
 *
 * lib, config, scripts, bin, server.js의 상대 경로 import를 그래프로 모으고 Tarjan
 * 강연결요소로 크기 2 이상의 순환을 찾는다. 정적 import만 본 결과와 동적 import를
 * 포함한 결과를 각각 출력한다. 존재하지 않는 파일을 가리키는 상대 경로 지정자는
 * 확장자를 포함한 정확한 경로로 해석하며(Node ESM 규칙), 해석하지 못하면 따로 모아 출력한다.
 * 시간 복잡도는 O(V+E)다.
 *
 * 사용: node scripts/import-cycles.js
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import fs                from "node:fs";
import path              from "node:path";
import { fileURLToPath } from "node:url";
import { Linter }        from "eslint";

const REPO_ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS    = ["lib", "config", "scripts", "bin"];
const SCAN_FILES   = ["server.js"];

/**
 * 소스에서 import 지정자를 모은다.
 *
 * @param {string} source - ES 모듈 소스
 * @returns {{ specs: Array<{ spec: string, kind: "static"|"dynamic" }>, nonLiteral: number }}
 */
export function collectImports(source) {
  const specs    = [];
  let nonLiteral = 0;
  const collect  = {
    create() {
      return {
        ImportDeclaration(node)      { specs.push({ spec: node.source.value, kind: "static" }); },
        ExportNamedDeclaration(node) { if (node.source) specs.push({ spec: node.source.value, kind: "static" }); },
        ExportAllDeclaration(node)   { specs.push({ spec: node.source.value, kind: "static" }); },
        ImportExpression(node) {
          if (node.source.type === "Literal") specs.push({ spec: node.source.value, kind: "dynamic" });
          else nonLiteral++;
        }
      };
    }
  };
  const messages = new Linter().verify(source, [{
    plugins        : { graph: { rules: { collect } } },
    rules          : { "graph/collect": "error" },
    languageOptions: { ecmaVersion: "latest", sourceType: "module" }
  }]);
  const fatal = messages.find(m => m.fatal);
  if (fatal) throw new Error(`parse failed: ${fatal.message}`);
  return { specs, nonLiteral };
}

/** 디렉터리 아래 .js 파일을 재귀로 나열한다. */
function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * 파일 간 import 간선 그래프를 만든다. 상대 경로 지정자 중 존재하는 파일만 간선이 되고,
 * 존재하지 않는 파일을 가리키는 지정자는 unresolved 로 모은다.
 *
 * @param {string} [root] - 저장소 루트
 * @returns {{ edges: Map<string, Array<{ to: string, kind: string }>>, nonLiteral: string[], unresolved: string[] }}
 */
export function buildImportGraph(root = REPO_ROOT) {
  const files = [
    ...SCAN_DIRS.flatMap(d => (fs.existsSync(path.join(root, d)) ? listJsFiles(path.join(root, d)) : [])),
    ...SCAN_FILES.map(f => path.join(root, f)).filter(f => fs.existsSync(f))
  ];
  const rel        = (abs) => path.relative(root, abs).split(path.sep).join("/");
  const edges      = new Map();
  const nonLiteral = [];
  const unresolved = [];
  for (const file of files.sort()) {
    const { specs, nonLiteral: count } = collectImports(fs.readFileSync(file, "utf8"));
    const from = rel(file);
    if (count > 0) nonLiteral.push(from);
    const list = [];
    for (const { spec, kind } of specs) {
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        unresolved.push(`${from} -> ${spec}`);
        continue;
      }
      list.push({ to: rel(target), kind });
    }
    edges.set(from, list);
  }
  return { edges, nonLiteral, unresolved };
}

/**
 * 크기 2 이상의 강연결요소를 찾는다.
 *
 * @param {Map<string, Array<{ to: string, kind: string }>>} edges
 * @param {{ includeDynamic: boolean }} options
 * @returns {string[][]} 정렬된 파일 목록의 배열, 첫 원소 순 정렬
 */
export function findCycles(edges, { includeDynamic }) {
  const index   = new Map();
  const low     = new Map();
  const onStack = new Set();
  const stack   = [];
  const out     = [];
  let   counter = 0;
  const visit   = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const { to, kind } of edges.get(v) ?? []) {
      if (!includeDynamic && kind === "dynamic") continue;
      if (!index.has(to)) {
        visit(to);
        low.set(v, Math.min(low.get(v), low.get(to)));
      } else if (onStack.has(to)) {
        low.set(v, Math.min(low.get(v), index.get(to)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) out.push(component.sort());
    }
  };
  for (const v of edges.keys()) if (!index.has(v)) visit(v);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { edges, nonLiteral, unresolved } = buildImportGraph();
  const print = (label, cycles) => {
    console.log(`${label}: ${cycles.length}`);
    for (const c of cycles) console.log(`  ${c.join(" | ")}`);
  };
  print("static cycles", findCycles(edges, { includeDynamic: false }));
  print("static+dynamic cycles", findCycles(edges, { includeDynamic: true }));
  console.log(`non-literal dynamic imports: ${nonLiteral.length}`);
  for (const f of nonLiteral) console.log(`  ${f}`);
  console.log(`unresolved relative imports: ${unresolved.length}`);
  for (const u of unresolved) console.log(`  ${u}`);
}
