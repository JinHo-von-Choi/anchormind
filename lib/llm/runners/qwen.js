/**
 * Qwen CLI raw runner (memento-mcp 전용)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-22
 *
 * public API:
 *   _rawIsQwenCLIAvailable()  — CLI 바이너리 존재 여부 (QwenCliProvider 전용)
 *   runQwenCLI()              — CLI 저수준 호출 (QwenCliProvider 전용)
 *
 * 체인 진입점에 의존하지 않고 CLI 바이너리 확인과 실행만 담당한다.
 */

import { spawn } from "child_process";
import { buildCliEnv } from "../util/cli-env.js";
import {
  clampAvailabilityTimeoutMs,
  shouldCacheAvailabilityFailure
} from "../util/availability-timeout.js";

// ---------------------------------------------------------------------------
// 내부 전용: 실제 CLI 바이너리 존재 여부 확인
// QwenCliProvider.isAvailable()에서 호출한다.
// ---------------------------------------------------------------------------

let _qwenCLICached = null;

/**
 * Qwen CLI 바이너리(`qwen`) 설치 여부를 확인한다.
 * QwenCliProvider 내부 전용 — 일반 호출부에서 직접 사용하지 말 것.
 *
 * @returns {Promise<boolean>}
 */
export async function _rawIsQwenCLIAvailable(timeoutMs = null) {
  if (_qwenCLICached !== null) return _qwenCLICached;
  const availabilityTimeoutMs = clampAvailabilityTimeoutMs(timeoutMs);
  try {
    const { execSync } = await import("child_process");
    execSync("which qwen", { stdio: "ignore", timeout: availabilityTimeoutMs });
    _qwenCLICached = true;
  } catch {
    if (shouldCacheAvailabilityFailure(availabilityTimeoutMs)) {
      _qwenCLICached = false;
    }
    return false;
  }
  return _qwenCLICached;
}

// ---------------------------------------------------------------------------
// 저수준 CLI 호출 — QwenCliProvider 전용
// ---------------------------------------------------------------------------

/**
 * Qwen CLI로 텍스트 생성 (stdin 컨텍스트 + positional 프롬프트)
 *
 * 실행 contract:
 *   qwen PROMPT --output-format text [-m MODEL]
 *   - model 미지정 시 Qwen CLI 기본 모델 사용
 *   - stdin 입력은 --input-format text(기본값)로 자동 처리
 *
 * @param {string} stdinContent - stdin으로 전달할 컨텍스트 (빈 문자열이면 주입 없음)
 * @param {string} prompt       - positional 인자로 전달할 지시 프롬프트
 * @param {Object} [options={}]
 * @param {number} [options.timeoutMs=120000] - 프로세스 타임아웃 (ms)
 * @param {string} [options.model]            - 사용할 모델명 (-m 플래그, 없으면 CLI 기본값)
 * @returns {Promise<string>} Qwen CLI 출력 텍스트
 */
export async function runQwenCLI(stdinContent, prompt, options = {}) {
  const timeoutMs = options.timeoutMs || 120_000;

  return new Promise((resolve, reject) => {
    const args = ["--output-format", "text"];
    if (options.model) args.push("-m", options.model);
    args.push(prompt);

    const proc = spawn("qwen", args, {
      env:   buildCliEnv("qwen"),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout  = "";
    let stderr  = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        reject(new Error(`Qwen CLI timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`Qwen CLI exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`Qwen CLI spawn error: ${err.message}`));
      }
    });

    if (stdinContent) {
      proc.stdin.write(stdinContent, "utf8");
    }
    proc.stdin.end();
  });
}
