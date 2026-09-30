/**
 * LLM CLI 자식 프로세스 환경 변수 화이트리스트
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 */

const BASE_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TMPDIR", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"
];
const BASE_PREFIXES = ["LC_", "XDG_"];

const CLI_KEYS = {
  gemini  : ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "GEMINI_MODEL"],
  codex   : ["OPENAI_API_KEY", "CODEX_HOME", "OPENAI_BASE_URL"],
  copilot : ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_HOST"],
  qwen    : ["DASHSCOPE_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"],
  agy     : [],
  opencode: ["OPENCODE_CONFIG"]
};

/**
 * CLI 이름별 허용 목록만 담은 자식 환경을 만든다. 허용 목록은 MEMENTO_LLM_CLI_ENV_PASSTHROUGH(쉼표 구분)로 확장한다.
 *
 * @param {string} cli
 * @param {object} [extra={}]
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Record<string,string>}
 */
export function buildCliEnv(cli, extra = {}, env = process.env) {
  const allow = new Set([
    ...BASE_KEYS,
    ...(CLI_KEYS[cli] || []),
    ...String(env.MEMENTO_LLM_CLI_ENV_PASSTHROUGH || "").split(",").map(s => s.trim()).filter(Boolean)
  ]);
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (allow.has(k) || BASE_PREFIXES.some(p => k.startsWith(p))) out[k] = v;
  }
  return { ...out, ...extra };
}
