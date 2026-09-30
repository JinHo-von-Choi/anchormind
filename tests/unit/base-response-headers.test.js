/**
 * 응답 공통 헤더 단위 시험과 적용 위치 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const { applyBaseResponseHeaders } = await import("../../lib/http/helpers.js");
const ROOT                         = path.resolve(import.meta.dirname, "../..");

/**
 * 환경변수를 지정해 한 번 호출하고 기록된 헤더를 돌려준다.
 */
function collect(frameOptions) {
  const headers = {};
  const res     = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; } };
  if (frameOptions === undefined) delete process.env.MEMENTO_FRAME_OPTIONS;
  else process.env.MEMENTO_FRAME_OPTIONS = frameOptions;
  try {
    applyBaseResponseHeaders(res);
  } finally {
    delete process.env.MEMENTO_FRAME_OPTIONS;
  }
  return headers;
}

describe("applyBaseResponseHeaders", () => {
  it("nosniff와 Referrer-Policy는 항상 붙는다", () => {
    for (const v of [undefined, "deny"]) {
      const h = collect(v);
      assert.equal(h["x-content-type-options"], "nosniff");
      assert.equal(h["referrer-policy"], "no-referrer");
    }
  });

  it("프레임 제한은 기본으로 붙지 않는다", () => {
    assert.equal(collect()["x-frame-options"], undefined);
    assert.equal(collect("sameorigin")["x-frame-options"], undefined);
  });

  it("MEMENTO_FRAME_OPTIONS=deny이면 DENY를 붙인다", () => {
    assert.equal(collect("deny")["x-frame-options"], "DENY");
  });

  it("Strict-Transport-Security는 붙이지 않는다", () => {
    for (const v of [undefined, "deny"]) {
      assert.equal(collect(v)["strict-transport-security"], undefined);
    }
  });

  it("server.js는 Origin 판정보다 먼저 공통 헤더를 붙인다", () => {
    const src = readFileSync(path.join(ROOT, "server.js"), "utf8");
    const at  = src.indexOf("applyBaseResponseHeaders(res)");
    const vo  = src.indexOf("validateOrigin(req, res)");
    assert.ok(at > 0 && vo > 0 && at < vo);
  });
});
