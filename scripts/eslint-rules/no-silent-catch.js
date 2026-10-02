/**
 * 오류를 기록하지도 전파하지도 않는 catch 처리기를 찾는다.
 *
 * 대상: 본문이 빈 catch 절(주석만 있는 경우 포함), 그리고 Promise.prototype.catch에
 * 넘긴 함수가 빈 본문이거나 상수만 돌려주는 경우.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

/**
 * 상수 반환 식인지 판정한다. 리터럴, 빈 배열, 빈 객체, undefined만 해당한다.
 *
 * @param {object|null} node
 * @returns {boolean}
 */
function isConstantValue(node) {
  if (node === null)                    return true;
  if (node.type === "Literal")          return true;
  if (node.type === "ArrayExpression")  return node.elements.length === 0;
  if (node.type === "ObjectExpression") return node.properties.length === 0;
  if (node.type === "Identifier")       return node.name === "undefined";
  return false;
}

/**
 * catch 처리기 함수가 오류를 버리기만 하는지 판정한다.
 *
 * @param {object} fn
 * @returns {boolean}
 */
function isSilentHandler(fn) {
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression") return false;
  const body = fn.body;
  if (body.type !== "BlockStatement") return isConstantValue(body);
  if (body.body.length === 0) return true;
  if (body.body.length === 1 && body.body[0].type === "ReturnStatement") {
    return isConstantValue(body.body[0].argument);
  }
  return false;
}

export default {
  meta: {
    type    : "suggestion",
    docs    : { description: "catch 처리기는 오류를 기록하거나 전파한다" },
    schema  : [],
    messages: {
      clause : "catch 절이 오류를 기록하지도 전파하지도 않는다.",
      promise: ".catch 처리기가 오류를 기록하지도 전파하지도 않는다."
    }
  },
  create(context) {
    return {
      CatchClause(node) {
        if (node.body.body.length === 0) context.report({ node, messageId: "clause" });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.property.name !== "catch" || node.arguments.length !== 1) return;
        if (isSilentHandler(node.arguments[0])) context.report({ node, messageId: "promise" });
      }
    };
  }
};
