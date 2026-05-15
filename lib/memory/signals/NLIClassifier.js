/**
 * NLIClassifier - Natural Language Inference 기반 모순 탐지 (듀얼 모드)
 *
 * 작성자: 최진호
 * 작성일: 2026-02-28
 *
 * 두 파편의 관계를 entailment / contradiction / neutral로 분류한다.
 *
 * 모드 1 (External): NLI_SERVICE_URL 환경변수가 설정되면 외부 NLI HTTP 서비스를 호출.
 *   - 별도 Docker 컨테이너 등 사전 배포된 NLI 서비스 활용
 *   - 모델 로딩/메모리 오버헤드 없음
 *
 * 모드 2 (In-Process): NLI_SERVICE_URL 미설정 시 ONNX 모델을 프로세스 내에서 직접 실행.
 *   - @huggingface/transformers + onnxruntime-node (CPU)
 *   - 모델: Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7
 *   - ~280MB ONNX (최초 실행 시 자동 다운로드, 이후 캐싱)
 *   - 단일 추론 ~50-200ms (warm)
 *
 * 3단계 하이브리드 파이프라인에서의 위치:
 *   1. pgvector 코사인 유사도 > 0.85 → 후보 필터
 *   2. NLI 분류 (이 모듈) → 명확한 모순 즉시 해결
 *   3. Gemini CLI 에스컬레이션 → 수치/도메인 모순 처리
 */

import { INPROCESS_ONNX_ENABLED, NLI_SERVICE_URL, NLI_TIMEOUT_MS } from "../../config.js";
import { logInfo, logWarn } from "../../logger.js";

/** ─── 공유 상태 ─── */
let _mode    = NLI_SERVICE_URL ? "external" : (INPROCESS_ONNX_ENABLED ? "inprocess" : "disabled");
let _failed  = false;

/** ─── In-Process 전용 상태 ─── */
let _tokenizer = null;
let _model     = null;
let _id2label  = null;
let _loading   = null;

const MODEL_ID = "Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7";

/** ─── External 모드: HTTP 호출 ─── */

/**
 * 외부 NLI 서비스로 분류 요청
 * @param {string} premise
 * @param {string} hypothesis
 * @returns {Promise<{label: string, scores: object} | null>}
 */
