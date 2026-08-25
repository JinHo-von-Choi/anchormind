# Final gate fix report

## Scope

This round addresses the final Important/Minor findings for the dedicated local
security pilot. Docker, PostgreSQL startup, model download, external network
access, push, PR, merge, and deployment were not performed.

## Implemented

- Cleanup now keeps the original exit status, promotes a successful run to exit
  1 when a present canonical service fails `pg_isready`, emits an explicit
  `UNRESOLVED` warning, skips unsafe SQL cleanup, and still tears down with
  `down --remove-orphans` without `-v`.
- TAP egress parsing is fail-closed. It requires exactly `1..6`, `# tests 6`,
  `# pass 6`, `# fail 0`, `# cancelled 0`, `# skipped 0`, and exactly one
  `# [security-pilot] external_network_attempts=0` diagnostic. Missing,
  duplicate, nonzero, malformed, plain-marker, or wrong-summary input fails.
- Bridge readback now requires exactly one attached container and requires its
  ID to equal `SERVICE_ID`; foreign and multiple attachments fail.
- Runner and design/plan/report wording now scopes egress evidence to
  Node/application outbound attempts. PostgreSQL container packets are outside
  that tripwire's observation scope; no Docker-level firewall claim is made.
- The design, plan, and report corpus now use the canonical limitation: only
  Node/application non-loopback outbound attempts are observed and must be zero;
  PostgreSQL packet egress is not firewall-observed and is instead bounded by
  one PostgreSQL service/container, the loopback-only published port, and absent
  external provider configuration.
- Added a static documentation regression test that rejects all-network-zero and
  Docker/PostgreSQL firewall claims while requiring the scoped evidence and
  limitation text.
- Strengthened that regression test to scan each document independently and to
  require a canonical zero marker (`Node/application ... 0` or
  `external_network_attempts=0`) plus the PostgreSQL packet limitation in every
  governed egress document; unrelated reports still receive the per-file
  forbidden-claim scan.
- Snapshot selection validates `config.json`, `tokenizer.json`, and q8 ONNX,
  prefers a valid `refs/main` target, and otherwise accepts exactly one stable,
  valid candidate. Ambiguous valid candidates fail closed.

## TDD evidence

The new tests were written first and run against the pre-fix implementation.
The RED run observed:

- cleanup returned `0` when `pg_isready` failed for an existing service;
- the old parser accepted a one-test summary and plain marker;
- bridge/snapshot contracts were absent;
- evidence wording was not scoped.

After the minimal changes, the same focused tests passed.

## Verification

- Focused security unit tests: **23 passed, 0 failed, 0 cancelled, 0 skipped**.
  This includes runner guards, cleanup fixture helpers, and DNS tripwire tests.
- Documentation/runner/cleanup/tripwire focused run: **24 passed, 0 failed,
  0 cancelled, 0 skipped**; the new broad-claim test was RED before wording
  changes and GREEN after them.
- Minor test-only round: the per-document canonical-marker and limitation checks
  pass; no Docker or production runtime was executed.
- Shell cleanup tests: `security-pilot-cleanup shell tests: PASS`, including
  original-zero/original-nonzero `pg_isready` failure cases and no `-v` teardown.
- `npm run lint`: exit 0, **0 errors** (existing warnings remain).
- `bash -n` for runner, cleanup helper, and shell test: passed.
- `node --check` for changed JavaScript tests: passed.
- `git diff --check`: passed.
- Docker/full pilot: intentionally not run per task scope; runtime SQL readback
  and real container packet behavior remain unverified.

## Remaining concern

The egress marker proves only the instrumented Node/application outbound-attempt
boundary. It must not be read as proof that arbitrary PostgreSQL container
packets were captured or that Docker supplies a firewall boundary.
