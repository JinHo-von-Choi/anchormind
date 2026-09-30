/**
 * 관리 콘솔 라우트 정합 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * 두 가지 구조를 본다.
 *   1. admin-keys.js 라우트 표: 핸들러가 정의되어 있는지, (메서드, 경로)가 중복되지 않는지,
 *      앞선 변수 경로가 뒤의 구체 경로를 가로채지 않는지.
 *   2. 콘솔 프런트엔드(assets/admin)가 호출하는 경로마다 서버 쪽에 그 경로를 받는 판정이 있는지.
 *
 * 경로 목록 전체를 고정하지 않는다. 경로를 추가하거나 이름을 바꿔도 콘솔과 서버가
 * 서로 맞으면 통과하고, 어느 한쪽만 바뀌어 어긋나면 실패한다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

const HERE       = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(HERE, "..", "..");
const ADMIN_DIR  = path.join(ROOT, "lib", "admin");
const CONSOLE    = path.join(ROOT, "assets", "admin");
const BASE       = "/v1/internal/model/nothing";
const PARAM      = ":param";

/** 디렉터리 아래 .js 파일을 재귀로 모은다. */
function listJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  1. admin-keys.js 라우트 표                                          */
/* ------------------------------------------------------------------ */

const KEYS_SRC   = readFileSync(path.join(ADMIN_DIR, "admin-keys.js"), "utf8");
const ROUTE_LINE = /\{\s*method:\s*"([A-Z]+)",\s*match:\s*(exact|regex)\((?:new RegExp\()?`([^`]+)`\)?\),\s*handler:\s*(\w+)\s*\}/g;

/** 라우트 표를 읽어 판정 정규식과 대표 경로 표본을 만든다. */
function readKeyRoutes() {
  return [...KEYS_SRC.matchAll(ROUTE_LINE)].map(([, method, kind, raw, handler]) => {
    const source = raw.replace(/\$\{ADMIN_BASE\}/g, BASE);
    const sample = source.replace(/^\^/, "").replace(/\$$/, "").replace(/\(\[\^\/\]\+\)/g, "x");
    const test   = kind === "exact" ? (p) => p === source : (p) => new RegExp(source).test(p);
    return { method, kind, source, sample, handler, test };
  });
}

describe("admin-keys 라우트 표", () => {
  const routes = readKeyRoutes();

  test("라우트가 추출된다", () => {
    assert.ok(routes.length >= 10, `추출된 라우트가 ${routes.length}건뿐이다. 표 형식이 바뀌었을 수 있다`);
  });

  test("표의 줄 수와 추출된 라우트 수가 같다", () => {
    const declared = (KEYS_SRC.match(/^\s*\{\s*method:/gm) || []).length;
    assert.equal(routes.length, declared, "판독하지 못한 표 항목이 있다");
  });

  test("모든 핸들러가 같은 파일에 함수로 정의되어 있다", () => {
    for (const r of routes) {
      const defined = new RegExp(`(?:async\\s+)?function\\s+${r.handler}\\b|const\\s+${r.handler}\\s*=`).test(KEYS_SRC);
      assert.ok(defined, `핸들러 ${r.handler} 정의 없음`);
    }
  });

  test("허용된 HTTP 메서드만 쓴다", () => {
    for (const r of routes) assert.ok(["GET", "POST", "PUT", "PATCH", "DELETE"].includes(r.method), r.method);
  });

  test("(메서드, 경로)가 중복되지 않는다", () => {
    const seen = new Set();
    for (const r of routes) {
      const id = `${r.method} ${r.source}`;
      assert.ok(!seen.has(id), `중복 라우트: ${id}`);
      seen.add(id);
    }
  });

  test("모든 경로가 관리자 기저 경로 아래에 있다", () => {
    for (const r of routes) assert.ok(r.sample.startsWith(BASE), r.source);
  });

  test("앞선 항목이 같은 메서드의 뒤 항목 경로를 가로채지 않는다", () => {
    for (let i = 0; i < routes.length; i += 1) {
      for (let j = i + 1; j < routes.length; j += 1) {
        if (routes[i].method !== routes[j].method) continue;
        assert.ok(
          !routes[i].test(routes[j].sample),
          `${routes[i].method} ${routes[i].source}가 뒤의 ${routes[j].source}를 먼저 잡는다`
        );
      }
    }
  });

  test("모든 라우트가 자기 대표 경로를 스스로 판정한다", () => {
    for (const r of routes) assert.ok(r.test(r.sample), `${r.source}가 자기 표본 ${r.sample}에 응답하지 않는다`);
  });
});

/* ------------------------------------------------------------------ */
/*  2. 콘솔이 부르는 경로와 서버 판정의 정합                             */
/* ------------------------------------------------------------------ */

/** 소스 조각 하나를 `:param` 표기의 경로로 환원한다. */
function canonicalize(raw) {
  return raw
    .replace(/\$\{ADMIN_BASE\}/g, BASE)
    .replace(/\$\{SESSION_PREFIX\}/g, `${BASE}/sessions`)
    .replace(/\$\{MEMORY_PREFIX\}/g, `${BASE}/memory`)
    .replace(/\((\\\/[a-z-]+)\)\?/gi, (_, g) => g.replace(/\\\//, "/"))
    .replace(/\((?:\[[^\]]*\]|[^)])*\)/g, PARAM)
    .replace(/\\\//g, "/")
    .replace(/[\^$]/g, "");
}

/** 서버 소스에서 경로 판정 지점을 모은다. */
function collectServerRoutes() {
  const found = new Set();
  for (const file of readdirSync(ADMIN_DIR).filter(f => f.endsWith(".js"))) {
    const flat = readFileSync(path.join(ADMIN_DIR, file), "utf8").replace(/\s+/g, " ");
    const memoryPrefix = (receiver) => (receiver === "subPath" ? `${BASE}/memory` : "");

    for (const m of flat.matchAll(/url\.pathname\s*(?:!==|===)\s*[`"]([^`"]+)[`"]/g)) found.add(canonicalize(m[1]));
    for (const m of flat.matchAll(/url\.pathname\s*===\s*(SESSION_PREFIX|MEMORY_PREFIX|ADMIN_BASE)\b/g)) found.add(canonicalize(`\${${m[1]}}`));
    for (const m of flat.matchAll(/(url\.pathname|subPath)\.match\(\s*new RegExp\(\s*`([^`]+)`/g)) found.add(memoryPrefix(m[1]) + canonicalize(m[2]));
    for (const m of flat.matchAll(/(url\.pathname|subPath)\.match\(\s*\/((?:\[[^\]]*\]|[^/\\]|\\.)+)\//g)) found.add(memoryPrefix(m[1]) + canonicalize(m[2]));
    for (const m of flat.matchAll(/exact\(\s*`([^`]+)`\s*\)/g)) found.add(canonicalize(m[1]));
    for (const m of flat.matchAll(/regex\(\s*new RegExp\(\s*`([^`]+)`\s*\)\s*\)/g)) found.add(canonicalize(m[1]));
    for (const m of flat.matchAll(/url\.pathname\.endsWith\("([^"]+)"\)/g)) found.add(`${BASE}${m[1]}`);
    for (const m of flat.matchAll(/subPath\s*===\s*"([^"]+)"/g)) found.add(`${BASE}/memory${m[1]}`);
    for (const m of flat.matchAll(/subPath\.startsWith\("([^"]+)"\)/g)) found.add(`${BASE}/memory${m[1].replace(/\/$/, "")}/${PARAM}`);
  }
  return [...found].map(p => p.replace(/\/+$/, "")).filter(p => p.startsWith(BASE)).sort();
}

/**
 * `api(` 호출의 첫 인자를 최상위 쉼표나 닫는 괄호 직전까지 잘라 낸다.
 * 문자열, 템플릿 리터럴, 중첩 괄호 안의 쉼표는 구분자로 보지 않는다.
 */
function readFirstArgument(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (quote === "`" && ch === "$" && src[i + 1] === "{") {
        let braces = 0;
        for (; i < src.length; i += 1) {
          if (src[i] === "{") braces += 1;
          if (src[i] === "}" && (braces -= 1) === 0) break;
        }
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth += 1;
    if (ch === ")") { if (depth === 0) return src.slice(start, i); depth -= 1; }
    if (ch === "," && depth === 0) return src.slice(start, i);
  }
  return src.slice(start);
}

/** 첫 인자 표현식을 경로 문자열로 환원한다. 동적 조각은 `:param`이 된다. */
function toPath(expr) {
  let out = "";
  let i   = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "\"" || ch === "'") {
      const end = expr.indexOf(ch, i + 1);
      out += expr.slice(i + 1, end);
      i    = end + 1;
    } else if (ch === "`") {
      i += 1;
      while (i < expr.length && expr[i] !== "`") {
        if (expr[i] === "$" && expr[i + 1] === "{") {
          let braces = 0;
          for (; i < expr.length; i += 1) {
            if (expr[i] === "{") braces += 1;
            if (expr[i] === "}" && (braces -= 1) === 0) break;
          }
          out += PARAM;
        } else {
          out += expr[i];
        }
        i += 1;
      }
      i += 1;
    } else if (/[A-Za-z_$]/.test(ch)) {
      const m = expr.slice(i).match(/^[\w$.]+(?:\([^)]*\))?/);
      out += PARAM;
      i   += m[0].length;
    } else {
      i += 1;
    }
  }
  return out.replace(/(:param)+/g, PARAM).split("?")[0].replace(/\/+$/, "");
}

