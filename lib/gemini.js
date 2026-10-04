/** Gemini CLI compatibility entrypoint. */

export { _rawIsGeminiCLIAvailable, runGeminiCLI } from "./llm/runners/gemini.js";

export async function isGeminiCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}

export async function geminiCLIJson(prompt, options = {}) {
  const { llmJson } = await import("./llm/index.js");
  return llmJson(prompt, options);
}
