/**
 * Google Antigravity CLI client for AnchorMind.
 *
 * The CLI runs in print-only, plan, and sandbox modes because this provider
 * is used only for JSON generation from memory prompts. It must never edit
 * the service working directory or approve tool calls.
 */

import { spawn } from "child_process";
import {
  clampAvailabilityTimeoutMs,
  shouldCacheAvailabilityFailure
} from "./llm/util/availability-timeout.js";

let _agyCLICached = null;

export async function _rawIsAgyCLIAvailable(timeoutMs = null) {
  if (_agyCLICached !== null) return _agyCLICached;

  const availabilityTimeoutMs = clampAvailabilityTimeoutMs(timeoutMs);
  try {
    const { execSync } = await import("child_process");
    execSync("which agy", { stdio: "ignore", timeout: availabilityTimeoutMs });
    _agyCLICached = true;
  } catch {
    if (shouldCacheAvailabilityFailure(availabilityTimeoutMs)) {
      _agyCLICached = false;
    }
    return false;
  }

  return _agyCLICached;
}

export async function isAgyCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}

/**
 * Builds a non-interactive, read-only Antigravity invocation.
 *
 * @param {string} prompt
 * @param {{model?: string}} [options]
 * @returns {string[]}
 */
export function buildAgyArgs(prompt, options = {}) {
  const args = [
    "--print",
    "--output-format", "text",
    "--mode", "plan",
    "--sandbox"
  ];

  if (options.model) args.push("--model", options.model);
  args.push(prompt);
  return args;
}

/**
 * Runs Antigravity CLI in constrained print mode and returns its final text.
 *
 * @param {string} stdinContent
 * @param {string} prompt
 * @param {{timeoutMs?: number, model?: string}} [options]
 * @returns {Promise<string>}
 */
export async function runAgyCLI(stdinContent, prompt, options = {}) {
  const timeoutMs = options.timeoutMs || 120_000;
  const args      = buildAgyArgs(prompt, options);

  return new Promise((resolve, reject) => {
    const proc = spawn("agy", args, {
      env:   { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout  = "";
    let stderr  = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        reject(new Error(`Antigravity CLI timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0) {
        const detail = stderr.trim().slice(0, 1000);
        reject(new Error(`Antigravity CLI exited with code ${code}: ${detail}`));
        return;
      }

      resolve(stdout.trim());
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`Antigravity CLI spawn error: ${err.message}`));
      }
    });

    if (stdinContent) proc.stdin.write(stdinContent, "utf8");
    proc.stdin.end();
  });
}
