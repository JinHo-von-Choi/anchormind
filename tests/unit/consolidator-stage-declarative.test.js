/**
 * Consolidator stage 선언형화 회귀 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * `_runConsolidationCycle`이 `TOTAL_STAGES = <리터럴>`로 고정된 진행률을 송출하던 회귀를 차단한다.
 * stage 배열 길이가 곧 total이 되며, SSE/관리 콘솔에 노출되는 progress의 total은
 * 실제 실행 stage 수와 일치해야 한다.
 */

import { describe, it, after } from "node:test";
import assert                   from "node:assert/strict";
import { readFileSync }         from "node:fs";
import { fileURLToPath }        from "node:url";
import path                     from "node:path";

import { teardownTestResources } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
});

const here   = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  path.resolve(here, "../../lib/memory/consolidate/MemoryConsolidator.js"),
  "utf-8"
);

describe("MemoryConsolidator — stage 선언형화 회귀 가드", () => {

  it("TOTAL_STAGES가 stageDefs.length로 산출된다", () => {
    assert.match(
      source,
      /const\s+TOTAL_STAGES\s*=\s*stageDefs\.length/,
      "TOTAL_STAGES = stageDefs.length 형식이어야 한다"
    );
  });

  it("TOTAL_STAGES가 더 이상 숫자 리터럴로 박혀 있지 않다", () => {
    assert.doesNotMatch(
      source,
      /const\s+TOTAL_STAGES\s*=\s*\d+\s*;/,
      "숫자 리터럴 TOTAL_STAGES = N; 패턴은 잔존하면 안 된다"
    );
  });

  it("stageDefs 배열에 모든 stage가 선언되어 있다", () => {
    const required = [
      "ttl_transition", "importance_decay", "expired_delete", "gc_preview",
      "split_long_fragments", "merge_duplicates", "semantic_dedup",
      "compress_old_fragments", "embeddings_backfill", "retro_link",
      "utility_score_update", "requeue_high_ema", "promote_anchors",
      "detect_contradictions", "detect_supersessions",
      "process_pending_contradictions", "feedback_report",
      "feedback_calibration", "prune_keyword_indexes",
      "collect_stale_fragments", "purge_stale_reflections", "gc_search_events"
    ];
    for (const name of required) {
      const pattern = new RegExp(`name\\s*:\\s*"${name}"`);
      assert.match(source, pattern, `stage "${name}"이 선언되어야 한다`);
    }
  });

});

describe("MemoryConsolidator — enableRiskyStages skip 회귀 가드", () => {

  it("split_long_fragments fn이 enableRiskyStages.splitLongFragments===false 분기를 포함한다", () => {
    assert.match(
      source,
      /enableRiskyStages\?\.splitLongFragments\s*===\s*false/,
      "splitLongFragments 플래그 skip 분기가 선언되어야 한다"
    );
  });

  it("compress_old_fragments fn이 enableRiskyStages.compressOldFragments===false 분기를 포함한다", () => {
    assert.match(
      source,
      /enableRiskyStages\?\.compressOldFragments\s*===\s*false/,
      "compressOldFragments 플래그 skip 분기가 선언되어야 한다"
    );
  });

  it("detect_contradictions fn이 enableRiskyStages.detectContradictions===false 분기를 포함한다", () => {
    assert.match(
      source,
      /enableRiskyStages\?\.detectContradictions\s*===\s*false/,
      "detectContradictions 플래그 skip 분기가 선언되어야 한다"
    );
  });

  it("timedStage가 status 필드를 가진 제어 객체를 처리한다", () => {
    assert.match(
      source,
      /typeof result\.status\s*===\s*["']string["']/,
      "timedStage가 status 문자열 필드로 제어 객체를 판별해야 한다"
    );
  });

});

describe("MemoryConsolidator._runConsolidationCycle — 진행률 정합", () => {

  it("onProgress의 total이 단조 증가하는 processed와 함께 일관되며 마지막에 일치한다", async () => {
    const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");

    /** 외부 의존(DB·임베딩·LLM)을 전부 무력화한 인스턴스 */
    const c = new MemoryConsolidator();

    /** ContradictionDetector stub */
    c.contradictionDetector = {
      resetCheckedPairs: () => {}
    };

    /** store stub — 모든 메서드가 즉시 resolve */
    const noopAffected = async () => 0;
    c.store = {
      decayImportance        : async () => {},
      deleteExpired          : noopAffected,
      transitionTTL          : async () => {}
    };

    /** index stub */
    c.index = { pruneKeywordIndexes: async () => {} };

    /** stage 본문에서 호출되는 내부 헬퍼를 모두 0-affected로 stub */
    const internal = [
      "_transitionWithCount", "_splitLongFragments", "_mergeDuplicates",
      "_semanticDedup", "_compressOldFragments", "_updateUtilityScores",
      "_requeueHighEmaLowQuality", "_promoteAnchors",
      "_detectSupersessions", "_processPendingContradictions",
      "_generateFeedbackReport", "_calibrateByFeedback",
      "_purgeStaleReflections", "_gcSearchEvents"
    ];
    for (const m of internal) {
      c[m] = async () => 0;
    }

    /** detect_contradictions / collect_stale_fragments는 객체·배열 반환 */
    c._detectContradictions  = async () => ({ found: 0, nliResolved: 0, nliSkipped: 0 });
    c._collectStaleFragments = async () => [];

    const events = [];
    await c._runConsolidationCycle((evt) => events.push(evt));

    assert.ok(events.length > 0, "stage 진행 이벤트가 발행되어야 한다");

    const totals = new Set(events.map(e => e.total));
    assert.strictEqual(totals.size, 1, "모든 progress 이벤트의 total은 단일 값이어야 한다");

    const total = events[0].total;
    assert.ok(total >= 20, `stage 수가 최소 20 이상이어야 한다 (received ${total})`);

    /** processed가 1부터 단조 증가하고 마지막이 total과 일치 */
    for (let i = 0; i < events.length; i++) {
      assert.strictEqual(events[i].processed, i + 1, `processed는 ${i + 1}이어야 한다`);
    }
    assert.strictEqual(events[events.length - 1].processed, total, "마지막 processed == total");
  });

});
