export function resolveBindHost(env = process.env) {
  const configured = String(env.MEMENTO_BIND_HOST || "").trim();
  return configured || "127.0.0.1";
}
