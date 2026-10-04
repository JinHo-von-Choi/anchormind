/** Codex CLI compatibility entrypoint. */

export { _rawIsCodexCLIAvailable, runCodexCLI } from "./llm/runners/codex.js";

export async function isCodexCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}
