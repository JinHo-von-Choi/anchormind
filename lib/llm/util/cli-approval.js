/**
 * LLM CLI 공급자의 도구 승인 방식과 자식 프로세스 작업 디렉터리
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import fs   from "node:fs";
import os   from "node:os";
import path from "node:path";

import { envEnum } from "../../config.js";

const WORK_DIR_PREFIX = "memento-llm-cli-";

let _workDir = null;

/**
 * CLI 공급자의 도구 실행 승인 방식. 호출 시점의 MEMENTO_LLM_CLI_TOOL_APPROVAL을 읽는다.
 * none(기본): 세 CLI 모두 빈 임시 디렉터리에서 실행한다.
 *   gemini는 -y를 붙이지 않고 임시 디렉터리를 신뢰 작업 공간으로 지정한다(GEMINI_CLI_TRUST_WORKSPACE).
 *   copilot은 비대화형 실행용 --allow-all-tools를 유지하고 쓰기, 셸, URL 도구와 내장 MCP를 거부한다.
 *   opencode는 모든 권한을 거부하는 OPENCODE_PERMISSION을 넘긴다.
 * all: 서버 작업 디렉터리에서 실행한다. gemini는 -y, copilot은 --allow-all-tools를 쓰고,
 *   opencode는 승인 관련 설정을 추가하지 않는다.
 * gemini-cli, copilot-cli, opencode-cli를 쓰는 배포는 기본에서 제한된 호출을 받으며,
 * all로 설정하면 승인 제한 없는 호출이 된다.
 *
 * @returns {"none"|"all"}
 */
export function cliToolApprovalMode() {
  return envEnum("MEMENTO_LLM_CLI_TOOL_APPROVAL", ["none", "all"], "none");
}

/**
 * CLI 자식 프로세스의 작업 디렉터리. 프로세스당 한 번 만드는 빈 임시 디렉터리다.
 * 서버 작업 디렉터리(.env, 소스)를 CLI의 파일 도구 범위에서 뺀다.
 *
 * @returns {string}
 */
export function cliWorkDir() {
  if (_workDir && fs.existsSync(_workDir)) return _workDir;
  _workDir = fs.mkdtempSync(path.join(os.tmpdir(), WORK_DIR_PREFIX));
  return _workDir;
}

/**
 * 작업 디렉터리를 지운다. 종료 처리에서 호출되므로 실패해도 예외를 던지지 않는다.
 */
export function cleanupCliWorkDir() {
  if (!_workDir) return;
  try {
    fs.rmSync(_workDir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`[LLM] CLI work dir cleanup failed: ${String(err?.code || err?.message || err)}\n`);
  }
  _workDir = null;
}

process.once("exit", cleanupCliWorkDir);
