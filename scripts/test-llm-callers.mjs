#!/usr/bin/env node
/**
 * test-llm-callers.mjs — LLM caller JSON 스키마 E2E 검증
 *
 * 작성자: 최진호
 * 수정일: 2026-04-20 (v2.12.0 문서 현행화 반영)
 *
 * 목적: AutoReflect, ConsolidatorGC, ContradictionDetector, MemoryEvaluator 4개 LLM caller가
 *       외부 LLM으로부터 올바른 JSON 구조를 응답받는지 E2E 검증한다.
 * 호출 조건: LLM provider 변경 또는 caller 프롬프트 수정 후 회귀 확인
 * 빈도: 조건부
 * 의존: LLM_PRIMARY, LLM_FALLBACKS, POSTGRES_*, REDIS_*, OPENAI_API_KEY, LOG_DIR
 *       외부 LLM 엔드포인트(Gemini CLI, Ollama Cloud 등) 네트워크 접근 가능
 * 관련 문서: docs/operations/llm-providers.md, docs/operations/maintenance.md
 *
 * 검증 케이스 5종:
 *   1. AutoReflect — _buildReflectPrompts + llmJson, 5개 필수 키 확인
 *   2. ConsolidatorGC — 장문 텍스트 분할, JSON 배열 타입 확인
 *   3. ContradictionDetector.askGeminiSupersession — { supersedes: boolean, reasoning: string }
 *   4. ContradictionDetector.askGeminiContradiction — { contradicts: boolean, reasoning: string }
 *   5. MemoryEvaluator — { score: number, rationale: string, action: keep|downgrade|discard }
 *
 * 종료 코드: 전체 통과 0, 하나 이상 실패 1. stdout에 PASS N/5  FAIL M/5 요약 출력.
 */

import { createRequire } from "module";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// .env 로드 (LLM_FALLBACKS 등 JSON 값 포함 처리)
const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);
const dotenv    = require("dotenv");
dotenv.config({ path: resolve(__dirname, "../.env") });

import { _buildReflectPrompts } from "../lib/memory/processors/AutoReflect.js";
import { llmJson }               from "../lib/llm/index.js";
import { ContradictionDetector } from "../lib/memory/link/ContradictionDetector.js";

const results = [];

async function test(name, fn) {
  const t0 = Date.now();
  try {
    const result    = await fn();
    const duration  = Date.now() - t0;
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    results.push({ name, status: "PASS", duration, preview: resultStr.slice(0, 200) });
    console.log(`PASS [${duration}ms] ${name}`);
    console.log(`  -> ${resultStr.slice(0, 250)}`);
  } catch (err) {
    const duration = Date.now() - t0;
    results.push({ name, status: "FAIL", duration, error: err.message });
    console.log(`FAIL [${duration}ms] ${name}`);
    console.log(`  error: ${err.message}`);
  }
}

// ============================================================
// Test 1: AutoReflect
// ============================================================
await test("AutoReflect (_buildReflectPrompts + llmJson)", async () => {
  const { systemPrompt, userPrompt } = _buildReflectPrompts("test-session-1", {
    toolCalls   : { remember: 5, recall: 3, link: 1 },
    keywords    : ["프로젝트A", "nginx", "포트-변경"],
    fragments   : new Array(8),
    startedAt   : Date.now() - 3600000,
    lastActivity: Date.now()
  });
  const result = await llmJson(userPrompt, { timeoutMs: 90000, systemPrompt });
  // AutoReflect 예상 스키마 검증
  if (typeof result !== "object" || result === null) throw new Error("not object");
  const required = ["summary", "decisions", "errors_resolved", "new_procedures", "open_questions"];
  for (const key of required) {
    if (!(key in result)) throw new Error(`missing key: ${key}`);
  }
  return result;
});

// ============================================================
// Test 2: ConsolidatorGC splitLongFragments prompt (직접 llmJson으로 재현)
// ============================================================
await test("ConsolidatorGC (long text split)", async () => {
  const systemPrompt =
    "You are a JSON array generator for text splitting. " +
    "Your ONLY output MUST be a valid JSON array of strings. " +
    "Do NOT include markdown fences, explanations, reasoning, preambles, or ANY other text. " +
    "Output must be directly parseable by JSON.parse(). " +
    "Format: [\"sentence1\",\"sentence2\",\"sentence3\"]";

  const longText =
    "Memento MCP는 v2.8.0에서 Symbolic Memory Phase 0~6과 LLM Provider Fallback Chain을 도입했다. " +
    "Symbolic Memory는 기본 플래그 전부 off 상태로 v2.7.0 동작을 완전히 보존한다. " +
    "LLM Fallback Chain은 Gemini CLI 외 12개 외부 provider를 JSON 배열 설정으로 등록할 수 있다.";

  const userPrompt =
    `다음 텍스트를 2~5개의 원자적 사실로 분리하라.\n` +
    `각 항목은 1~2문장의 독립적으로 이해 가능한 단일 사실이어야 한다.\n` +
    `원문 정보를 손실 없이 유지한다.\n\n` +
    `예시:\n` +
    `입력: "Redis는 포트 6379로 동작하고 메모리 기반 key-value 저장소이며 TTL 만료 정책을 지원한다"\n` +
    `출력: ["Redis는 포트 6379로 동작한다","Redis는 메모리 기반 key-value 저장소다","Redis는 TTL 만료 정책을 지원한다"]\n\n` +
    `이제 다음을 분리하라:\n` +
    `입력: "${longText}"\n` +
    `출력:`;

  const result = await llmJson(userPrompt, { timeoutMs: 60000, systemPrompt });
  if (!Array.isArray(result)) throw new Error("not array");
  if (result.length < 2) throw new Error(`too few items: ${result.length}`);
  for (const item of result) {
    if (typeof item !== "string") throw new Error(`non-string item: ${typeof item}`);
  }
  return result;
});

