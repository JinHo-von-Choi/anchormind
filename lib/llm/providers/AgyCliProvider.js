/**
 * Google Antigravity CLI provider.
 *
 * Antigravity is constrained to print-only plan mode with its sandbox enabled
 * because AnchorMind uses it only for structured LLM transformations.
 */

import { LlmProvider }                                  from "../LlmProvider.js";
import { parseJsonResponse }                             from "../util/parse-json.js";
import { runAgyCLI, _rawIsAgyCLIAvailable }             from "../../agy.js";

export class AgyCliProvider extends LlmProvider {
  constructor(config = {}) {
    super({ ...config, name: "agy-cli" });
  }

  async isAvailable(timeoutMs = null) {
    return _rawIsAgyCLIAvailable(timeoutMs);
  }

  async callText(_prompt, _options = {}) {
    throw new Error("agy-cli: use callJson (CLI returns parsed JSON)");
  }

  async callJson(prompt, options = {}) {
    if (await this.isCircuitOpen()) {
      throw new Error("agy-cli: circuit breaker open");
    }

    const finalPrompt = [
      options.systemPrompt,
      "Return one valid JSON value only. Do not wrap it in markdown fences. Do not add commentary before or after the JSON.",
      prompt
    ].filter(Boolean).join("\n\n");

    try {
      const raw = await runAgyCLI("", finalPrompt, {
        timeoutMs: options.timeoutMs ?? this.config.timeoutMs ?? 120_000,
        model    : options.model ?? this.config.model
      });
      const result = parseJsonResponse(raw);
      await this.recordSuccess();
      return result;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }
}
