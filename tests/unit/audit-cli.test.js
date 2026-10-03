/**
 * memento-mcp audit verify 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 옵션 판독, 결과 출력, 끊긴 체인의 종료(예외), 풀 정리를 DB 풀과 저장소를 대체해 본다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";

let verifyResult;
let verifyArgs;
let shutdowns = 0;

const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  exports: { ...realDb, getPrimaryPool: () => ({}), shutdownPool: async () => { shutdowns++; } }
});
const realStore = await import("../../lib/logging/AuditStore.js");
mock.module("../../lib/logging/AuditStore.js", {
  exports: {
    ...realStore,
    AuditStore: class { async verify(a) { verifyArgs = a; return verifyResult; } }
  }
});

const { default: audit, usage, positiveIntOption, formatVerifyResult, AuditChainBrokenError } = await import("../../lib/cli/audit.js");

const INTACT = { ok: true, checked: 3, firstSeq: 1, lastSeq: 3, anchor: "genesis", anchorHash: "0".repeat(64), headHash: "a".repeat(64), complete: true, broken: null };
const BROKEN = { ok: false, checked: 1, firstSeq: 1, lastSeq: 1, anchor: "genesis", anchorHash: "0".repeat(64), headHash: null, complete: false, broken: { seq: 2, reason: "row_hash_mismatch" } };

/** console.log 출력을 모은다. */
async function captured(fn) {
  const lines = [];
  const orig  = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

beforeEach(() => {
  verifyResult = INTACT;
  verifyArgs   = null;
  shutdowns    = 0;
});

describe("audit verify", () => {
  it("온전한 체인은 결과를 출력하고 풀을 닫는다", async () => {
    const out = await captured(() => audit({ _: ["verify"] }));
    assert.match(out, /audit chain: intact/);
    assert.match(out, /head {4}: a{64}/);
    assert.deepEqual(verifyArgs, { fromSeq: null });
    assert.equal(shutdowns, 1);
  });

  it("끊긴 체인은 끊긴 seq를 출력하고 AuditChainBrokenError를 던진다", async () => {
    verifyResult = BROKEN;
    let thrown = null;
    const out  = await captured(() => audit({ _: ["verify"], "from-seq": "1", "max-rows": "10" }).catch((err) => { thrown = err; }));
    assert.ok(thrown instanceof AuditChainBrokenError);
    assert.match(thrown.message, /seq 2 \(row_hash_mismatch\)/);
    assert.match(out, /audit chain: BROKEN/);
    assert.deepEqual(verifyArgs, { fromSeq: 1, maxRows: 10 });
    assert.equal(shutdowns, 1);
  });

  it("--json은 결과 객체를 그대로 출력한다", async () => {
    const out = await captured(() => audit({ _: ["verify"], json: true }));
    assert.deepEqual(JSON.parse(out), INTACT);
  });

  it("모르는 서브명령과 잘못된 옵션은 DB에 붙기 전에 거부한다", async () => {
    await assert.rejects(audit({ _: ["list"] }), /unknown audit subcommand/);
    await assert.rejects(audit({ _: ["verify"], "max-rows": "0" }), /--max-rows must be a positive integer/);
    assert.equal(shutdowns, 0);
  });

  it("도움말은 verify와 종료 코드를 설명한다", () => {
    assert.match(usage, /audit verify/);
    assert.match(usage, /Exit code is 1/);
  });
});

describe("출력과 옵션 판독", () => {
  it("끊긴 결과는 break 줄을 담는다", () => {
    assert.ok(formatVerifyResult(BROKEN).some(l => /break {3}: seq 2 \(row_hash_mismatch\)/.test(l)));
  });

  it("빈 표는 확인할 행이 없다고 출력한다", () => {
    assert.deepEqual(formatVerifyResult({ ok: true, checked: 0, broken: null }), ["audit chain: no rows to check"]);
  });

  it("max-rows에서 멈춘 결과는 그 사실을 알린다", () => {
    assert.ok(formatVerifyResult({ ...INTACT, complete: false }).some(l => /stopped at --max-rows/.test(l)));
  });

  it("양의 정수만 받는다", () => {
    assert.equal(positiveIntOption({}, "max-rows"), undefined);
    assert.equal(positiveIntOption({ "max-rows": "5" }, "max-rows"), 5);
    assert.throws(() => positiveIntOption({ "max-rows": true }, "max-rows"));
    assert.throws(() => positiveIntOption({ "max-rows": "1.5" }, "max-rows"));
  });
});
