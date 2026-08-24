import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RUNNER = path.join(ROOT, "scripts/run-security-pilot.sh");

function run(env) {
  const cleanEnv = { ...process.env };
  for (const name of [
    "COMPOSE_FILE", "SECURITY_PILOT_ENV_FILE", "DATABASE_URL", "POSTGRES_HOST", "POSTGRES_PORT",
    "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "DB_HOST", "DB_PORT", "DB_NAME",
    "DB_USER", "DB_PASSWORD", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD",
    "BATCH_DATABASE_URL", "PGSERVICE", "EMBEDDING_API_KEY", "EMBEDDING_BASE_URL",
    "SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP",
    "OPENAI_API_KEY", "GEMINI_API_KEY", "CF_API_TOKEN", "CLOUDFLARE_API_TOKEN",
    "ANTHROPIC_API_KEY", "XAI_API_KEY", "GOOGLE_API_KEY", "AZURE_OPENAI_API_KEY"
  ]) delete cleanEnv[name];
  return spawnSync("bash", [RUNNER], {
    cwd: ROOT,
    env: { ...cleanEnv, ...env },
    encoding: "utf8"
  });
}

test("security pilot rejects a custom compose selection before any runtime mutation", () => {
  const result = run({ COMPOSE_FILE: "docker-compose.test.yml" });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /existing compose file is selected/);
});

test("security pilot env readback pins every application DB path to the dedicated target", () => {
  const values = Object.fromEntries(
    fs.readFileSync(path.join(ROOT, ".env.security-pilot.example"), "utf8")
      .split("\n")
      .filter(line => line && !line.startsWith("#"))
      .map(line => line.split(/=(.*)/s, 2))
  );
  assert.deepEqual(
    Object.fromEntries(["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"]
      .map(name => [name, values[name]])),
    {
      POSTGRES_HOST: "127.0.0.1", POSTGRES_PORT: "35434", POSTGRES_DB: "memento_security_pilot",
      POSTGRES_USER: "memento_pilot", POSTGRES_PASSWORD: "local_security_pilot_only",
      DB_HOST: "127.0.0.1", DB_PORT: "35434", DB_NAME: "memento_security_pilot",
      DB_USER: "memento_pilot", DB_PASSWORD: "local_security_pilot_only"
    }
  );
});

test("security pilot rejects an inherited hostile POSTGRES target before Docker", () => {
  const result = run({ POSTGRES_HOST: "203.0.113.10" });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /inherited POSTGRES_HOST conflicts/);
  assert.doesNotMatch(result.stderr, /docker compose|psql|migrate/);
});

test("security pilot rejects inherited external credentials before imports", () => {
  const result = run({ OPENAI_API_KEY: "sk-test-only" });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /inherited OPENAI_API_KEY conflicts/);
  assert.doesNotMatch(result.stderr, /docker compose|psql|migrate/);
});

test("security pilot rejects a custom env path before loading any env", () => {
  const result = run({
    SECURITY_PILOT_ENV_FILE: "/tmp/security-pilot-malicious.env"
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /security pilot env file is missing/);
  assert.doesNotMatch(result.stderr, /docker compose|psql|migrate/);
});

test("security pilot rejects an inherited hostile DATABASE_URL before Docker", () => {
  const result = run({ DATABASE_URL: "postgresql://attacker:secret@203.0.113.10:5432/production" });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /inherited DATABASE_URL conflicts/);
  assert.doesNotMatch(result.stderr, /docker compose|psql|migrate/);
});

test("security pilot remains blocked locally without Docker and never attempts a pull", () => {
  const commandPath = fs.mkdtempSync(path.join("/tmp", "security-pilot-no-docker-"));
  for (const [name, target] of [["bash", "/bin/bash"], ["dirname", "/usr/bin/dirname"], ["pwd", "/bin/pwd"], ["basename", "/usr/bin/basename"]]) {
    fs.symlinkSync(target, path.join(commandPath, name));
  }
  try {
    const result = run({ PATH: commandPath });
    assert.equal(result.status, 3);
    assert.match(`${result.stdout}\n${result.stderr}`, /BLOCKED: docker is unavailable/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /docker compose .* up|migrate\.js|psql /);
  } finally {
    fs.rmSync(commandPath, { recursive: true, force: true });
  }
});

test("security pilot cache gate requires the q8 ONNX filenames used by Transformers.js", () => {
  const runner = fs.readFileSync(RUNNER, "utf8");
  assert.match(runner, /onnx\/model_quantized\.onnx/);
  assert.match(runner, /onnx\/model_q8\.onnx/);
  assert.match(runner, /refusing external download/);
});

test("security pilot does not require a host SQL client before the canonical service is healthy", () => {
  const runner = fs.readFileSync(RUNNER, "utf8");
  const healthyIndex = runner.indexOf("docker inspect -f '{{.State.Health.Status}}' \"$SERVICE_ID\"");
  assert.notEqual(healthyIndex, -1, "the canonical service health assertion must exist");
  const preStart = runner.slice(0, healthyIndex);
  assert.doesNotMatch(preStart, /command -v psql|command -v pg_isready/);
});

