/**
 * 키 정책 편집 문서 정합 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 문서가 말하는 키 관리 라우트가 admin-keys.js 라우트 표에 있는지, 표의 키 라우트가
 * 라우트 문서(ko, en)에 모두 오르는지, 정책 편집을 설명하는 문서가 서로 같은 한도와
 * 같은 경로를 쓰는지 본다. 문서 문장 전체는 고정하지 않는다.
 */

import { test, describe }  from "node:test";
import assert              from "node:assert/strict";
import { readFileSync }    from "node:fs";
import { fileURLToPath }   from "node:url";
import path                from "node:path";

import {
  MAX_ALLOWED_WORKSPACES,
  MAX_WORKSPACE_LENGTH,
  KEY_POLICY_FIELDS
} from "../../lib/admin/key-policy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = "/v1/internal/model/nothing";
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const ROUTES_SRC = read("lib/admin/admin-keys.js");
const ROUTE_LINE = /\{\s*method:\s*"([A-Z]+)",\s*match:\s*(exact|regex)\((?:new RegExp\()?`([^`]+)`\)?\),\s*handler:\s*(\w+)\s*\}/g;

/** 라우트 표에서 /keys 아래 항목을 읽어 판정 함수와 `:id` 표기 경로를 만든다. */
const keyRoutes = [...ROUTES_SRC.matchAll(ROUTE_LINE)]
  .map(([, method, kind, raw]) => {
    const source = raw.replace(/\$\{ADMIN_BASE\}/g, BASE);
    const sample = source.replace(/^\^/, "").replace(/\$$/, "").replace(/\(\[\^\/\]\+\)/g, "x");
    const test   = kind === "exact" ? (p) => p === source : (p) => new RegExp(source).test(p);
    return { method, sample, test };
  })
  .filter((r) => r.sample.startsWith(`${BASE}/keys`));

const toSample = (docPath) => docPath.replace(/:id/g, "x");

const API_DOCS    = ["docs/api-reference.md", "docs/api-reference.en.md"];
const POLICY_DOCS = [
  "docs/admin-console-guide.md",
  "docs/api-reference.md",
  "docs/api-reference.en.md",
  "docs/configuration.md",
  "docs/configuration.en.md"
];
const MENTION_DOCS = [...POLICY_DOCS, "docs/architecture.md", "docs/architecture.en.md", "docs/operations/symbolic-hard-gate.md"];

describe("라우트 표", () => {
  test("키 라우트가 추출된다", () => {
    assert.ok(keyRoutes.length >= 9, `${keyRoutes.length}건`);
    assert.ok(keyRoutes.some((r) => r.method === "PATCH" && r.sample.endsWith("/keys/x/policy")), "정책 라우트 없음");
  });
});

describe("문서의 키 라우트 언급이 라우트 표에 있다", () => {
  for (const rel of MENTION_DOCS) {
    test(rel, () => {
      const mentions = [...read(rel).matchAll(/\/v1\/internal\/model\/nothing\/keys(?:\/:id)?(?:\/[a-z-]+)?/g)].map((m) => m[0]);
      for (const mention of mentions) {
        const sample = toSample(mention);
        assert.ok(keyRoutes.some((r) => r.test(sample)), `${rel}: ${mention} 라우트가 표에 없다`);
      }
    });
  }

  for (const rel of API_DOCS) {
    test(`${rel} 표의 (메서드, 경로) 행이 라우트 표와 일치한다`, () => {
      const rows = [...read(rel).matchAll(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*(\/v1\/internal\/model\/nothing\/keys[^\s|]*)\s*\|/gm)];
      assert.ok(rows.length >= 9, `${rows.length}행`);
      for (const [, method, docPath] of rows) {
        assert.ok(
          keyRoutes.some((r) => r.method === method && r.test(toSample(docPath))),
          `${rel}: ${method} ${docPath}가 라우트 표에 없다`
        );
      }
    });
  }
});

describe("라우트 표의 키 라우트가 라우트 문서에 모두 오른다", () => {
  for (const rel of API_DOCS) {
    test(rel, () => {
      const rows = [...read(rel).matchAll(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*(\/v1\/internal\/model\/nothing\/keys[^\s|]*)\s*\|/gm)]
        .map(([, method, docPath]) => ({ method, sample: toSample(docPath) }));
      for (const route of keyRoutes) {
        assert.ok(
          rows.some((row) => row.method === route.method && route.test(row.sample)),
          `${rel}: ${route.method} ${route.sample} 행이 없다`
        );
      }
    });
  }
});

describe("정책 편집 문서", () => {
  for (const rel of POLICY_DOCS) {
    test(`${rel}가 정책 라우트를 안내한다`, () => {
      assert.match(read(rel), /keys\/:id\/policy/);
    });
  }

  for (const rel of API_DOCS) {
    test(`${rel}의 정책 절이 세 필드와 한도를 싣는다`, () => {
      const text    = read(rel);
      const section = text.slice(text.indexOf(`### PATCH ${BASE}/keys/:id/policy`));
      assert.ok(section.length > 0 && text.includes(`### PATCH ${BASE}/keys/:id/policy`), "정책 절 없음");
      for (const field of KEY_POLICY_FIELDS) assert.ok(section.includes(`\`${field}\``), `${field} 설명 없음`);
      assert.ok(section.includes(String(MAX_ALLOWED_WORKSPACES)), "항목 수 한도가 문서와 다르다");
      assert.ok(section.includes(String(MAX_WORKSPACE_LENGTH)), "항목 길이 한도가 문서와 다르다");
    });
  }

  test("관리 콘솔 안내가 세 필드와 한도를 싣는다", () => {
    const text = read("docs/admin-console-guide.md");
    for (const label of ["DEFAULT MODE", "RESTRICT WORKSPACES", "SYMBOLIC HARD GATE"]) {
      assert.ok(text.includes(label), `${label} 설명 없음`);
    }
    assert.ok(text.includes(`최대 ${MAX_ALLOWED_WORKSPACES}개`));
    assert.ok(text.includes(`${MAX_WORKSPACE_LENGTH}자`));
  });

  test("관리 콘솔 안내는 마스터 전용 preset을 키에 지정할 수 있다고 쓰지 않는다", () => {
    const text = read("docs/admin-console-guide.md");
    assert.doesNotMatch(text, /값:[^.\n]*`audit`/);
    assert.match(text, /마스터 전용 preset\(`audit`\)은 API 키에 지정할 수 없다/);
  });

  test("한도는 영문 문서에도 같은 값으로 적힌다", () => {
    for (const rel of ["docs/api-reference.en.md", "docs/configuration.en.md"]) {
      assert.ok(read(rel).includes(`${MAX_ALLOWED_WORKSPACES} entries`), `${rel}: 항목 수 한도 누락`);
      assert.ok(read(rel).includes(`${MAX_WORKSPACE_LENGTH} characters`), `${rel}: 항목 길이 한도 누락`);
    }
  });
});