async function classifyExternal(premise, hypothesis) {
  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), NLI_TIMEOUT_MS);

    const res = await fetch(`${NLI_SERVICE_URL}/classify`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ premise, hypothesis }),
      signal:  controller.signal
    });

    clearTimeout(timer);

    if (!res.ok) {
      logWarn(`[NLIClassifier] External service returned ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      logWarn(`[NLIClassifier] External service timeout (${NLI_TIMEOUT_MS}ms)`);
    } else {
      logWarn(`[NLIClassifier] External service error: ${err.message}`);
    }
    return null;
  }
}

/** ─── In-Process 모드: ONNX 직접 추론 ─── */

/**
 * 모델 + 토크나이저 싱글턴 로드
 * 최초 호출 시 ~30초 (다운로드 + ONNX 초기화), 이후 즉시 반환
 */
async function loadModel() {
  if (_model && _tokenizer) return { tokenizer: _tokenizer, model: _model };
  if (_failed) return null;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      const { AutoTokenizer, AutoModelForSequenceClassification } =
        await import("@huggingface/transformers");

      logInfo(`[NLIClassifier] Loading model: ${MODEL_ID} ...`);
      const t0 = Date.now();

      _tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      _model     = await AutoModelForSequenceClassification.from_pretrained(
        MODEL_ID,
        { dtype: "q8" }
      );

      _id2label = _model.config.id2label ||
        { 0: "entailment", 1: "neutral", 2: "contradiction" };

      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      logInfo(`[NLIClassifier] Model ready in ${sec}s (labels: ${JSON.stringify(_id2label)})`);

      return { tokenizer: _tokenizer, model: _model };
    } catch (err) {
      logWarn(`[NLIClassifier] Model load failed: ${err.message}`);
      _failed = true;
      return null;
    } finally {
      _loading = null;
    }
  })();

  return _loading;
}

/**
 * softmax 유틸리티
 * @param {number[]} logits
 * @returns {number[]}
 */
function softmax(logits) {
  const maxVal = Math.max(...logits);
  const exps   = logits.map(x => Math.exp(x - maxVal));
  const sum    = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

/**
 * In-process ONNX 추론
 * @param {string} premise
 * @param {string} hypothesis
 * @returns {Promise<{label: string, scores: object} | null>}
 */
async function classifyInProcess(premise, hypothesis) {
  const loaded = await loadModel();
  if (!loaded) return null;

  try {
    const { tokenizer, model } = loaded;

    const inputs = tokenizer(premise, {
      text_pair:  hypothesis,
      padding:    true,
      truncation: true
    });

    const output = await model(inputs);
    const probs  = softmax(Array.from(output.logits.data));

    const scores = {};
    let topLabel = "";
    let topScore = -1;

    for (const [idx, label] of Object.entries(_id2label)) {
      const p       = probs[parseInt(idx)];
      scores[label] = p;
      if (p > topScore) {
        topScore = p;
        topLabel = label;
      }
    }

    return { label: topLabel, scores };
  } catch (err) {
    logWarn(`[NLIClassifier] Inference failed: ${err.message}`);
    return null;
  }
}

/** ─── 공용 API ─── */

/**
 * NLI 모델 사용 가능 여부 (동기)
 */
export function isNLIAvailable() {
  if (_mode === "disabled") return false;
  if (_mode === "external") return true;
  return !_failed;
}

/**
 * 두 텍스트의 NLI 관계를 분류
 *
 * @param {string} premise    - 기존 파편 내용
 * @param {string} hypothesis - 신규 파편 내용
 * @returns {Promise<{label: string, scores: {entailment: number, neutral: number, contradiction: number}} | null>}
 */
export async function classifyNLI(premise, hypothesis) {
  if (_mode === "external") {
    return classifyExternal(premise, hypothesis);
  }
  if (_mode === "disabled") {
    return null;
  }
  return classifyInProcess(premise, hypothesis);
}

/**
 * 두 파편이 모순인지 판정
 *
 * 판정 기준:
 *   - contradiction score >= 0.8 → 확정 모순, 에스컬레이션 불필요
 *   - contradiction score >= 0.5 → 의심 모순, LLM 에스컬레이션 필요
 *   - entailment score >= 0.6    → 비모순 확정
 *   - 그 외                      → 에스컬레이션 필요
 *
 * @param {string} contentA - 파편 A 내용
 * @param {string} contentB - 파편 B 내용
 * @returns {Promise<{contradicts: boolean, confidence: number, needsEscalation: boolean, scores: object} | null>}
 */
export async function detectContradiction(contentA, contentB) {
  const result = await classifyNLI(contentA, contentB);
  if (!result) return null;

  const { scores } = result;
  const cScore     = scores.contradiction || 0;
  const eScore     = scores.entailment    || 0;

  if (cScore >= 0.8) {
    return { contradicts: true,  confidence: cScore, needsEscalation: false, scores };
  }

  if (eScore >= 0.6) {
    return { contradicts: false, confidence: eScore, needsEscalation: false, scores };
  }

  if (cScore >= 0.5) {
    return { contradicts: true,  confidence: cScore, needsEscalation: true,  scores };
  }

  return {
    contradicts:     false,
    confidence:      scores.neutral || 0,
    needsEscalation: cScore >= 0.2,
    scores
  };
}

/**
 * NLI 사전 로드 (서버 시작 시 호출)
 * External 모드: 헬스체크, In-Process 모드: 모델 로드
 */
export async function preloadNLI() {
  if (_mode === "external") {
    try {
      const res = await fetch(`${NLI_SERVICE_URL}/health`, {
        signal: AbortSignal.timeout(3000)
      });
      const data = await res.json();
      logInfo(`[NLIClassifier] External mode: ${NLI_SERVICE_URL} (model: ${data.model || "unknown"})`);
    } catch (err) {
      if (INPROCESS_ONNX_ENABLED) {
        logWarn(`[NLIClassifier] External service health check failed: ${err.message}, falling back to in-process`);
        _mode = "inprocess";
        await loadModel();
      } else {
        logWarn(`[NLIClassifier] External service health check failed: ${err.message}; in-process ONNX disabled`);
        _mode = "disabled";
      }
    }
    return;
  }

  if (_mode === "disabled") {
    logInfo("[NLIClassifier] In-process ONNX disabled by MEMENTO_INPROCESS_ONNX_ENABLED=false");
    return;
  }

  logInfo("[NLIClassifier] In-process mode: loading ONNX model...");
  await loadModel();
}