test("security pilot prefers host SQL clients and falls back only to the healthy canonical service", () => {
  const runner = fs.readFileSync(RUNNER, "utf8");
  const healthyIndex = runner.indexOf("docker inspect -f '{{.State.Health.Status}}' \"$SERVICE_ID\"");
  const clientIndex = runner.indexOf("if command -v psql", healthyIndex);
  assert.ok(clientIndex > healthyIndex, "SQL client selection must happen after health verification");
  assert.match(runner.slice(clientIndex), /if command -v psql[\s\S]*?psql "\$DATABASE_URL"/);
  assert.match(runner.slice(clientIndex), /if command -v pg_isready[\s\S]*?pg_isready/);
  assert.match(
    runner.slice(clientIndex),
    /docker compose "\$\{COMPOSE_ARGS\[@\]\}" exec -T postgres-security-pilot[\s\S]*?psql -U "\$\{SECURITY_PILOT_DB_USER\}" -d "\$\{SECURITY_PILOT_DB_NAME\}"/
  );
  assert.match(
    runner.slice(clientIndex),
    /docker compose "\$\{COMPOSE_ARGS\[@\]\}" exec -T postgres-security-pilot[\s\S]*?pg_isready -U "\$\{SECURITY_PILOT_DB_USER\}" -d "\$\{SECURITY_PILOT_DB_NAME\}"/
  );
  assert.doesNotMatch(runner.slice(clientIndex), /docker exec(?!.*postgres-security-pilot)/);
});

test("security pilot compose uses one explicit named non-internal bridge and exact loopback binding", () => {
  const compose = fs.readFileSync(path.join(ROOT, "docker-compose.security-pilot.yml"), "utf8");
  assert.match(compose, /driver:\s*bridge/);
  assert.match(compose, /name:\s*anchormind_security_pilot_bridge/);
  assert.match(compose, /internal:\s*false/);
  assert.doesNotMatch(compose, /internal:\s*true/);
  const servicesSection = compose.split(/^networks:\s*$/m, 1)[0];
  const networksSection = compose.split(/^networks:\s*$/m)[1].split(/^volumes:\s*$/m, 1)[0];
  assert.equal((servicesSection.match(/^\x20{2}[^\x20\n]+:\s*$/gm) || []).length, 1);
  assert.equal((networksSection.match(/^\x20{2}[^\x20\n]+:\s*$/gm) || []).length, 1);
  assert.match(compose, /-\s*"127\.0\.0\.1:35434:5432"/);
  assert.doesNotMatch(compose, /-\s*"(?:0\.0\.0\.0|\[?::\]?):\d+:\d+"/);
});

test("security pilot runner rejects extra networks and published addresses at runtime", () => {
  const runner = fs.readFileSync(RUNNER, "utf8");
  assert.match(runner, /docker compose "\$\{COMPOSE_ARGS\[@\]\}" config --networks/);
  assert.match(runner, /anchormind_security_pilot_bridge/);
  assert.match(runner, /security_pilot_require "canonical PostgreSQL network must be non-internal" test/);
  assert.match(runner, /security_pilot_require "canonical PostgreSQL port binding is not loopback-only" test/);
  assert.doesNotMatch(runner, /^\s*\[\[.*\.Internal.*$/m);
});

test("security pilot runner accepts one exact TAP egress diagnostic", () => {
  const runner = fs.readFileSync(RUNNER, "utf8");
  const functionMatch = runner.match(/parse_security_pilot_egress_log\(\) \{[\s\S]*?^\}/m);
  assert.ok(functionMatch, "runner must expose the focused egress parser");
  const cases = [
    { name: "plain marker", output: "1..1\nok 1 - pilot\n[security-pilot] external_network_attempts=0\n", expected: 0 },
    { name: "TAP diagnostic marker", output: "1..1\nok 1 - pilot\n# [security-pilot] external_network_attempts=0\n", expected: 0 },
    { name: "nonzero marker", output: "# [security-pilot] external_network_attempts=1\n", expected: 1 },
    { name: "malformed marker", output: "# [security-pilot] external_network_attempts=0 extra\n", expected: 1 },
    { name: "duplicate markers", output: "# [security-pilot] external_network_attempts=0\n[security-pilot] external_network_attempts=0\n", expected: 1 }
  ];

  for (const example of cases) {
    const file = path.join("/tmp", `security-pilot-egress-${process.pid}-${example.name.replaceAll(" ", "-")}.log`);
    fs.writeFileSync(file, example.output);
    const result = spawnSync("bash", ["-c", `${functionMatch[0]}\nparse_security_pilot_egress_log "$1"`, "runner-test", file], {
      encoding: "utf8"
    });
    fs.rmSync(file, { force: true });
    assert.equal(result.status, example.expected, example.name);
  }
});

test("security pilot assertion helper fails closed under Bash 3.2 semantics", () => {
  const runner = fs.readFileSync(RUNNER, "utf8");
  const helper = runner.match(/security_pilot_require\(\) \{[\s\S]*?^\}/m);
  assert.ok(helper, "runner must define the fail-closed assertion helper");
  const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${helper[0]}\nsecurity_pilot_require "false gate" test actual = expected`], {
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /false gate/);
});

test("security pilot runner has no standalone bare assertions", () => {
  const runner = fs.readFileSync(RUNNER, "utf8");
  assert.doesNotMatch(runner, /^\s*\[\[/m);
});

test("security pilot runner defers synthetic cleanup to preserve authoritative readback", () => {
  const runner = fs.readFileSync(RUNNER, "utf8");
  const integration = fs.readFileSync(path.join(ROOT, "tests/integration/security-pilot.test.js"), "utf8");
  assert.match(runner, /SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP=true/);
  assert.match(runner, /security-pilot-synthetic/);
  assert.match(runner, /00000000-0000-0000-0000-00000000aaaa/);
  assert.match(runner, /00000000-0000-0000-0000-00000000bbbb/);
  assert.match(runner, /fixture_pairs/);
  assert.match(integration, /shouldDeferSyntheticCleanup\(\)/);
  assert.match(integration, /pool\.end\(\)/);
  assert.match(integration, /tripwire\?\.restore\(\)/);
});
