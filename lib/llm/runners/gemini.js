/**
 * Gemini CLI raw runner (memento-mcp 전용)
 *
 * 작성자: 최진호
 * 작성일: 2026-02-13
 * 수정일: 2026-04-16 (LLM Dispatcher thin shim 전환)
 *
 * public API:
 *   runGeminiCLI()         — CLI 저수준 호출 (시그니처 불변, GeminiCliProvider 전용)
 *   _rawIsGeminiCLIAvailable() — 실제 CLI 바이너리 존재 여부 (GeminiCliProvider 전용)
 *
 * 체인 진입점에 의존하지 않고 CLI 바이너리 확인과 실행만 담당한다.
 */

import { spawn } from "child_process";
import { buildCliEnv } from "../util/cli-env.js";
import { cliToolApprovalMode, cliWorkDir } from "../util/cli-approval.js";
import {
  clampAvailabilityTimeoutMs,
  shouldCacheAvailabilityFailure
} from "../util/availability-timeout.js";

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
  const approval  = cliToolApprovalMode();

  return new Promise((resolve, reject) => {
    const args  = ["-p", prompt, "--output-format", "text"];
    const model = options.model;
    if (approval === "all") args.push("-y");
    if (model) args.push("--model", model);

    const proc = spawn("gemini", args, {
      env:   buildCliEnv("gemini", approval === "all" ? {} : { GEMINI_CLI_TRUST_WORKSPACE: "true" }),
      cwd:   approval === "all" ? undefined : cliWorkDir(),
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
