import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

describe("ConsolidatorGC.compressOldFragments 배치 병렬화", () => {

  it("BATCH_SIZE 상수가 정의되어 있다", async () => {
    const { readFileSync } = await import("fs");
    const { join }         = await import("path");
    const src = readFileSync(
      join(process.cwd(), "lib", "memory", "consolidate", "ConsolidatorGC.js"), "utf-8"
    );
    assert.ok(src.includes("BATCH_SIZE"), "BATCH_SIZE 상수 정의 필수");
    assert.match(src, /const\s+BATCH_SIZE\s*=\s*20/, "BATCH_SIZE = 20");
  });

  it("Promise.all 배치 병렬 패턴이 적용되어 있다", async () => {
    const { readFileSync } = await import("fs");
    const { join }         = await import("path");
    const src = readFileSync(
      join(process.cwd(), "lib", "memory", "consolidate", "ConsolidatorGC.js"), "utf-8"
    );

    assert.ok(
      src.includes("Promise.all"),
      "Promise.all로 KNN 쿼리 병렬 실행 필수"
    );
    assert.ok(
      src.includes(".catch(() => ({ rows: [] }))"),
      "개별 쿼리 실패 시 빈 결과 반환 필수"
    );
  });

  it("순차 for 루프 내 개별 KNN 쿼리 패턴이 제거되었다", async () => {
    const { readFileSync } = await import("fs");
    const { join }         = await import("path");
    const src = readFileSync(
      join(process.cwd(), "lib", "memory", "consolidate", "ConsolidatorGC.js"), "utf-8"
    );

    const compressMethod = src.slice(
      src.indexOf("async compressOldFragments"),
      src.indexOf("async _gcSearchEvents")
    );

    const knnQueryPattern = /for\s*\(\s*const\s+frag\s+of\s+frags\s*\)\s*\{[^}]*queryWithAgentVector/s;
    assert.ok(
      !knnQueryPattern.test(compressMethod),
      "for-of 루프 내 개별 queryWithAgentVector 호출은 제거되어야 한다"
    );
  });

  it("배치 슬라이싱 패턴이 올바르게 적용되어 있다", async () => {
    const { readFileSync } = await import("fs");
    const { join }         = await import("path");
    const src = readFileSync(
      join(process.cwd(), "lib", "memory", "consolidate", "ConsolidatorGC.js"), "utf-8"
    );

    assert.ok(
      src.includes("frags.slice(i, i + BATCH_SIZE)"),
      "BATCH_SIZE 단위 슬라이싱 필수"
    );
    assert.ok(
      src.includes("i += BATCH_SIZE"),
      "BATCH_SIZE 단위 인덱스 증가 필수"
    );
  });

  it("기존 병합 로직(group sort, supersedes, valid_to)이 유지된다", async () => {
    const { readFileSync } = await import("fs");
    const { join }         = await import("path");
    const src = readFileSync(
      join(process.cwd(), "lib", "memory", "consolidate", "ConsolidatorGC.js"), "utf-8"
    );

    const compressMethod = src.slice(
      src.indexOf("async compressOldFragments"),
      src.indexOf("async _gcSearchEvents")
    );

    assert.ok(
      compressMethod.includes("group.sort"),
      "importance 기반 그룹 정렬 유지 필수"
    );
    assert.ok(
      compressMethod.includes("supersedes"),
      "supersedes 링크 생성 유지 필수"
    );
    assert.ok(
      compressMethod.includes("valid_to = NOW()"),
      "soft delete valid_to 설정 유지 필수"
    );
    assert.ok(
      compressMethod.includes("access_count"),
      "access_count 합산 유지 필수"
    );
  });

  it("cosine similarity 임계값 0.80이 유지된다", async () => {
    const { readFileSync } = await import("fs");
    const { join }         = await import("path");
    const src = readFileSync(
      join(process.cwd(), "lib", "memory", "consolidate", "ConsolidatorGC.js"), "utf-8"
    );

    assert.ok(
      src.includes("cos < 0.80"),
      "cosine similarity 임계값 0.80 유지 필수"
    );
  });

  it("assigned 필터링으로 이미 할당된 파편을 배치에서 제외한다", async () => {
    const { readFileSync } = await import("fs");
    const { join }         = await import("path");
    const src = readFileSync(
      join(process.cwd(), "lib", "memory", "consolidate", "ConsolidatorGC.js"), "utf-8"
    );

    assert.ok(
      src.includes("unassignedBatch") || src.includes("!assigned.has"),
      "배치 내 이미 할당된 파편 제외 로직 필수"
    );
  });
});
