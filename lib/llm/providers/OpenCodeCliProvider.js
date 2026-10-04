/**
 * OpenCode CLI Provider (lib/opencode.js wrapper)
 *
 * OpenCode exposes `opencode run [message..]` for non-interactive use.
 * The provider keeps the same JSON-only contract as the other CLI providers.
 */

import { LlmProvider }                                              from "../LlmProvider.js";
import { parseJsonResponse }                                        from "../util/parse-json.js";
import { runOpenCodeCLI, _rawIsOpenCodeCLIAvailable }              from "../runners/opencode.js";

export class OpenCodeCliProvider extends LlmProvider {
  constructor(config = {}) {
    super({ ...config, name: "opencode-cli" });
  }

  /**
   * OpenCode CLI binary availability check.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return _rawIsOpenCodeCLIAvailable();
  }

  /**
   * opencode-cli is JSON-only in this dispatcher.
   *
   * @throws {Error}
   */
  async callText(_prompt, _options = {}) {
    throw new Error("opencode-cli: use callJson (CLI output requires JSON parsing)");
  }

  /**
   * @param {string} prompt
   * @param {object} [options={}]
   * @param {number} [options.timeoutMs=60000]
   * @param {string} [options.model]
   * @param {string} [options.agent]
   * @param {string} [options.variant]
   * @param {string} [options.systemPrompt]
   * @returns {Promise<*>}
   */
  async callJson(prompt, options = {}) {
    if (await this.isCircuitOpen()) {
      throw new Error("opencode-cli: circuit breaker open");
    }

    const finalPrompt = [
      options.systemPrompt,
      "Return one valid JSON value only. Do not wrap it in markdown fences. Do not add commentary before or after the JSON.",
      prompt
    ].filter(Boolean).join("\n\n");

    try {
      const raw    = await runOpenCodeCLI(finalPrompt, {
        timeoutMs: options.timeoutMs ?? this.config.timeoutMs ?? 60_000,
        model    : options.model ?? this.config.model,
        agent    : options.agent ?? this.config.agent,
        variant  : options.variant ?? this.config.variant
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
