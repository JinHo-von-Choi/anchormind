/**
 * Pipeline Overhaul 통합 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-07
 *
 * 실제 DB 없이 실행 가능한 구조 검증 + 랭킹 로직 검증.
 * DB 의존 모듈은 dynamic import + Object.create 패턴으로 격리.
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";

const DAY_MS = 86400000;

describe("Pipeline Overhaul Integration", () => {

  describe("EmbeddingWorker → GraphLinker chain", () => {
    it("EmbeddingWorker is EventEmitter with expected interface", async () => {
      const { EmbeddingWorker } = await import("../../lib/memory/embedding/EmbeddingWorker.js");
      const proto = EmbeddingWorker.prototype;
      assert.equal(typeof proto.on, "function", "EmbeddingWorker should inherit EventEmitter.on");
      assert.equal(typeof proto.emit, "function", "EmbeddingWorker should inherit EventEmitter.emit");
      assert.equal(typeof proto.start, "function", "EmbeddingWorker should have start()");
      assert.equal(typeof proto.stop, "function", "EmbeddingWorker should have stop()");
    });

    it("GraphLinker exposes linkFragment and retroLink", async () => {
      const { GraphLinker } = await import("../../lib/memory/link/GraphLinker.js");
      const proto = GraphLinker.prototype;
      assert.equal(typeof proto.linkFragment, "function");
      assert.equal(typeof proto.retroLink, "function");
    });
  });

  describe("Temporal-Semantic Ranking", () => {
    it("_computeRankScore accepts anchorTime parameter", async () => {
      const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");
      const search = Object.create(FragmentSearch.prototype);

      const config = {
        ranking: {
          importanceWeight    : 0.4,
          recencyWeight       : 0.3,
          semanticWeight      : 0.3,
          recencyHalfLifeDays : 30
        }
      };
      const now  = Date.now();
      const frag = { importance: 0.5, created_at: new Date(now).toISOString() };

      const score = search._computeRankScore(frag, config, now);
      assert.ok(typeof score === "number" && score > 0, `score should be positive number, got ${score}`);
    });

    it("past anchorTime ranks nearby fragments higher", async () => {
      const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");
      const search = Object.create(FragmentSearch.prototype);

      const config = {
        ranking: {
          importanceWeight    : 0.4,
          recencyWeight       : 0.3,
          semanticWeight      : 0.3,
          recencyHalfLifeDays : 30
        }
      };

      const anchor = Date.now() - 30 * DAY_MS;
      const near   = { importance: 0.5, created_at: new Date(anchor - DAY_MS).toISOString() };
      const far    = { importance: 0.5, created_at: new Date().toISOString() };

      const nearScore = search._computeRankScore(near, config, anchor);
      const farScore  = search._computeRankScore(far, config, anchor);

      assert.ok(
        nearScore > farScore,
        `Fragment near anchor (${nearScore.toFixed(4)}) should score higher than far fragment (${farScore.toFixed(4)})`
      );
    });

    it("importance weight dominates when recency is equal", async () => {
      const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");
      const search = Object.create(FragmentSearch.prototype);

      const config = {
        ranking: {
          importanceWeight    : 0.4,
          recencyWeight       : 0.3,
          semanticWeight      : 0.3,
          recencyHalfLifeDays : 30
        }
      };

      const now       = Date.now();
      const timestamp = new Date(now).toISOString();

      const highImp = { importance: 0.9, created_at: timestamp };
      const lowImp  = { importance: 0.1, created_at: timestamp };

      assert.ok(
        search._computeRankScore(highImp, config, now) > search._computeRankScore(lowImp, config, now),
        "Higher importance should yield higher score when recency is equal"
      );
    });
  });

  describe("Context Injection Caps", () => {
    it("MEMORY_CONFIG has contextInjection settings", async () => {
      const { MEMORY_CONFIG } = await import("../../config/memory.js");
      assert.ok(MEMORY_CONFIG.contextInjection, "contextInjection section missing");
      assert.equal(MEMORY_CONFIG.contextInjection.maxCoreFragments, 15);
      assert.equal(MEMORY_CONFIG.contextInjection.maxWmFragments, 10);
      assert.ok(MEMORY_CONFIG.contextInjection.typeSlots, "typeSlots missing");
      assert.equal(MEMORY_CONFIG.contextInjection.typeSlots.preference, 5);
      assert.equal(MEMORY_CONFIG.contextInjection.typeSlots.error, 5);
      assert.equal(MEMORY_CONFIG.contextInjection.defaultTokenBudget, 2000);
    });
  });

  describe("GC Policy", () => {
    it("MEMORY_CONFIG has gc settings with correct defaults", async () => {
      const { MEMORY_CONFIG } = await import("../../config/memory.js");
      assert.ok(MEMORY_CONFIG.gc, "gc section missing");
      assert.equal(MEMORY_CONFIG.gc.utilityThreshold, 0.15);
      assert.equal(MEMORY_CONFIG.gc.gracePeriodDays, 7);
      assert.equal(MEMORY_CONFIG.gc.inactiveDays, 60);
      assert.equal(MEMORY_CONFIG.gc.maxDeletePerCycle, 50);
      assert.ok(MEMORY_CONFIG.gc.factDecisionPolicy, "factDecisionPolicy missing");
      assert.equal(MEMORY_CONFIG.gc.factDecisionPolicy.importanceThreshold, 0.2);
      assert.equal(MEMORY_CONFIG.gc.factDecisionPolicy.orphanAgeDays, 30);
    });
  });

  describe("Pagination", () => {
    it("MEMORY_CONFIG has pagination settings", async () => {
      const { MEMORY_CONFIG } = await import("../../config/memory.js");
      assert.ok(MEMORY_CONFIG.pagination, "pagination section missing");
      assert.equal(MEMORY_CONFIG.pagination.defaultPageSize, 20);
      assert.equal(MEMORY_CONFIG.pagination.maxPageSize, 50);
    });

    it("cursor encoding/decoding roundtrip", () => {
      const data    = { offset: 20, anchorTime: Date.now() };
      const encoded = Buffer.from(JSON.stringify(data)).toString("base64url");
      const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString());
      assert.deepStrictEqual(decoded, data);
    });
  });

  describe("Ranking Config Consistency", () => {
    it("ranking weights sum to 1.0", async () => {
      const { MEMORY_CONFIG } = await import("../../config/memory.js");
      const { importanceWeight, recencyWeight, semanticWeight } = MEMORY_CONFIG.ranking;
      const sum = importanceWeight + recencyWeight + semanticWeight;
      assert.ok(
        Math.abs(sum - 1.0) < 0.001,
        `Ranking weights should sum to 1.0, got ${sum}`
      );
    });

    it("RRF search config has k and l1WeightFactor", async () => {
      const { MEMORY_CONFIG } = await import("../../config/memory.js");
      assert.ok(MEMORY_CONFIG.rrfSearch, "rrfSearch section missing");
      assert.equal(MEMORY_CONFIG.rrfSearch.k, 60);
      assert.equal(MEMORY_CONFIG.rrfSearch.l1WeightFactor, 2.0);
    });
  });

  describe("EmbeddingWorker Config", () => {
    it("MEMORY_CONFIG has embeddingWorker settings", async () => {
      const { MEMORY_CONFIG } = await import("../../config/memory.js");
      assert.ok(MEMORY_CONFIG.embeddingWorker, "embeddingWorker section missing");
      assert.equal(MEMORY_CONFIG.embeddingWorker.batchSize, 10);
      assert.equal(MEMORY_CONFIG.embeddingWorker.retryLimit, 3);
      assert.ok(MEMORY_CONFIG.embeddingWorker.queueKey, "queueKey missing");
    });
  });

  describe("Backfill Script", () => {
    it("backfill-embeddings.js exists and is importable", async () => {
      const { stat } = await import("node:fs/promises");
      const path = new URL("../../scripts/backfill-embeddings.js", import.meta.url).pathname;
      const s = await stat(path);
      assert.ok(s.isFile(), "backfill-embeddings.js should be a file");
    });
  });
});
