# Task 4 report — dedicated PostgreSQL+pgvector security pilot

## Scope

- Base: `35dd6b012ff603ce6517beaf14a6014e3857037e`
- Synthetic fixture only: `tests/fixtures/security-pilot.ndjson`
- Dedicated runtime contract: `127.0.0.1:35434`, database `memento_security_pilot`, volume `anchormind_security_pilot_pgdata`
- External writes, push, PR, merge, deployment, real data, and model downloads: not used

## TDD and precondition evidence

The integration test was run before the dedicated compose runner existed:

```text
DOTENV_CONFIG_PATH=.env.test MEMENTO_METRICS_DEFAULT=off REDIS_ENABLED=false CACHE_ENABLED=false \
MEMENTO_SECURITY_PILOT_AUTOMATION=off \
node --test --test-concurrency=1 tests/integration/security-pilot.test.js
```

Result: expected precondition failure, `ECONNREFUSED 127.0.0.1:35434`; no test was skipped or cancelled and the tripwire reported `external_network_attempts=0`.

## Static verification

- `node --check tests/integration/security-pilot.test.js`: passed
- `bash -n scripts/run-security-pilot.sh`: passed
- NDJSON UUID/row-count validation: passed (2 API-key rows, 3 fragment rows)
- `git diff --check`: passed
- Compose contract is isolated to `pgvector/pgvector:pg15`, `127.0.0.1:35434`, internal network, and named volume `anchormind_security_pilot_pgdata`.

## Dedicated pilot gate

```text
bash scripts/run-security-pilot.sh
BLOCKED: docker is unavailable; refusing external pull
exit 3
```

Read-only preflight also found no local `pgvector/pgvector:pg15` image and no local `config.json`/`tokenizer.json` under `$HOME/.cache/huggingface/hub/models--Xenova--multilingual-e5-small`. The runner therefore fails closed before compose startup, migration, database mutation, or model access. No external pull/download was attempted.

## Status

`BLOCKED` by missing local Docker runtime/image and transformers cache. Real PostgreSQL SQL readback, migration, and integration pass remain unverified until those prerequisites are intentionally made available locally. The dedicated volume is never removed by the runner (`down --remove-orphans` only).
