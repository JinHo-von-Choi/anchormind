# TAP egress parser fix report

## Root cause

The security-pilot integration test emits the zero-egress count as a TAP diagnostic line (`# [security-pilot] external_network_attempts=0`). The runner required the unprefixed line with `grep -Fxq`, so a passing 6/6 integration run was rejected.

## Change

- Added `parse_security_pilot_egress_log` to `scripts/run-security-pilot.sh`.
- The parser accepts exactly one marker, in either the plain form or with exactly one TAP `# ` prefix.
- It rejects nonzero, malformed, missing, duplicate, and ambiguous marker lines.
- The existing `set -euo pipefail` and `node ... | tee ...` pipeline remain unchanged, so a nonzero integration-test exit still stops the runner before parsing.

## Verification

- `node --test --test-name-pattern='exact TAP egress' tests/unit/security-pilot-runner-guards.test.js` — 1 passed.
- `bash -n scripts/run-security-pilot.sh` — passed.
- `git diff --check` — passed.
- Docker/full security pilot was not run by design.
