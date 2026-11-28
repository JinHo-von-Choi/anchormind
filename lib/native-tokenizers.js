import { createRequire } from "node:module";
import prometheus from "prom-client";
import { logWarn } from "./logger.js";
import { register } from "./metrics.js";

const require = createRequire(import.meta.url);
let addon;

const nativeActive = new prometheus.Gauge({
  name: "memento_tokenizer_native_active",
  help: "Whether the native implementation is active for the tokenizer",
  labelNames: ["tokenizer"],
  registers: [register]
});
for (const tokenizer of ["cl100k", "garu"]) nativeActive.set({ tokenizer }, 0);

const fallbacks = new prometheus.Counter({
  name: "memento_tokenizer_fallback_total",
  help: "Fallbacks from the native tokenizer",
  labelNames: ["tokenizer", "reason"],
  registers: [register]
});

function loadAddon() {
  try {
    return { binding: require("../native/tokenizers.node") };
  } catch (error) {
    return { reason: error.code === "MODULE_NOT_FOUND" ? "missing" : "load" };
  }
}

/** 네이티브 경로를 한 번 선택한다. 초기화나 확인 벡터가 실패하면 기존 경로를 사용한다. */
export function selectNativeTokenizer(tokenizer, initialize) {
  addon ??= loadAddon();
  if (!addon.binding) return unavailable(tokenizer, addon.reason);
  let run;
  try {
    run = initialize(addon.binding);
  } catch {
    return unavailable(tokenizer, "initialize");
  }
  if (!run) return unavailable(tokenizer, "mismatch");
  nativeActive.set({ tokenizer }, 1);
  return run;
}

function unavailable(tokenizer, reason) {
  fallbacks.inc({ tokenizer, reason });
  logWarn("[NativeTokenizers] Using the bundled tokenizer", { tokenizer, reason });
  return null;
}

/** 요청 하나가 실패하면 호출부가 기존 경로에서 같은 입력을 처리한다. */
export function runNativeTokenizer(tokenizer, run, input) {
  try {
    return run(input);
  } catch {
    fallbacks.inc({ tokenizer, reason: "call" });
    return undefined;
  }
}
