/**
 * 교차 출처 응답 헤더 처리 방식 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const realLogger = await import("../../lib/logger.js");
const infoLines  = [];

mock.module("../../lib/logger.js", {
  namedExports: { ...realLogger, logInfo: (msg) => { infoLines.push(String(msg)); } }
});

const { applyCorsOrigin } = await import("../../lib/handlers/_common.js");
const { ALLOWED_ORIGINS } = await import("../../lib/config.js");

/**
 * 모드와 허용 목록을 지정해 한 번 호출하고 기록된 헤더를 돌려준다.
 * 전역 Set과 환경변수는 호출 뒤 원래대로 되돌린다.
 */
function run(origin, { mode, allowed = [] } = {}) {
  const saved   = [...ALLOWED_ORIGINS];
  const headers = {};
  const res     = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; } };

  ALLOWED_ORIGINS.clear();
  for (const o of allowed) ALLOWED_ORIGINS.add(o);
  if (mode === undefined) delete process.env.MEMENTO_CORS_MODE;
  else process.env.MEMENTO_CORS_MODE = mode;

  try {
    applyCorsOrigin({ headers: origin ? { origin } : {} }, res);
  } finally {
    ALLOWED_ORIGINS.clear();
    for (const o of saved) ALLOWED_ORIGINS.add(o);
    delete process.env.MEMENTO_CORS_MODE;
  }
  return headers;
}

const corsLines = () => infoLines.filter((l) => l.startsWith("[CORS]")).length;
const ACAO      = "access-control-allow-origin";

describe("applyCorsOrigin", () => {
  it("Origin이 없으면 모든 모드에서 *를 쓰고 Vary를 붙이지 않는다", () => {
    for (const mode of [undefined, "reflect", "observe", "allowlist"]) {
      const h = run(null, { mode });
      assert.equal(h[ACAO], "*");
      assert.equal(h.vary, undefined);
    }
  });

  it("reflect는 요청 Origin을 돌려주고 기록하지 않는다", () => {
    const before = corsLines();
    const h      = run("https://r1.example", { mode: "reflect" });
    assert.equal(h[ACAO], "https://r1.example");
    assert.equal(h.vary, "Origin");
    assert.equal(corsLines(), before);
  });

  it("기본 모드는 응답이 reflect와 같고 처음 본 Origin만 한 번 기록한다", () => {
    const before = corsLines();
    const h1     = run("https://o1.example");
    const h2     = run("https://o1.example");
    assert.equal(h1[ACAO], "https://o1.example");
    assert.deepEqual(h1, h2);
    assert.equal(corsLines(), before + 1);
  });

  it("관찰 기록은 프로세스당 256건을 넘지 않는다", () => {
    for (let i = 0; i < 300; i++) run(`https://bulk${i}.example`);
    assert.ok(corsLines() <= 256);
  });

  it("allowlist는 기본 신뢰 도메인만 돌려주고 나머지는 헤더를 생략한다", () => {
    assert.equal(run("https://claude.ai", { mode: "allowlist" })[ACAO], "https://claude.ai");
    const h = run("https://unknown.example", { mode: "allowlist" });
    assert.equal(h[ACAO], undefined);
    assert.equal(h.vary, "Origin");
  });

  it("ALLOWED_ORIGINS가 있으면 목록만 돌려주고 문자열 null을 쓰지 않는다", () => {
    const allowed = ["https://ok.example"];
    for (const mode of [undefined, "reflect", "allowlist"]) {
      assert.equal(run("https://ok.example", { mode, allowed })[ACAO], "https://ok.example");
      assert.equal(run("https://no.example", { mode, allowed })[ACAO], undefined);
      assert.equal(run("null", { mode, allowed })[ACAO], undefined);
    }
  });
});
