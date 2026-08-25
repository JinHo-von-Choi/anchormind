# TAP egress parser fix report

## Root cause

The security-pilot integration test emits the zero Node/application non-loopback outbound-attempt count as a TAP diagnostic line (`# [security-pilot] external_network_attempts=0`). This marker covers only the instrumented Node/application boundary; PostgreSQL container packets are not observed by this tripwire. The runner required the unprefixed line with `grep -Fxq`, so a passing 6/6 integration run was rejected.

## Change

- Added `parse_security_pilot_egress_log` to `scripts/run-security-pilot.sh`.
- The parser accepts exactly one valid TAP diagnostic marker with exactly one `# ` prefix.
- It rejects nonzero, malformed, missing, duplicate, and ambiguous marker lines.
- The existing `set -euo pipefail` and `node ... | tee ...` pipeline remain unchanged, so a nonzero integration-test exit still stops the runner before parsing.

## Verification

- `node --test --test-name-pattern='exact TAP egress' tests/unit/security-pilot-runner-guards.test.js` — 1 passed.
- `bash -n scripts/run-security-pilot.sh` — passed.
- `git diff --check` — passed.
- Docker/full security pilot was not run by design.

## Deterministic guard-test follow-up

The local-without-Docker guard now runs the runner with an isolated temporary `PATH` containing only the required shell utilities and no `docker` entry. This keeps the test at the runner's `command -v docker` gate regardless of whether Docker is installed on the host; the shim is removed in a `finally` block and no Docker command is invoked.

- `node --test tests/unit/security-pilot-runner-guards.test.js` — 13 passed.
- `bash -n scripts/run-security-pilot.sh` — passed.
- `git diff --check` — passed.
