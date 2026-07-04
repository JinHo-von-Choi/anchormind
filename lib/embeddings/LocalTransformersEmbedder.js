/**
 * 로컬 transformers.js 기반 임베딩 provider.
 * API 호출 없이 Xenova/multilingual-e5-small 등 HuggingFace 모델을 로컬에서 실행.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 */

import { pipeline }    from "@huggingface/transformers";
import { normalizeL2 } from "../tools/embedding.js";

/** 모델 싱글톤 캐시 (modelId → LocalTransformersEmbedder) */
const _singletons = new Map();

export class LocalTransformersEmbedder {
  constructor({ modelId, dimensions }) {
    this.modelId      = modelId;
    this.dimensions   = dimensions;
    this._pipeline    = null;
    this._initPromise = null;
    this._queue       = Promise.resolve();
  }

  async init() {
    if (this._pipeline) return;
    if (!this._initPromise) {
      console.info(`[LocalEmbedder] loading model ${this.modelId} (dtype=q8)`);
      this._initPromise = pipeline("feature-extraction", this.modelId, { dtype: "q8" })
        .then((p) => {
          this._pipeline = p;
          console.info(`[LocalEmbedder] model ready`);
        })
        .finally(() => { this._initPromise = null; });
    }
    await this._initPromise;
  }

  /**
   * ONNX 파이프라인은 단일 인스턴스이므로 추론을 FIFO 체인으로 직렬화한다.
   * 실패한 작업이 체인을 끊지 않도록 대기 자체는 에러를 삼키고,
   * 호출자에게는 원래 promise의 성공/실패를 그대로 전달한다.
   */
  _enqueue(job) {
    const run    = this._queue.then(job, job);
    this._queue  = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 단일 텍스트 임베딩 생성
   *
   * @param {string} text
   * @returns {Promise<number[]>} L2 정규화된 임베딩 벡터
   */
  async embed(text) {
    await this.init();
    return this._enqueue(async () => {
      const output = await this._pipeline(text, { pooling: "mean", normalize: true });
      const vec    = Array.from(output.data);
      this._assertDims(vec);
      return normalizeL2(vec);
    });
  }

  /**
   * 배열 입력 1회 추론으로 배치 임베딩 생성
   *
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embedBatch(texts) {
    if (!texts.length) return [];
    await this.init();
    return this._enqueue(async () => {
      const output = await this._pipeline(texts, { pooling: "mean", normalize: true });
      const rows   = typeof output.tolist === "function"
        ? output.tolist()
        : this._chunkFlat(Array.from(output.data), texts.length);
      return rows.map((row) => {
        const vec = Array.from(row);
        this._assertDims(vec);
        return normalizeL2(vec);
      });
    });
  }

  _assertDims(vec) {
    if (vec.length !== this.dimensions) {
      throw new Error(`Embedding dim mismatch: expected ${this.dimensions}, got ${vec.length}`);
    }
  }

  /** tolist() 미지원 출력 폴백: 평탄 배열을 텍스트 수로 균등 분할 */
  _chunkFlat(flat, count) {
    const dims = flat.length / count;
    const rows = [];
    for (let i = 0; i < count; i++) rows.push(flat.slice(i * dims, (i + 1) * dims));
    return rows;
  }
}

/**
 * 동일 modelId에 대한 싱글톤 인스턴스 반환
 *
 * @param {string} modelId
 * @param {number} dimensions
 * @returns {LocalTransformersEmbedder}
 */
export function getLocalEmbedder(modelId, dimensions) {
  if (!_singletons.has(modelId)) {
    _singletons.set(modelId, new LocalTransformersEmbedder({ modelId, dimensions }));
  }
  return _singletons.get(modelId);
}
