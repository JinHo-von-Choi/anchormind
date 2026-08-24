import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { resolveAuthStatus, resolveBindHost } from "../../lib/http/bind.js";
import { createHttpServer } from "../../lib/http-server.js";

const projectRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * 인증 모듈은 환경변수를 import 시점에 읽으므로, 각 케이스를 별도 Node
 * 프로세스에서 실행한다. 이 헬퍼는 외부 서비스에 연결하지 않는다.
 */
export async function runAuthChild({
  MEMENTO_ACCESS_KEY,
  MEMENTO_AUTH_DISABLED,
  request,
  message,
}) {
  const childEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: ".env.test",
    MEMENTO_METRICS_DEFAULT: "off",
    REDIS_ENABLED: "false",
    CACHE_ENABLED: "false",
    MEMENTO_ACCESS_KEY,
  };

  if (MEMENTO_AUTH_DISABLED === undefined) {
    delete childEnv.MEMENTO_AUTH_DISABLED;
  } else {
    childEnv.MEMENTO_AUTH_DISABLED = MEMENTO_AUTH_DISABLED;
  }

  for (const name of ["DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "REDIS_HOST"]) {
    delete childEnv[name];
  }

  const script = `
    const { validateAuthentication } = await import(${JSON.stringify(`${projectRoot}/lib/auth.js`)});
    const result = await validateAuthentication(${JSON.stringify(request)}, ${JSON.stringify(message)});
    process.stdout.write(JSON.stringify({ valid: result.valid, error: result.error ?? null, keyId: result.keyId ?? null }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: childEnv,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(child.status, 0, child.stderr || "authentication child process failed");
  const serialized = child.stdout.trim().split("\n").pop();
  return JSON.parse(serialized);
}

function listenOnEphemeralPort(server, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (host === undefined) server.listen(0, resolve);
    else server.listen(0, host, resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("runtime authentication rejects an empty ACCESS_KEY without explicit AUTH_DISABLED", async () => {
  const result = await runAuthChild({
    MEMENTO_ACCESS_KEY: "",
    MEMENTO_AUTH_DISABLED: undefined,
    request: { headers: {}, socket: { encrypted: false } },
    message: { method: "tools/call" },
  });
  assert.equal(result.valid, false);
  assert.equal(result.error, "access_key_required");
});

test("AUTH_DISABLED is an explicit opt-in only", async () => {
  const result = await runAuthChild({
    MEMENTO_ACCESS_KEY: "",
    MEMENTO_AUTH_DISABLED: "true",
    request: { headers: {}, socket: { encrypted: false } },
    message: { method: "tools/call" },
  });
  assert.equal(result.valid, true);
  assert.equal(result.keyId, null);
});

test("default listener address is IPv4 loopback", async () => {
  const host = resolveBindHost({});
  const server = createHttpServer({
    requestHandler: (_req, res) => res.end("ok"),
    host,
  });
  await listenOnEphemeralPort(server, host);
  try {
    assert.equal(server.address().address, "127.0.0.1");
  } finally {
    await closeServer(server);
  }
});

test("HTTP server factory applies its host interface", async () => {
  const server = createHttpServer({
    requestHandler: (_req, res) => res.end("ok"),
    host: "127.0.0.1",
  });
  await listenOnEphemeralPort(server);
  try {
    assert.equal(server.address().address, "127.0.0.1");
  } finally {
    await closeServer(server);
  }
});

test("startup auth status reports fail-closed when the key is empty", () => {
  assert.match(resolveAuthStatus("", false), /REQUIRED|FAIL-CLOSED/i);
  assert.doesNotMatch(resolveAuthStatus("", false), /DISABLED/i);
  assert.match(resolveAuthStatus("", true), /DISABLED/i);
});
