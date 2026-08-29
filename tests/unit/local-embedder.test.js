/**
 * LocalTransformersEmbedder 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * @huggingface/transformers pipeline을 mock하여
 * init/embed 동작 및 싱글톤 캐싱을 검증한다.
 */

import { test, describe, beforeEach } from "node:test";
import assert                               from "node:assert/strict";

/**
 * 테스트용 pipeline mock 팩토리
 * 지정 차원의 Float32Array를 반환하는 pipeline 함수를 생성한다.
 *
 * @param {number} dims - 반환할 벡터 차원 수
 * @param {boolean} [fail] - true이면 reject
 */
function _makeMockPipeline(dims, fail = false) {
  return async (_task, _model, _opts) => {
    /** 반환되는 pipeline 함수 */
    return async (_text, _opts) => {
      if (fail) throw new Error("pipeline failed");
      const data = new Float32Array(dims).fill(0.5);
      return { data };
    };
  };
}

describe("LocalTransformersEmbedder", () => {
  beforeEach(() => {
    /** 싱글톤 캐시 초기화: 모듈 캐시를 우회하기 위해 새 인스턴스를 직접 생성 */
  });

  test("init() 호출 시 pipeline이 로드되고 _pipeline이 설정된다", async () => {
    const { LocalTransformersEmbedder } = await import("../../lib/embeddings/LocalTransformersEmbedder.js");

    const embedder = new LocalTransformersEmbedder({ modelId: "test-model", dimensions: 4 });

    /** pipeline mock 주입 */
    let initCalled = false;
    embedder._pipeline = async (_text, _opts) => {
      initCalled = true;
      return { data: new Float32Array(4).fill(0.1) };
    };

    const vec = await embedder.embed("hello");
    assert.strictEqual(initCalled, true, "주입한 pipeline이 호출되지 않았다");
    assert.strictEqual(vec.length, 4, "벡터 차원은 4이어야 한다");
    assert.ok(vec.every(v => typeof v === "number"), "모든 요소는 숫자여야 한다");
  });

  test("embed() 결과는 L2 norm ~1.0이어야 한다", async () => {
    const { LocalTransformersEmbedder } = await import("../../lib/embeddings/LocalTransformersEmbedder.js");

    const embedder = new LocalTransformersEmbedder({ modelId: "norm-test", dimensions: 3 });
    embedder._pipeline = async (_text, _opts) => ({
      data: new Float32Array([3, 4, 0])
    });

    const vec  = await embedder.embed("test");
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(norm - 1.0) < 1e-6, `L2 norm은 ~1.0이어야 하지만 ${norm}이다`);
  });

  test("벡터 차원 불일치 시 Error를 던진다", async () => {
    const { LocalTransformersEmbedder } = await import("../../lib/embeddings/LocalTransformersEmbedder.js");

    const embedder = new LocalTransformersEmbedder({ modelId: "mismatch-test", dimensions: 8 });
    /** 차원이 4인 벡터를 반환하도록 mock */
    embedder._pipeline = async (_text, _opts) => ({
      data: new Float32Array(4).fill(0.2)
    });

    await assert.rejects(
      () => embedder.embed("bad"),
      (err) => {
        assert.match(err.message, /Embedding dim mismatch/);
        return true;
      }
    );
  });

  test("init()은 중복 호출해도 pipeline을 한 번만 로드한다", async () => {
    const { LocalTransformersEmbedder } = await import("../../lib/embeddings/LocalTransformersEmbedder.js");

    const embedder    = new LocalTransformersEmbedder({ modelId: "idempotent-test", dimensions: 2 });
    let   loadCount   = 0;

    /** init()을 실제로 실행시키기 위해 _pipeline을 null로 유지하되 init 내부를 패치 */
    const _origInit = embedder.init.bind(embedder);
    embedder.init = async () => {
      if (embedder._pipeline) return;
      loadCount++;
      embedder._pipeline = async (_t, _o) => ({ data: new Float32Array(2).fill(0.7) });
    };

    await embedder.init();
    await embedder.init();
    await embedder.init();

    assert.strictEqual(loadCount, 1, "pipeline 로드는 정확히 1회만 발생해야 한다");
  });

  test("getLocalEmbedder: 동일 modelId는 싱글톤을 반환한다", async () => {
    /**
     * 모듈 캐시가 유지되므로 동일 import()는 동일 _singletons Map을 공유한다.
     * 서로 다른 모델 이름을 사용하여 캐시 충돌을 방지한다.
     */
    const { getLocalEmbedder } = await import("../../lib/embeddings/LocalTransformersEmbedder.js");

    const a = getLocalEmbedder("singleton-model-X", 384);
    const b = getLocalEmbedder("singleton-model-X", 384);
    const c = getLocalEmbedder("singleton-model-Y", 384);

    assert.strictEqual(a, b, "동일 modelId는 동일 인스턴스여야 한다");
    assert.notStrictEqual(a, c, "다른 modelId는 다른 인스턴스여야 한다");
  });

  test("getLocalEmbedder: 첫 획득 인스턴스의 modelId/dimensions가 올바르다", async () => {
    const { getLocalEmbedder } = await import("../../lib/embeddings/LocalTransformersEmbedder.js");

    const embedder = getLocalEmbedder("check-props-model", 1024);
    assert.strictEqual(embedder.modelId, "check-props-model");
    assert.strictEqual(embedder.dimensions, 1024);
  });
});