/** 콘솔 소스에서 `api(...)` 호출 경로를 모은다. */
function collectConsolePaths() {
  const found = new Map();
  for (const file of listJs(CONSOLE)) {
    if (path.basename(file) === "api.js") continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bapi\(\s*/g)) {
      const p = toPath(readFirstArgument(src, m.index + m[0].length));
      if (p.startsWith("/")) found.set(p, path.relative(ROOT, file));
    }
  }
  return found;
}

/** 두 경로가 `:param`을 와일드카드로 보고 같은 형태인지 판정한다. */
function sameShape(a, b) {
  const sa = a.split("/");
  const sb = b.split("/");
  if (sa.length !== sb.length) return false;
  return sa.every((seg, i) => seg === sb[i] || seg === PARAM || sb[i] === PARAM);
}

describe("콘솔 호출 경로와 서버 판정", () => {
  const server  = collectServerRoutes().map(p => p.slice(BASE.length));
  const consolePaths = collectConsolePaths();

  test("서버 경로 판정이 추출된다", () => {
    assert.ok(server.length >= 20, `서버 경로가 ${server.length}건뿐이다. 추출기가 깨졌을 수 있다`);
  });

  test("콘솔 호출 경로가 추출된다", () => {
    assert.ok(consolePaths.size >= 15, `콘솔 경로가 ${consolePaths.size}건뿐이다. 추출기가 깨졌을 수 있다`);
  });

  test("콘솔이 부르는 모든 경로를 서버가 받는다", () => {
    for (const [p, file] of consolePaths) {
      assert.ok(server.some(route => sameShape(route, p)), `서버에 ${p} 판정이 없다 (${file})`);
    }
  });

  test("콘솔 핵심 화면의 경로가 서버에 있다", () => {
    for (const p of ["/stats", "/activity", "/keys", "/groups", "/auth", "/memory/fragments", "/sessions", "/logs/files"]) {
      assert.ok(server.includes(p), `핵심 경로 누락: ${p}`);
    }
  });
});
