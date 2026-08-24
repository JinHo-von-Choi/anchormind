import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RUNNER = path.join(ROOT, "scripts/run-security-pilot.sh");

function run(env) {
  return spawnSync("bash", [RUNNER], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
}

test("security pilot rejects a custom compose selection before any runtime mutation", () => {
  const result = run({ COMPOSE_FILE: "docker-compose.test.yml" });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /existing compose file is selected/);
});

test("security pilot rejects a custom env path before reading a malicious DATABASE_URL", () => {
  const result = run({
    SECURITY_PILOT_ENV_FILE: "/tmp/security-pilot-malicious.env",
    DATABASE_URL: "postgresql://attacker:secret@203.0.113.10:5432/production"
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /security pilot env file is missing/);
  assert.doesNotMatch(result.stderr, /docker compose|psql|migrate/);
});

test("security pilot remains blocked locally without Docker and never attempts a pull", () => {
  const result = run({});
  assert.equal(result.status, 3);
  assert.match(`${result.stdout}\n${result.stderr}`, /BLOCKED:/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /docker compose .* up|migrate\.js|psql /);
});
