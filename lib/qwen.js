/** Qwen CLI compatibility entrypoint. */

export { _rawIsQwenCLIAvailable, runQwenCLI } from "./llm/runners/qwen.js";

export async function isQwenCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}

export async function qwenCLIJson(prompt, options = {}) {
  const { llmJson } = await import("./llm/index.js");
  return llmJson(prompt, options);
}
