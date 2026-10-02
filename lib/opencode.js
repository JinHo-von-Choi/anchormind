/**
 * OpenCode CLI Client (memento-mcp)
 *
 * public API:
 *   _rawIsOpenCodeCLIAvailable() -- checks for the local `opencode` binary
 *   isOpenCodeCLIAvailable()     -- delegates to the full LLM chain
 *   runOpenCodeCLI()             -- low-level CLI call for OpenCodeCliProvider
 */

import { execFile, spawn } from "child_process";
import { buildCliEnv } from "./llm/util/cli-env.js";
import { cliToolApprovalMode, cliWorkDir } from "./llm/util/cli-approval.js";

let _openCodeCLICached = null;
let _openCodeRunFlagsCached = null;

/**
 * Check whether the OpenCode CLI binary is installed.
 *
 * @returns {Promise<boolean>}
 */
export async function _rawIsOpenCodeCLIAvailable() {
  if (_openCodeCLICached !== null) return _openCodeCLICached;
  try {
    const { execSync } = await import("child_process");
    execSync("which opencode", { stdio: "ignore", timeout: 5000 });
    _openCodeCLICached = true;
  } catch {
    _openCodeCLICached = false;
  }
  return _openCodeCLICached;
}

/**
 * Check whether any LLM provider in the configured chain is available.
 *
 * @returns {Promise<boolean>}
 */
export async function isOpenCodeCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}

/**
 * Run OpenCode in non-interactive mode and return stdout.
 *
 * @param {string} prompt
 * @param {object} [options={}]
 * @param {number} [options.timeoutMs=60000]
 * @param {string} [options.model]   - provider/model value passed to `--model`
 * @param {string} [options.agent]   - optional OpenCode agent
 * @param {string} [options.variant] - optional model variant
 * @param {string} [options.cwd]     - working directory for OpenCode context
 *                                     (default: server directory when the approval mode is "all", otherwise an empty temp directory)
 * @returns {Promise<string>}
 */
export async function runOpenCodeCLI(prompt, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const approval  = cliToolApprovalMode();
  const cwd       = options.cwd ?? (approval === "all" ? process.cwd() : cliWorkDir());
  const flags     = await _getOpenCodeRunFlagSupport();

  return new Promise((resolve, reject) => {
    const args = [
      "run",
      "--format", "default"
    ];

    if (flags.dir) args.push("--dir", cwd);
    if (flags.pure) args.push("--pure");
    if (options.model) args.push("--model", options.model);
    if (options.agent) {
      assertOpenCodeFlagSupported(flags.agent, "--agent");
      args.push("--agent", options.agent);
    }
    if (options.variant && flags.variant) {
      args.push("--variant", options.variant);
    }
    args.push(prompt);

    const proc = spawn("opencode", args, {
      env  : buildCliEnv("opencode", approval === "all"
        ? { NO_COLOR: "1" }
        : { NO_COLOR: "1", OPENCODE_PERMISSION: JSON.stringify({ "*": "deny" }) }),
      cwd  : flags.dir ? undefined : cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout  = "";
    let stderr  = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        reject(new Error(`OpenCode CLI timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(0, 1000);
        reject(new Error(`OpenCode CLI exited with code ${code}: ${detail}`));
        return;
      }

      resolve(stdout.trim());
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`OpenCode CLI spawn error: ${err.message}`));
      }
    });
  });
}

export async function _getOpenCodeRunFlagSupport() {
  if (_openCodeRunFlagsCached !== null) return _openCodeRunFlagsCached;

  try {
    const help = await execFileOutput("opencode", ["run", "--help"], 5_000);
    _openCodeRunFlagsCached = {
      agent  : help.includes("--agent"),
      dir    : help.includes("--dir"),
      pure   : help.includes("--pure"),
      variant: help.includes("--variant")
    };
  } catch {
    _openCodeRunFlagsCached = {
      agent  : false,
      dir    : false,
      pure   : false,
      variant: false
    };
  }

  return _openCodeRunFlagsCached;
}

function assertOpenCodeFlagSupported(supported, flag) {
  if (!supported) {
    throw new Error(`OpenCode CLI does not support ${flag}; upgrade opencode or remove the matching provider option`);
  }
}

function execFileOutput(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(`${stdout}\n${stderr}`);
    });
  });
}
