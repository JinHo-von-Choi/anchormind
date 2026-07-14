/**
 * Admin shell (index.html) 구조 검증 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import fs                 from "node:fs";
import path               from "node:path";
import { fileURLToPath }  from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const HTML_PATH  = path.join(__dirname, "..", "..", "assets", "admin", "index.html");

const html = fs.readFileSync(HTML_PATH, "utf-8");

describe("admin index.html shell structure", () => {
  test("references admin.css stylesheet", () => {
    assert.ok(html.includes("admin.css"), "admin.css link not found");
  });

  test("references admin.js script", () => {
    assert.ok(html.includes("admin.js"), "admin.js script not found");
  });

  test("contains #app element", () => {
    assert.ok(html.includes('id="app"'), "#app element not found");
  });

  test("contains #login-root element", () => {
    assert.ok(html.includes('id="login-root"'), "#login-root element not found");
  });

  test("contains #toast-root element", () => {
    assert.ok(html.includes('id="toast-root"'), "#toast-root element not found");
  });

  test("contains #modal-root element", () => {
    assert.ok(html.includes('id="modal-root"'), "#modal-root element not found");
  });

  test("contains #sidebar element", () => {
    assert.ok(html.includes('id="sidebar"'), "#sidebar element not found");
  });

  test("contains #view-container element", () => {
    assert.ok(html.includes('id="view-container"'), "#view-container element not found");
  });

  test("contains #command-bar element", () => {
    assert.ok(html.includes('id="command-bar"'), "#command-bar element not found");
  });

  test("sets lang=ko", () => {
    assert.ok(html.includes('lang="ko"'), "lang attribute not set to ko");
  });

  test("CSS path uses admin base route", () => {
    assert.ok(
      html.includes('/v1/internal/model/nothing/assets/admin.css'),
      "CSS path does not use correct admin base route"
    );
  });

  test("JS path uses admin base route", () => {
    assert.ok(
      html.includes('/v1/internal/model/nothing/assets/admin.js'),
      "JS path does not use correct admin base route"
    );
  });

  test("includes Tailwind CDN script", () => {
    assert.ok(html.includes("cdn.tailwindcss.com"), "Tailwind CDN not found");
  });

  test("includes JetBrains Mono font", () => {
    assert.ok(html.includes("JetBrains+Mono"), "JetBrains Mono font not found");
  });

  test("includes Material Symbols icon font", () => {
    assert.ok(html.includes("Material+Symbols+Outlined"), "Material Symbols font not found");
  });

  test("includes Material Symbols Outlined", () => {
    assert.ok(html.includes("Material+Symbols+Outlined"), "Material Symbols not found");
  });

  test("includes tailwind-config script", () => {
    assert.ok(html.includes('id="tailwind-config"'), "tailwind-config not found");
  });

  test("has dark class on html element", () => {
    assert.ok(html.includes('class="dark"'), "dark class not found on html");
  });
});
