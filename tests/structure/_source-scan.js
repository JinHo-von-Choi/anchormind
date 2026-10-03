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
 * 모듈 소스를 읽어 호출식, 문자열, import 경로(정적과 리터럴 동적)를 모은다.
 *
 * @param {string} source
 * @returns {{ calls: Array<{callee: string, scope: string[], line: number}>,
 *             strings: Array<{text: string, scope: string[], line: number}>,
 *             imports: string[] }}
 */
export function scanSource(source) {
  const calls   = [];
  const strings = [];
  const imports = [];

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
      return {
        ImportDeclaration(node) { imports.push(node.source.value); },
        ImportExpression(node)  { if (node.source.type === "Literal") imports.push(node.source.value); },
        CallExpression(node) {
          calls.push({ callee: sc.getText(node.callee), scope: scopeOf(node), line: node.loc.start.line });
        },
        Literal(node) {
          if (typeof node.value === "string") strings.push({ text: node.value, scope: scopeOf(node), line: node.loc.start.line });
        },
        TemplateLiteral(node) {
          const text = node.quasis.map(q => q.value.cooked ?? q.value.raw).join("${}");
          strings.push({ text, scope: scopeOf(node), line: node.loc.start.line });
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
  return { calls, strings, imports };
}

/** 저장소 기준 상대 경로 파일을 읽어 스캔한다. */
export function scanFile(relPath) {
  return scanSource(readFileSync(path.join(ROOT, relPath), "utf8"));
}
