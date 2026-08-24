export function resolveBindHost(env = process.env) {
  const configured = String(env.MEMENTO_BIND_HOST || "").trim();
  return configured || "127.0.0.1";
}

export function resolveAuthStatus(accessKey, authDisabled) {
  if (accessKey) return "ENABLED";
  if (authDisabled) return "DISABLED (explicit opt-in)";
  return "REQUIRED (set MEMENTO_ACCESS_KEY to enable)";
}
