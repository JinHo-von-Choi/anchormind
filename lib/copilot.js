/** GitHub Copilot CLI compatibility entrypoint. */

export {
  _rawIsCopilotCLIAvailable,
  extractJsonBlock,
  runCopilotCLI
} from "./llm/runners/copilot.js";

export async function isCopilotCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}
