/**
 * 구조 검사용 소스 스캐너
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 모듈 소스를 ESLint 파서로 읽어 호출식과 문자열 상수를 모으고, 각 항목을 감싼 이름 있는
 * 함수의 목록(바깥에서 안쪽 순)을 붙인다. 이름은 함수 선언, 클래스 메서드, 변수에 담긴
 * 함수, 객체 속성 함수, default 내보내기에서 얻는다. 템플릿 문자열은 보간 자리를 "${}"로 둔다.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path                                     from "node:path";
import { fileURLToPath }                        from "node:url";
import { Linter }                               from "eslint";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 저장소 기준 상대 디렉터리 아래 .js, .mjs 파일의 상대 경로를 모은다.
 *
 * @param {string} relDir
 * @returns {string[]}
 */
export function listSourceFiles(relDir) {
  const out  = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.(m?js)$/.test(name)) out.push(path.relative(ROOT, abs).split(path.sep).join("/"));
    }
  };
  walk(path.join(ROOT, relDir));
  return out.sort();
}

/** 함수 노드의 이름. 이름을 얻지 못하면 null. */
function functionName(node, parent) {
  if (node.type === "FunctionDeclaration") return node.id?.name ?? (parent?.type === "ExportDefaultDeclaration" ? "default" : null);
  if (!parent) return null;
  if (parent.type === "MethodDefinition" || parent.type === "Property" || parent.type === "PropertyDefinition") {
    return parent.key?.name ?? parent.key?.value ?? null;
  }
  if (parent.type === "VariableDeclarator")       return parent.id?.name ?? null;
  if (parent.type === "ExportDefaultDeclaration") return "default";
  if (parent.type === "AssignmentExpression")     return parent.left?.property?.name ?? null;
  return node.id?.name ?? null;
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * 문자열 조각 목록. 리터럴은 { lit }, 보간이나 연결된 식은 { expr }(식별자면 이름, 아니면 null)이다.
 * 템플릿 문자열과 + 연결을 같은 형태로 펼친다.
 */
function stringParts(node) {
  if (node.type === "Literal" && typeof node.value === "string") return [{ lit: node.value }];
  if (node.type === "TemplateLiteral") {
    const parts = [];
    node.quasis.forEach((q, i) => {
      parts.push({ lit: q.value.cooked ?? q.value.raw });
      if (i < node.expressions.length) parts.push(...exprPart(node.expressions[i]));
    });
    return parts;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") return [...stringParts(node.left), ...stringParts(node.right)];
  return exprPart(node);
}

function exprPart(node) {
  const isString = node.type === "Literal" && typeof node.value === "string";
  const isConcat = node.type === "BinaryExpression" && node.operator === "+";
  if (isString || isConcat || node.type === "TemplateLiteral") return stringParts(node);
  return [{ expr: node.type === "Identifier" ? node.name : null }];
}

/** 호출 인자 요약. 객체 리터럴은 키 목록, 식별자는 이름이다. */
function describeArg(arg) {
  if (!arg) return { kind: "none" };
  if (arg.type === "ObjectExpression") {
    const keys    = arg.properties.filter(p => p.type === "Property" && !p.computed).map(p => p.key.name ?? p.key.value);
    const spreads = arg.properties.some(p => p.type === "SpreadElement");
    return { kind: "object", keys, spreads };
  }
  if (arg.type === "Identifier") return { kind: "identifier", name: arg.name };
  return { kind: "other" };
}

/**
 * 모듈 소스를 읽어 호출식, 문자열, import 경로(정적과 리터럴 동적), 바인딩을 모은다.
 *
 * - calls: { callee, receiver, method, args, scope, line }
 * - strings: { text, scope, line }. 템플릿과 + 연결은 보간 자리를 "${}"로 두되, 같은 파일의
 *   문자열 상수(const X = "..." 또는 템플릿 상수)를 가리키면 그 값으로 채운다. 연결식은 가장 바깥 식
 *   하나로 남긴다.
 * - bindings: { name, source, scope }. `x = new C()`는 source "new C", `x = a.b`는 source "a.b"
 * - objectVars: { name, keys, scope }. 객체 리터럴로 초기화한 변수
 * - memberAssigns: { object, property, scope }. `x.p = ...`
 *
 * @param {string} source
 */
export function scanSource(source) {
  const calls         = [];
  const rawStrings    = [];
  const imports       = [];
  const constStrings  = new Map();
  const constParts    = new Map();
  const bindings      = [];
  const objectVars    = [];
  const memberAssigns = [];

  const collect = {
    create(context) {
      const sc      = context.sourceCode;
      const scopeOf = (node) => {
        const ancestors = sc.getAncestors(node);
        const names     = [];
        for (let i = 0; i < ancestors.length; i++) {
          const a = ancestors[i];
          if (!FUNCTION_TYPES.has(a.type)) continue;
          const name = functionName(a, ancestors[i - 1]);
          if (name) names.push(name);
        }
        return names;
      };
      const bindingSource = (init) => {
        if (!init) return null;
        if (init.type === "NewExpression") return `new ${sc.getText(init.callee)}`;
        if (init.type === "MemberExpression") return sc.getText(init);
        return null;
      };
      return {
        ImportDeclaration(node) { imports.push(node.source.value); },
        ImportExpression(node)  { if (node.source.type === "Literal") imports.push(node.source.value); },
        CallExpression(node) {
          const callee = node.callee;
          calls.push({
            callee  : sc.getText(callee),
            receiver: callee.type === "MemberExpression" ? sc.getText(callee.object) : null,
            method  : callee.type === "MemberExpression" && !callee.computed ? callee.property.name : null,
            args    : node.arguments.map(describeArg),
            scope   : scopeOf(node),
            line    : node.loc.start.line
          });
        },
        Literal(node) {
          if (typeof node.value === "string") rawStrings.push({ parts: [{ lit: node.value }], scope: scopeOf(node), line: node.loc.start.line });
        },
        TemplateLiteral(node) {
          rawStrings.push({ parts: stringParts(node), scope: scopeOf(node), line: node.loc.start.line });
        },
        BinaryExpression(node) {
          if (node.operator !== "+") return;
          const parent = sc.getAncestors(node).at(-1);
          if (parent?.type === "BinaryExpression" && parent.operator === "+") return;
          const parts = stringParts(node);
          if (parts.some(p => p.lit !== undefined)) rawStrings.push({ parts, scope: scopeOf(node), line: node.loc.start.line });
        },
        VariableDeclarator(node) {
          if (node.id.type !== "Identifier") return;
          const name = node.id.name;
          if (node.init?.type === "Literal" && typeof node.init.value === "string") constStrings.set(name, node.init.value);
          if (node.init?.type === "TemplateLiteral") constParts.set(name, stringParts(node.init));
          if (node.init?.type === "ObjectExpression") objectVars.push({ name, keys: describeArg(node.init).keys, scope: scopeOf(node) });
          const src = bindingSource(node.init);
          if (src) bindings.push({ name, source: src, scope: scopeOf(node) });
        },
        AssignmentExpression(node) {
          if (node.left.type !== "MemberExpression" || node.left.computed) return;
          const target = sc.getText(node.left);
          const src    = bindingSource(node.right);
          if (src) bindings.push({ name: target, source: src, scope: scopeOf(node) });
          if (node.left.object.type === "Identifier") {
            memberAssigns.push({ object: node.left.object.name, property: node.left.property.name, scope: scopeOf(node) });
          }
        }
      };
    }
  };

  const messages = new Linter().verify(source, [{
    plugins        : { scan: { rules: { collect } } },
    rules          : { "scan/collect": "error" },
    languageOptions: { ecmaVersion: "latest", sourceType: "module" }
  }]);
  const fatal = messages.find(m => m.fatal);
  if (fatal) throw new Error(`parse failed: ${fatal.message}`);

  /** 보간 자리를 같은 파일의 문자열 상수 값으로 채운다. 템플릿 상수는 한 단계 더 펼친다. */
  const resolve = (parts, depth) => parts.map(p => {
    if (p.lit !== undefined)       return p.lit;
    if (constStrings.has(p.expr))  return constStrings.get(p.expr);
    if (depth > 0 && constParts.has(p.expr)) return resolve(constParts.get(p.expr), depth - 1);
    return "${}";
  }).join("");
  const strings = rawStrings.map(({ parts, scope, line }) => ({ text: resolve(parts, 2), scope, line }));
  return { calls, strings, imports, bindings, objectVars, memberAssigns };
}

/** 저장소 기준 상대 경로 파일을 읽어 스캔한다. */
export function scanFile(relPath) {
  return scanSource(readFileSync(path.join(ROOT, relPath), "utf8"));
}
