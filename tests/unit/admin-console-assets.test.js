/**
 * 관리 콘솔 스크립트 제공 경로 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { test, describe }  from "node:test";
import assert              from "node:assert/strict";
import fs                  from "node:fs";
import path                from "node:path";
import crypto              from "node:crypto";
import { fileURLToPath }   from "node:url";

import { handleAdminStatic } from "../../lib/admin/admin-routes.js";
import { ADMIN_BASE }        from "../../lib/admin/admin-auth.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT       = path.resolve(path.dirname(__filename), "..", "..");
const VENDOR_DIR = path.join(ROOT, "assets", "admin", "vendor");

const VENDORED = {
  "tailwindcss-3.4.17.js": "a789ce5a73191759006b64a0c05f63afbf9aa43a86511bf798d688737429e60a",
  "d3-7.9.0.min.js":       "f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539",
};

const html      = fs.readFileSync(path.join(ROOT, "assets", "admin", "index.html"), "utf8");
const routes    = fs.readFileSync(path.join(ROOT, "lib", "admin", "admin-routes.js"), "utf8");
const scriptSrc = (routes.match(/script-src ([^;"]+)/) || [])[1] || "";

describe("관리 콘솔 스크립트 출처", () => {
  test("index.html 의 script 태그는 외부 호스트를 가리키지 않는다", () => {
    assert.doesNotMatch(html, /<script[^>]+src="(?:https?:)?\/\//);
  });

  test("index.html 은 vendor 스크립트를 콘솔 자산 경로로 읽는다", () => {
    for (const name of Object.keys(VENDORED)) {
      assert.ok(html.includes(`${ADMIN_BASE}/assets/vendor/${name}`), `${name} 참조 없음`);
    }
  });

  test("ADMIN_CSP script-src 는 외부 호스트를 포함하지 않는다", () => {
    assert.ok(scriptSrc.includes("'self'"), "script-src 'self' 없음");
    assert.doesNotMatch(scriptSrc, /https?:\/\//);
  });
});

describe("vendor 스크립트 파일", () => {
  for (const [name, expected] of Object.entries(VENDORED)) {
    test(`${name} 의 sha256 이 일치한다`, () => {
      const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(VENDOR_DIR, name))).digest("hex");
      assert.equal(digest, expected);
    });

    test(`${name} 이 정적 자산 처리기로 제공된다`, async () => {
      const res = await new Promise((resolve) => {
        const out = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { resolve({ ...this, body }); } };
        handleAdminStatic({ url: `${ADMIN_BASE}/assets/vendor/${name}` }, out);
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["Content-Type"], "application/javascript");
      assert.ok(res.body.length > 10000);
    });
  }
});
