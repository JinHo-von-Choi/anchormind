/**
 * Antigravity CLI compatibility entrypoint.
 * Raw process execution lives under lib/llm/runners so providers do not depend
 * on this chain-level shim.
 */

export { _rawIsAgyCLIAvailable, buildAgyArgs, runAgyCLI } from "./llm/runners/agy.js";

export async function isAgyCLIAvailable() {
  const { isLlmAvailable } = await import("./llm/index.js");
  return isLlmAvailable();
}