// ============================================================
// Test 3: ContradictionDetector.askGeminiSupersession
// ============================================================
await test("ContradictionDetector.askGeminiSupersession", async () => {
  const cd     = new ContradictionDetector();
  const result = await cd.askGeminiSupersession(
    "데이터베이스는 PostgreSQL 12를 사용한다",
    "데이터베이스는 PostgreSQL 15로 업그레이드됐다"
  );
  if (typeof result !== "object" || result === null) throw new Error("not object");
  if (typeof result.supersedes !== "boolean") throw new Error("supersedes not boolean");
  if (typeof result.reasoning !== "string")   throw new Error("reasoning not string");
  return result;
});

// ============================================================
// Test 4: ContradictionDetector.askGeminiContradiction
// ============================================================
await test("ContradictionDetector.askGeminiContradiction", async () => {
  const cd     = new ContradictionDetector();
  const result = await cd.askGeminiContradiction(
    "MCP 포트는 5432",
    "MCP 포트는 15432"
  );
  if (typeof result !== "object" || result === null) throw new Error("not object");
  if (typeof result.contradicts !== "boolean") throw new Error("contradicts not boolean");
  if (typeof result.reasoning !== "string")    throw new Error("reasoning not string");
  return result;
});

// ============================================================
// Test 5: MemoryEvaluator (evaluate prompt 재현)
// ============================================================
await test("MemoryEvaluator (quality evaluation)", async () => {
  const systemPrompt =
    "You are a JSON object generator for knowledge fragment quality evaluation. " +
    "Your ONLY output MUST be a valid JSON object matching this exact schema: " +
    "{\"score\": <float 0-1>, \"rationale\": <single Korean sentence>, \"action\": \"keep\"|\"downgrade\"|\"discard\"}. " +
    "Do NOT include markdown fences, explanations, reasoning outside the rationale field, preambles, or ANY other text. " +
    "Output must be directly parseable by JSON.parse().";

  const userPrompt = `다음 지식 파편의 미래 활용 가치를 평가하라.
유형: decision
내용: "v2.8.0부터 LLM fallback chain은 LLM_FALLBACKS JSON 배열로 설정한다"

평가 기준:
1. score: 0~1 사이. 미래에 에이전트가 이 정보를 얼마나 필요로 할지
2. rationale: 왜 이 정보를 저장해야 하는지 1문장 이유
3. action: "keep" | "downgrade" | "discard"

예시:
유형: decision
내용: "v2.8.0부터 LLM fallback chain은 LLM_FALLBACKS JSON 배열로 설정한다"
응답: {"score": 0.85, "rationale": "향후 LLM 관련 작업 시 설정 규칙 참조가 필요함", "action": "keep"}

유형: fact
내용: "테스트"
응답: {"score": 0.1, "rationale": "맥락 없는 단발 문자열로 재활용 가치 없음", "action": "discard"}

응답:`;

  const result = await llmJson(userPrompt, { timeoutMs: 60000, systemPrompt });
  if (typeof result !== "object" || result === null) throw new Error("not object");
  if (typeof result.score !== "number")             throw new Error("score not number");
  if (typeof result.rationale !== "string")         throw new Error("rationale not string");
  if (!["keep", "downgrade", "discard"].includes(result.action)) {
    throw new Error(`invalid action: ${result.action}`);
  }
  return result;
});

// ============================================================
// Summary
// ============================================================
console.log("\n=== Summary ===");
const passCount = results.filter(r => r.status === "PASS").length;
const failCount = results.filter(r => r.status === "FAIL").length;
console.log(`PASS: ${passCount}/${results.length}  FAIL: ${failCount}/${results.length}`);
for (const r of results) {
  console.log(`  [${r.status}] ${r.duration}ms  ${r.name}`);
}
process.exit(failCount > 0 ? 1 : 0);
