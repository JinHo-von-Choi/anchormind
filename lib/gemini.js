/**
 * Gemini CLI Client (memento-mcp 전용)
 *
 * 작성자: 최진호
 * 작성일: 2026-02-13
 * 수정일: 2026-04-16 (LLM Dispatcher thin shim 전환)
 *
 * public API:
 *   isGeminiCLIAvailable() — LLM chain 전체 가용성 위임 (llm/index.js)
 *   geminiCLIJson()        — LLM chain 전체 JSON 호출 위임 (llm/index.js)
 *   runGeminiCLI()         — CLI 저수준 호출 (시그니처 불변, GeminiCliProvider 전용)
 *   _rawIsGeminiCLIAvailable() — 실제 CLI 바이너리 존재 여부 (GeminiCliProvider 전용)
 *
 * 기존 5개 caller (AutoReflect, MorphemeIndex, ConsolidatorGC,
 * ContradictionDetector, MemoryEvaluator)는 수정 없이 계속 동작한다.
 */

import { spawn } from "child_process";
import { buildCliEnv } from "./llm/util/cli-env.js";
import {
  clampAvailabilityTimeoutMs,
  shouldCacheAvailabilityFailure
} from "./llm/util/availability-timeout.js";

// ---------------------------------------------------------------------------
// 내부 전용: 실제 CLI 바이너리 존재 여부 확인
// GeminiCliProvider.isAvailable()에서 호출한다.
// geminiCLIAvailable()(public)은 이제 체인 전체 위임이므로, CLI 자체 확인은
// 이 함수로 분리하여 순환 의존성을 방지한다.
// ---------------------------------------------------------------------------

let _geminiCLICached = null;

/**
 * Gemini CLI 바이너리(`gemini`) 설치 여부를 확인한다.
 * GeminiCliProvider 내부 전용 — 일반 호출부에서 직접 사용하지 말 것.
 *
 * @returns {Promise<boolean>}
 */
export async function _rawIsGeminiCLIAvailable(timeoutMs = null) {
  if (_geminiCLICached !== null) return _geminiCLICached;
  const availabilityTimeoutMs = clampAvailabilityTimeoutMs(timeoutMs);
  try {
    const { execSync } = await import("child_process");
    execSync("which gemini", { stdio: "ignore", timeout: availabilityTimeoutMs });
    _geminiCLICached = true;
  } catch {
    if (shouldCacheAvailabilityFailure(availabilityTimeoutMs)) {
      _geminiCLICached = false;
    }
    return false;
  }
  return _geminiCLICached;
}

// ---------------------------------------------------------------------------
// Public API (thin shim → llm/index.js 위임)
// ---------------------------------------------------------------------------

/**
 * LLM chain에 사용 가능한 provider가 있는지 확인한다.
 * (기존 "Gemini CLI 설치 여부" 의미에서 "LLM chain 가용성"으로 확장)
 *
 * @returns {Promise<boolean>}
 */
export async function isGeminiCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}

/**
 * LLM chain을 통해 JSON 응답을 생성한다.
 * (기존 Gemini CLI 직접 호출에서 LLM chain 위임으로 전환)
 *
 * @param {string} prompt   - JSON 응답을 요구하는 프롬프트
 * @param {Object} options  - { timeoutMs, model }
 * @returns {Promise<Object>} 파싱된 JSON 객체
 */
export async function geminiCLIJson(prompt, options = {}) {
  const { llmJson } = await import("./llm/index.js");
  return llmJson(prompt, options);
}

// ---------------------------------------------------------------------------
// 저수준 CLI 호출 — GeminiCliProvider 전용, 시그니처 불변
// ---------------------------------------------------------------------------

/**
 * Gemini CLI로 텍스트 생성 (stdin 컨텍스트 + -p 프롬프트)
 *
 * @param {string} stdinContent - stdin으로 전달할 컨텍스트
 * @param {string} prompt       - -p 옵션으로 전달할 지시 프롬프트
 * @param {Object} options      - 옵션 (timeoutMs, model)
 * @returns {Promise<string>} Gemini CLI 출력 텍스트
 */
export async function runGeminiCLI(stdinContent, prompt, options = {}) {
  const timeoutMs = options.timeoutMs || 360_000;

  return new Promise((resolve, reject) => {
    const args  = ["-p", prompt, "--output-format", "text", "-y"];
    const model = options.model;
    if (model) args.push("--model", model);

    const proc = spawn("gemini", args, {
      env:   buildCliEnv("gemini"),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout  = "";
    let stderr  = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        reject(new Error(`Gemini CLI timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`Gemini CLI exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`Gemini CLI spawn error: ${err.message}`));
      }
    });

    if (stdinContent) {
      proc.stdin.write(stdinContent, "utf8");
    }
    proc.stdin.end();
  });
}
