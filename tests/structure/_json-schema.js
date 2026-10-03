/**
 * 시험용 JSON Schema 부분 검사기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 하네스 매니페스트 스키마(tests/structure/schemas)가 쓰는 키워드만 구현한다:
 * type, const, enum, pattern, minLength, maxLength, minimum, exclusiveMinimum, required,
 * properties, additionalProperties, propertyNames, items, minItems, oneOf, anyOf, not, $ref(#/$defs/...).
 * 모르는 키워드를 만나면 오류를 던져, 검사하지 않은 제약이 통과로 보이지 않게 한다.
 */

const KNOWN_KEYWORDS = new Set([
  "$schema", "$id", "$defs", "$ref", "$comment", "title", "description",
  "type", "const", "enum", "pattern", "minLength", "maxLength", "minimum", "exclusiveMinimum",
  "required", "properties", "additionalProperties", "propertyNames", "items", "minItems",
  "oneOf", "anyOf", "not"
]);

/**
 * JSON 값의 스키마 형식 이름
 *
 * @param {unknown} value
 * @returns {string}
 */
function jsonType(value) {
  if (value === null)          return "null";
  if (Array.isArray(value))    return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/**
 * @param {unknown} value
 * @param {string|string[]} expected
 * @returns {boolean}
 */
function typeMatches(value, expected) {
  const actual = jsonType(value);
  const list   = Array.isArray(expected) ? expected : [expected];
  return list.some(t => t === actual || (t === "number" && actual === "integer"));
}

/**
 * $ref 해석. 같은 문서의 #/$defs/<이름>만 지원한다.
 *
 * @param {object} root
 * @param {string} ref
 * @returns {object}
 */
function resolveRef(root, ref) {
  const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  if (!match || !root.$defs?.[match[1]]) throw new Error(`unsupported $ref: ${ref}`);
  return root.$defs[match[1]];
}

function checkScalar(schema, value, at, errors) {
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    errors.push(`${at}: expected ${schema.type}, got ${jsonType(value)}`);
    return false;
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) errors.push(`${at}: must be one of ${schema.enum.join("|")}`);
  if (typeof value === "string") {
    if (schema.pattern   !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum          !== undefined && value <  schema.minimum)          errors.push(`${at}: below ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${at}: not above ${schema.exclusiveMinimum}`);
  }
  return true;
}

function checkObject(root, schema, value, at, errors) {
  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push(`${at}: missing ${key}`);
  }
  for (const [key, child] of Object.entries(value)) {
    const where = `${at}.${key}`;
    if (schema.propertyNames) validateAt(root, schema.propertyNames, key, `${where}(name)`, errors);
    if (schema.properties && key in schema.properties) {
      validateAt(root, schema.properties[key], child, where, errors);
    } else if (schema.additionalProperties === false) {
      errors.push(`${where}: unknown property`);
    } else if (typeof schema.additionalProperties === "object") {
      validateAt(root, schema.additionalProperties, child, where, errors);
    }
  }
}

function checkArray(root, schema, value, at, errors) {
  if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
  if (schema.items) value.forEach((item, i) => validateAt(root, schema.items, item, `${at}[${i}]`, errors));
}

function checkCombinators(root, schema, value, at, errors) {
  const passes = (sub) => {
    const inner = [];
    validateAt(root, sub, value, at, inner);
    return inner.length === 0;
  };
  if (schema.oneOf && schema.oneOf.filter(passes).length !== 1) errors.push(`${at}: must match exactly one oneOf branch`);
  if (schema.anyOf && !schema.anyOf.some(passes))               errors.push(`${at}: must match an anyOf branch`);
  if (schema.not && passes(schema.not))                         errors.push(`${at}: must not match the not schema`);
}

/**
 * @param {object} root 최상위 스키마($ref 해석용)
 * @param {object} schema
 * @param {unknown} value
 * @param {string} at 오류 위치 표기
 * @param {string[]} errors
 */
function validateAt(root, schema, value, at, errors) {
  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(key)) throw new Error(`unsupported schema keyword: ${key}`);
  }
  if (schema.$ref) {
    validateAt(root, resolveRef(root, schema.$ref), value, at, errors);
    return;
  }
  if (!checkScalar(schema, value, at, errors)) return;
  if (jsonType(value) === "object") checkObject(root, schema, value, at, errors);
  if (Array.isArray(value))         checkArray(root, schema, value, at, errors);
  checkCombinators(root, schema, value, at, errors);
}

/**
 * 값을 스키마로 검사해 오류 목록을 돌려준다. 빈 배열이면 적합하다.
 *
 * @param {object} schema
 * @param {unknown} value
 * @returns {string[]}
 */
export function validateJsonSchema(schema, value) {
  const errors = [];
  validateAt(schema, schema, value, "$", errors);
  return errors;
}
