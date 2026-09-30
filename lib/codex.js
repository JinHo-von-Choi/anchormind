/**
 * Codex CLI Client (memento-mcp 전용)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * public API:
 *   _rawIsCodexCLIAvailable()  — CLI 바이너리 존재 여부 (CodexCliProvider 전용)
 *   isCodexCLIAvailable()      — LLM chain 가용성 위임 (llm/index.js)
 *   runCodexCLI()              — CLI 저수준 호출 (CodexCliProvider 전용)
 *
 * 순환 의존성 방지:
 *   lib/codex.js → lib/llm/index.js (동적 import, public API에서만)
 *   lib/codex.js는 lib/llm/index.js를 정적 import하지 않는다.
 */

import { spawn }  from "child_process";
import { buildCliEnv } from "./llm/util/cli-env.js";
import fs         from "fs";
import os         from "os";
import path       from "path";
import crypto     from "crypto";
import {
  clampAvailabilityTimeoutMs,
  shouldCacheAvailabilityFailure
} from "./llm/util/availability-timeout.js";

// ---------------------------------------------------------------------------
// 내부 전용: 실제 CLI 바이너리 존재 여부 확인
// CodexCliProvider.isAvailable()에서 호출한다.
// isCodexCLIAvailable()(public)은 체인 전체 위임이므로, CLI 자체 확인은
// 이 함수로 분리하여 순환 의존성을 방지한다.
// ---------------------------------------------------------------------------

let _codexCLICached = null;

/**
 * Codex CLI 바이너리(`codex`) 설치 여부를 확인한다.
 * CodexCliProvider 내부 전용 — 일반 호출부에서 직접 사용하지 말 것.
 *
 * @returns {Promise<boolean>}
 */
export async function _rawIsCodexCLIAvailable(timeoutMs = null) {
  if (_codexCLICached !== null) return _codexCLICached;
  const availabilityTimeoutMs = clampAvailabilityTimeoutMs(timeoutMs);
  try {
    const { execSync } = await import("child_process");
    execSync("which codex", { stdio: "ignore", timeout: availabilityTimeoutMs });
    _codexCLICached = true;
  } catch {
    if (shouldCacheAvailabilityFailure(availabilityTimeoutMs)) {
      _codexCLICached = false;
    }
    return false;
  }
  return _codexCLICached;
}

// ---------------------------------------------------------------------------
// Public API (thin shim → llm/index.js 위임)
// ---------------------------------------------------------------------------

/**
 * LLM chain에 사용 가능한 provider가 있는지 확인한다.
 *
 * @returns {Promise<boolean>}
 */
export async function isCodexCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}

// ---------------------------------------------------------------------------
// 저수준 CLI 호출 — CodexCliProvider 전용
// ---------------------------------------------------------------------------

/**
 * Codex CLI를 비대화형(exec) 모드로 호출하여 에이전트 최종 답변을 반환한다.
 *
 * 구현 전략:
 *   - `--output-last-message FILE` 플래그로 마지막 메시지만 임시 파일에 기록
 *   - `--sandbox read-only` + `--skip-git-repo-check` 로 보수적 실행
 *   - 임시 파일은 try/finally 블록에서 반드시 삭제
 *   - stdinContent 제공 시 stdin으로 주입 (긴 컨텍스트 분리)
 *
 * @param {string} stdinContent - stdin으로 전달할 컨텍스트 (빈 문자열이면 stdin 주입 없음)
 * @param {string} prompt       - exec 인자로 전달할 지시 프롬프트
 * @param {object} [options={}]
 * @param {number} [options.timeoutMs=120000] - 프로세스 타임아웃 (ms)
 * @param {string} [options.model]            - 사용할 모델명 (-m 플래그)
 * @returns {Promise<string>} 에이전트 최종 답변 텍스트
 */
export async function runCodexCLI(stdinContent, prompt, options = {}) {
  const timeoutMs = options.timeoutMs || 120_000;
  const outFile   = path.join(os.tmpdir(), `codex-${crypto.randomUUID()}.txt`);

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--output-last-message", outFile
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(prompt);

  return new Promise((resolve, reject) => {
    const proc = spawn("codex", args, {
      env:   buildCliEnv("codex", { NO_COLOR: "1" }),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let   stdout  = "";
    let   stderr  = "";
    let   settled = false;

    const cleanup = () => {
      try { fs.unlinkSync(outFile); } catch (_) { /* temp output already removed */ }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        cleanup();
        reject(new Error(`Codex CLI timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0) {
        cleanup();
        const detail = (stderr || stdout).trim().slice(0, 1000);
        reject(new Error(`Codex CLI exited with code ${code}: ${detail}`));
        return;
      }

      try {
        const content = fs.readFileSync(outFile, "utf8").trim();
        cleanup();
        resolve(content);
      } catch (readErr) {
        cleanup();
        reject(new Error(`Codex CLI: failed to read output file: ${readErr.message}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Codex CLI spawn error: ${err.message}`));
      }
    });

    if (stdinContent) {
      proc.stdin.write(stdinContent, "utf8");
    }
    proc.stdin.end();
  });
}
