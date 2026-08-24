/** Shared fail-closed policy for the synthetic security pilot. */

import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveBindHost } from "./http/bind.js";

export function isSecurityPilotAutomationOff(value = process.env.MEMENTO_SECURITY_PILOT_AUTOMATION) {
  return String(value ?? "").trim().toLowerCase() === "off";
}

export function isOfflineModelMode(env = process.env) {
  return isSecurityPilotAutomationOff(env.MEMENTO_SECURITY_PILOT_AUTOMATION)
    || env.HF_HUB_OFFLINE === "1"
    || env.HF_HUB_OFFLINE === "true"
    || env.TRANSFORMERS_OFFLINE === "1"
    || env.TRANSFORMERS_OFFLINE === "true";
}

export function isAutoReflectDisabled(env = process.env) {
  return isSecurityPilotAutomationOff(env.MEMENTO_SECURITY_PILOT_AUTOMATION)
    || String(env.MEMENTO_AUTO_REFLECT ?? "").trim().toLowerCase() === "false";
}

function modelDirName(modelId) {
  return `models--${String(modelId).replaceAll("/", "--")}`;
}

/**
 * Resolve the three distinct HuggingFace filesystem levels:
 * hub root, model directory, and immutable snapshot directory.
 */
export function resolveSecurityPilotModelPaths(env = process.env) {
  const modelId = env.SECURITY_PILOT_MODEL_ID || "Xenova/multilingual-e5-small";
  const explicitSnapshot = env.SECURITY_PILOT_MODEL_SNAPSHOT || "";
  const cacheInput = env.SECURITY_PILOT_MODEL_CACHE || env.TRANSFORMERS_CACHE || "";
  let cacheRoot = cacheInput;

  if (basename(cacheRoot) === modelDirName(modelId)) cacheRoot = dirname(cacheRoot);
  if (basename(cacheRoot) === "snapshots") cacheRoot = dirname(dirname(cacheRoot));
  if (basename(dirname(cacheRoot)) === "snapshots") cacheRoot = dirname(dirname(dirname(cacheRoot)));
  if (!cacheRoot && explicitSnapshot) {
    cacheRoot = dirname(dirname(dirname(explicitSnapshot)));
  }
  if (!cacheRoot) {
    cacheRoot = env.HF_HOME
      ? join(env.HF_HOME, "hub")
      : join(env.HOME || process.env.HOME || ".", ".cache", "huggingface", "hub");
  }

  cacheRoot = resolve(cacheRoot);
  const modelDir = join(cacheRoot, modelDirName(modelId));
  const snapshot = explicitSnapshot ? resolve(explicitSnapshot) : join(modelDir, "snapshots");
  return { modelId, cacheRoot, modelDir, snapshot };
}

function isTrue(value) {
  return value === "1" || String(value ?? "").toLowerCase() === "true";
}

/** Validate the pilot contract without importing a server or touching runtime state. */
export function validateSecurityPilotStartup(env = process.env, { exists = existsSync } = {}) {
  if (!isSecurityPilotAutomationOff(env.MEMENTO_SECURITY_PILOT_AUTOMATION)) {
    return { ok: true, pilot: false };
  }

  const fail = reason => ({ ok: false, pilot: true, reason });
  if (!String(env.MEMENTO_ACCESS_KEY ?? "").trim()) {
    return fail("access key (MEMENTO_ACCESS_KEY) is required for the security pilot");
  }
  if (String(env.MEMENTO_AUTH_DISABLED ?? "").trim().toLowerCase() === "true") {
    return fail("MEMENTO_AUTH_DISABLED=true is forbidden for the security pilot");
  }
  if (resolveBindHost(env) !== "127.0.0.1") {
    return fail("security pilot bind host must resolve exactly to 127.0.0.1");
  }
  if (env.EMBEDDING_PROVIDER !== "transformers") return fail("embedding provider must be transformers");
  if (env.EMBEDDING_API_KEY || env.EMBEDDING_BASE_URL) return fail("embedding API/base URL must be empty");
  if (env.EMBEDDING_DIMENSIONS !== "384") return fail("embedding dimensions must be 384");
  if (!isTrue(env.HF_HUB_OFFLINE) || !isTrue(env.TRANSFORMERS_OFFLINE) || !isTrue(env.HF_DATASETS_OFFLINE)) {
    return fail("HF_HUB_OFFLINE, TRANSFORMERS_OFFLINE, and HF_DATASETS_OFFLINE are required");
  }
  if (isAutoReflectDisabled(env) !== true) return fail("MEMENTO_AUTO_REFLECT=false is required");
  const paths = resolveSecurityPilotModelPaths(env);
  if (!env.EMBEDDING_MODEL || !isAbsolute(env.EMBEDDING_MODEL)) {
    return fail("embedding model must be an absolute local snapshot");
  }
  if (resolve(env.EMBEDDING_MODEL) !== paths.snapshot) {
    return fail("embedding model must exactly match the resolved local snapshot");
  }
  if (!env.SECURITY_PILOT_MODEL_CACHE || !env.SECURITY_PILOT_MODEL_SNAPSHOT) {
    return fail("security pilot cache root and snapshot are required");
  }
  const snapshotParent = resolve(paths.modelDir, "snapshots");
  const snapshotRelative = relative(snapshotParent, paths.snapshot);
  if (!snapshotRelative || snapshotRelative === ".." || snapshotRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || isAbsolute(snapshotRelative) || snapshotRelative.includes(process.platform === "win32" ? "\\" : "/")) {
    return fail("security pilot snapshot must be a direct child of the canonical local model cache");
  }
  const requiredFiles = [
    join(paths.snapshot, "config.json"),
    join(paths.snapshot, "tokenizer.json")
  ];
  const q8Files = [
    join(paths.snapshot, "onnx/model_quantized.onnx"),
    join(paths.snapshot, "onnx/model_q8.onnx")
  ];
  if (!exists(paths.cacheRoot) || !exists(paths.modelDir) || !exists(paths.snapshot)
      || requiredFiles.some(file => !exists(file)) || !q8Files.some(file => exists(file))) {
    return fail("security pilot snapshot must contain config.json, tokenizer.json, and a q8 ONNX file");
  }

  const forbidden = ["RERANKER_URL", "NLI_SERVICE_URL", "HF_ENDPOINT", "HUGGINGFACE_HUB_BASE_URL",
    "OPENAI_BASE_URL", "GEMINI_BASE_URL", "ANTHROPIC_BASE_URL", "XAI_BASE_URL",
    "AZURE_OPENAI_ENDPOINT", "LLM_BASE_URL", "MEMENTO_LLM_BASE_URL"];
  if (forbidden.some(name => env[name])) return fail("external model/API URL is configured");
  if ((env.LLM_PRIMARY || "gemini-cli") !== "none" || (env.LLM_FALLBACKS || "[]") !== "[]") {
    return fail("external LLM chain must be disabled");
  }
  if ((env.MEMENTO_SPLIT_LLM_PRIMARY || "none") !== "none"
      || (env.MEMENTO_SPLIT_LLM_FALLBACKS || "[]") !== "[]") {
    return fail("split LLM chain must be disabled");
  }
  for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "CF_API_TOKEN", "CLOUDFLARE_API_TOKEN",
    "ANTHROPIC_API_KEY", "XAI_API_KEY", "GOOGLE_API_KEY", "AZURE_OPENAI_API_KEY"]) {
    if (env[name]) return fail(`external credential ${name} is configured`);
  }
  return { ok: true, pilot: true, paths };
}
