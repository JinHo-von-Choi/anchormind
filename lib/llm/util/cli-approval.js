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
 * none(기본): 도구 전체 자동 승인 인자를 쓰지 않고, 쓰기, 셸, 네트워크 도구를 거부하며 빈 임시 디렉터리에서 실행한다.
 * all: 각 CLI의 전체 자동 승인 인자를 붙이고 서버 작업 디렉터리에서 실행한다.
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

process.once("exit", () => {
  if (_workDir) fs.rmSync(_workDir, { recursive: true, force: true });
});
