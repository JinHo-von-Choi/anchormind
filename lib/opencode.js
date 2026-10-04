/** OpenCode CLI compatibility entrypoint. */

export {
  _getOpenCodeRunFlagSupport,
  _rawIsOpenCodeCLIAvailable,
  runOpenCodeCLI
} from "./llm/runners/opencode.js";

export async function isOpenCodeCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}
