/**
 * ContradictionDetector 진행 위치(워터마크) 동작 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * Redis 가 없는 환경에서 증분 탐지를 여러 번 돌렸을 때
 * 1. 한 번에 20건씩 오래된 순으로 훑어 모든 파편이 빠짐없이 검사되는지
 * 2. 같은 created_at 을 가진 파편 묶음에서도 멈추지 않고 전진하는지
 * 3. 항상 실패하는 파편이 있어도 상한 횟수 뒤에는 건너뛰고 뒤 파편을 검사하는지
 * 를 가짜 질의 계층으로 확인한다. 시험끼리 프로세스 내 워터마크를 공유하므로
 * 각 시험은 앞 시험보다 늦은 시각대의 파편만 쓴다.
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

/** 가짜 파편 표. 각 시험이 채운다. */
let table    = [];
const warns  = [];
const LIMIT  = 20;

/** "YYYY-MM-DDTHH:MM:SS(.ffffff)Z" 를 마이크로초 정수로 바꾼다 */
function toMicros(s) {
  const m = String(s).match(/^(.*T\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/);
  if (!m) throw new Error(`unexpected timestamp: ${s}`);
  return BigInt(Date.parse(`${m[1]}Z`)) * 1000n + BigInt((m[2] || "").padEnd(6, "0"));
}

function cmpRow(a, b) {
  const d = toMicros(a.wm) - toMicros(b.wm);
  if (d !== 0n) return d < 0n ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (_agent, sql, params = []) => {
      if (/LIMIT 20/.test(sql)) {
        let rows = [...table].sort(cmpRow);
        if (params.length === 2) {
          assert.match(sql, /\(created_at, id\) > \(\$1::timestamptz, \$2::text\)/);
          const at = toMicros(params[0]);
          rows = rows.filter(r => toMicros(r.wm) > at || (toMicros(r.wm) === at && r.id > params[1]));
        } else if (params.length === 1) {
          const at = toMicros(params[0]);
          rows = rows.filter(r => toMicros(r.wm) > at);
        }
        return {
          rows: rows.slice(0, LIMIT).map(r => ({
            id: r.id, content: r.content, topic: "t", type: "fact", importance: 0.5,
            embedding: "[1]", created_at: new Date(Number(toMicros(r.wm) / 1000n)),
            key_id: null, is_anchor: false, watermark_at: r.wm
          }))
        };
      }
      if (/LIMIT 3/.test(sql)) {
        return { rows: [{ id: `cand-${params[0]}`, content: "candidate", topic: "t", type: "fact",
                          importance: 0.5, created_at: new Date(0), is_anchor: false, similarity: "0.90" }] };
      }
      return { rows: [], rowCount: 0 };
    }
  }
});
mock.module("../../lib/memory/signals/NLIClassifier.js", {
  namedExports: { isNLIAvailable: () => false, detectContradiction: async () => null }
});
mock.module("../../lib/gemini.js", {
  namedExports: { isGeminiCLIAvailable: async () => true, geminiCLIJson: async () => ({}) }
});
mock.module("../../lib/redis.js", {
  namedExports: { redisClient: { status: "stub" } }
});
mock.module("../../lib/memory/FragmentIndex.js", {
  namedExports: { deindexRows: async () => {} }
});
mock.module("../../lib/logger.js", {
  namedExports: {
    logInfo : () => {},
    logDebug: () => {},
    logError: () => {},
    logWarn : message => warns.push(String(message))
  }
});

const { ContradictionDetector, MAX_FRAG_FAILURES } = await import("../../lib/memory/link/ContradictionDetector.js");

/**
 * 시험용 탐지기. Gemini 판정을 가로채 검사된 파편 id 를 기록하고,
 * failIds 에 든 파편은 항상 판정에 실패하게 한다.
 */
function makeDetector(failIds = new Set()) {
  const checked  = [];
  const detector = new ContradictionDetector({ createLink: async () => {} });
  detector.askGeminiContradiction = async (content) => {
    const id = content.split("#")[1];
    checked.push(id);
    if (failIds.has(id)) throw new Error(`probe failure ${id}`);
    return { contradicts: false, reasoning: "" };
  };
  const run = async () => {
    detector.resetCheckedPairs();
    const before = checked.length;
    await detector.detectContradictions();
    return checked.slice(before);
  };
  return { run, checked };
}

/** base 시각(ms)에서 시작해 마이크로초 단위까지 채운 ISO 문자열 */
function isoMicros(ms, micros) {
  const d = new Date(ms).toISOString();
  return `${d.slice(0, 23)}${String(micros).padStart(3, "0")}Z`;
}

const BASE = Date.parse("2026-01-01T00:00:00.000Z");

describe("ContradictionDetector 워터마크", () => {
  it("오래된 순으로 20건씩 훑어 50건 모두를 한 번씩만 검사한다(마이크로초 정밀도 유지)", async () => {
    table = Array.from({ length: 50 }, (_, i) => ({
      id: `a${String(i + 1).padStart(2, "0")}`, content: `frag #a${String(i + 1).padStart(2, "0")}#`,
      wm: isoMicros(BASE + i * 1000, 123)
    }));
    const { run, checked } = makeDetector();
    const r1 = await run();
    assert.deepEqual(r1, table.slice(0, 20).map(r => r.id));
    await run();
    await run();
    const r4 = await run();
    assert.deepEqual(r4, [], "모두 검사한 뒤에는 다시 검사하지 않는다");
    assert.equal(checked.length, 50);
    assert.deepEqual([...new Set(checked)].sort(), table.map(r => r.id));
  });

  it("같은 created_at 을 가진 30건 묶음에서도 멈추지 않고 모두 검사한다", async () => {
    const at = isoMicros(BASE + 3600e3, 456);
    table = Array.from({ length: 30 }, (_, i) => ({
      id: `b${String(i + 1).padStart(2, "0")}`, content: `frag #b${String(i + 1).padStart(2, "0")}#`, wm: at
    }));
    const { run, checked } = makeDetector();
    await run();
    await run();
    const r3 = await run();
    assert.deepEqual(r3, []);
    assert.equal(checked.length, 30);
    assert.deepEqual([...new Set(checked)].sort(), table.map(r => r.id));
  });

  it(`항상 실패하는 파편은 ${MAX_FRAG_FAILURES}회 실패 뒤 건너뛰고 뒤 파편 검사를 이어 간다`, async () => {
    assert.equal(MAX_FRAG_FAILURES, 3);
    table = Array.from({ length: 25 }, (_, i) => ({
      id: `c${String(i + 1).padStart(2, "0")}`, content: `frag #c${String(i + 1).padStart(2, "0")}#`,
      wm: isoMicros(BASE + 7200e3 + i * 1000, 789)
    }));
    warns.length = 0;
    const { run, checked } = makeDetector(new Set(["c03"]));

    const r1 = await run();
    assert.deepEqual(r1, table.slice(0, 20).map(r => r.id), "실패 파편 뒤도 같은 회차에 검사는 한다");
    const r2 = await run();
    assert.equal(r2[0], "c03", "실패 파편 앞까지만 전진한다");
    const r3 = await run();
    assert.equal(r3[0], "c03");
    assert.ok(warns.some(w => w.includes("c03") && w.includes("skipped")), "건너뛴 사실을 경고로 남긴다");

    const r4 = await run();
    assert.ok(!r4.includes("c03"), "상한을 넘긴 파편은 다시 붙잡지 않는다");
    assert.deepEqual(r4, table.slice(22).map(r => r.id));
    assert.deepEqual(await run(), []);
    assert.deepEqual([...new Set(checked)].sort(), table.map(r => r.id));
  });
});
