/**
 * GitHub Copilot CLI Client (memento-mcp 전용)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * 정찰 결과 (2026-04-18):
 *   바이너리: PATH 상의 copilot CLI 바이너리
 *   핵심 플래그:
 *     -p <text>              비대화형 프롬프트
 *     --allow-all-tools      도구 자동 실행 허가 (비대화형 필수)
 *     --output-format text   기본값. stdout에 최종 답변만 출력
 *     --effort <level>       low|medium|high|xhigh (reasoning effort)
 *   text 출력 패턴:
 *     - 배열 응답:  ["a","b"]\n\n\nChanges   +0 -0\nRequests...\nTokens...
 *     - 객체 응답:  ```json\n{...}\n```\n\n\nChanges   +0 -0\n...
 *   처리 전략:
 *     1. stdout에서 "Changes " 이후 행(꼬리 통계 블록) 제거
 *     2. extractJsonBlock으로 첫 [...] 또는 {...} 블록 추출
 *     3. ```json 펜스가 감싼 경우도 처리
 *   JSONL 모드 (--output-format json): assistant.message.data.content에 최종 답변 존재하나
 *     MCP 서버 이벤트 노이즈가 수십 KB에 달해 text 모드 대비 비효율 -> 미사용.
 *
 * public API:
 *   _rawIsCopilotCLIAvailable() -- 실제 CLI 바이너리 존재 여부 (CopilotCliProvider 전용)
 *   isCopilotCLIAvailable()    -- LLM chain 전체 가용성 위임 (llm/index.js)
 *   runCopilotCLI()            -- CLI 저수준 호출 (CopilotCliProvider 전용)
 *   extractJsonBlock()         -- JSON 블록 추출 (테스트에서 직접 사용)
 *
 * 순환 의존성 방지:
 *   lib/copilot.js -> lib/llm/index.js (dynamic import -- 공개 API만)
 *   lib/copilot.js -> lib/llm/providers/* (절대 직접 import 금지)
 */

import { spawn } from "child_process";
import {
  clampAvailabilityTimeoutMs,
  shouldCacheAvailabilityFailure
} from "./llm/util/availability-timeout.js";

// ---------------------------------------------------------------------------
// 내부 전용: CLI 바이너리 존재 여부 캐시
// CopilotCliProvider.isAvailable()에서 호출한다.
// ---------------------------------------------------------------------------

let _copilotCLICached = null;

/**
 * GitHub Copilot CLI 바이너리(copilot) 설치 여부를 확인한다.
 * CopilotCliProvider 내부 전용 -- 일반 호출부에서 직접 사용하지 말 것.
 *
 * @returns {Promise<boolean>}
 */
export async function _rawIsCopilotCLIAvailable(timeoutMs = null) {
  if (_copilotCLICached !== null) return _copilotCLICached;
  const availabilityTimeoutMs = clampAvailabilityTimeoutMs(timeoutMs);
  try {
    const { execSync } = await import("child_process");
    execSync("which copilot", { stdio: "ignore", timeout: availabilityTimeoutMs });
    _copilotCLICached = true;
  } catch {
    if (shouldCacheAvailabilityFailure(availabilityTimeoutMs)) {
      _copilotCLICached = false;
    }
    return false;
  }
  return _copilotCLICached;
}

// ---------------------------------------------------------------------------
// Public API (thin shim -> llm/index.js 위임)
// ---------------------------------------------------------------------------

/**
 * LLM chain에 사용 가능한 provider가 있는지 확인한다.
 *
 * @returns {Promise<boolean>}
 */
export async function isCopilotCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}

// ---------------------------------------------------------------------------
// 출력 파싱 유틸리티
// ---------------------------------------------------------------------------

/**
 * Copilot CLI stdout에서 통계 꼬리 블록을 제거한다.
 * "Changes " 패턴이 시작되는 지점까지만 반환.
 *
 * @param {string} raw - CLI stdout 전체
 * @returns {string}
 */
function stripTrailingStats(raw) {
  const match = raw.match(/\n?\s*Changes\s+[+\-\d]/);
  if (match && match.index !== undefined) {
    return raw.slice(0, match.index);
  }
  return raw;
}

/**
 * Copilot CLI 출력에서 최초 [...] 또는 {...} JSON 블록을 추출한다.
 * ```json 펜스 포함 및 앞뒤 설명 텍스트 혼재 상황 모두 처리.
 * 내부 헬퍼지만 테스트에서 직접 import할 수 있도록 export한다.
 *
 * @param {string} raw - 통계 꼬리 제거 후 CLI 출력
 * @returns {string|null} JSON 후보 문자열 또는 null
 */
export function extractJsonBlock(raw) {
  if (!raw || typeof raw !== "string") return null;

  const text = raw.trim();

  // 1. ```json 또는 ``` 펜스 내부 추출
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const candidate = fenceMatch[1].trim();
    if (candidate.startsWith("{") || candidate.startsWith("[")) {
      return candidate;
    }
  }

  // 2. 첫 { ~ 마지막 } (객체)
  const firstBrace = text.indexOf("{");
  const lastBrace  = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  // 3. 첫 [ ~ 마지막 ] (배열)
  const firstBracket = text.indexOf("[");
  const lastBracket  = text.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return text.slice(firstBracket, lastBracket + 1);
  }

  return null;
}

// ---------------------------------------------------------------------------
// 저수준 CLI 호출 -- CopilotCliProvider 전용
// ---------------------------------------------------------------------------

/**
 * GitHub Copilot CLI를 호출하여 JSON 후보 문자열을 반환한다.
 * stdout에서 통계 꼬리를 제거하고 첫 JSON 블록을 추출하여 반환한다.
 *
 * @param {string}  prompt                         - 전달할 지시 프롬프트
 * @param {object}  [options={}]
 * @param {number}  [options.timeoutMs=180000]     - SIGTERM 타임아웃 (ms)
 * @param {string}  [options.effort="low"]         - reasoning effort (low|medium|high|xhigh)
 * @param {boolean} [options.allowAllTools=true]   - --allow-all-tools 플래그
 * @returns {Promise<string>} JSON 후보 문자열
 * @throws {Error} 타임아웃, 비정상 종료, JSON 블록 미발견 시
 */
export async function runCopilotCLI(prompt, options = {}) {
  const timeoutMs     = options.timeoutMs    ?? 180_000;
  const effort        = options.effort       ?? "low";
  const allowAllTools = options.allowAllTools !== false;

  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "text",
      "--effort", effort
    ];
    if (allowAllTools) args.push("--allow-all-tools");

    const proc = spawn("copilot", args, {
      env  : { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout  = "";
    let stderr  = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        reject(new Error(`Copilot CLI timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0) {
        reject(new Error(`Copilot CLI exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      const cleaned   = stripTrailingStats(stdout);
      const candidate = extractJsonBlock(cleaned);

      if (candidate === null) {
        reject(new Error(`Copilot CLI: no JSON block found in output: ${stdout.slice(0, 200)}`));
        return;
      }

      resolve(candidate);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`Copilot CLI spawn error: ${err.message}`));
      }
    });
  });
}
