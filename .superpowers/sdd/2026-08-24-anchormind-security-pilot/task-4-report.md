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

## Fix round 1 verification

- Canonical env/compose path and exact `DATABASE_URL` validation now fail before Docker, psql, migration, or compose mutation.
- Docker compose startup uses `--pull never`; the runner requires exactly one service, checks loopback-only port publication, and blocks when no `lsof`, `ss`, or `netstat` listener inspector is available.
- The model gate selects a real `snapshots/*` directory containing both `config.json` and `tokenizer.json`. The integration test configures Transformers.js `cacheDir`, `localModelPath`, `allowLocalModels=true`, and `allowRemoteModels=false` before loading the model.
- Synthetic fixture rows receive actual 384-dimensional local-transformers embeddings and the test exercises PostgreSQL vector recall; the runner migrates the embedding column and asserts `vector(384)`.
- DNS callback and promise tripwires were added; teardown closes both the explicit pilot pool and the shared application pool.
- `tests/unit/security-pilot-runner-guards.test.js`: 3 passed, 0 failed, 0 cancelled, 0 skipped.
- `bash -n scripts/run-security-pilot.sh`, Node syntax checks, and `git diff --check`: passed.
- `bash scripts/run-security-pilot.sh`: `BLOCKED: docker is unavailable; refusing external pull`, exit 3; no Docker pull, model download, migration, or database mutation.

## Fix round 2 verification

- `.env.security-pilot.example` now pins `DATABASE_URL`, `POSTGRES_*`, `DB_*`, and blank `BATCH_DATABASE_URL` to the same dedicated database. The runner exports and validates all of them before compose, migration, post-migration, shared Pool, or psql use.
- Conflicting inherited `DATABASE_URL`, `POSTGRES_*`, `DB_*`, `PG*`, compose, and external credential variables are rejected before any import or runtime mutation. OpenAI, Gemini, Cloudflare, Anthropic, XAI, Google, Azure, embedding API keys, and embedding base URL are required to be empty.
- Transformers cache selection now requires a snapshot with `config.json`, `tokenizer.json`, and an actual q8 ONNX file (`onnx/model_quantized.onnx` or `onnx/model_q8.onnx`).
- DNS callback and promise wrappers cover lookup, resolve, resolve4/6, resolveAny, resolveCaa/Cname, resolveMx/Naptr/Ns/Ptr/Soa/Srv/Txt, and reverse.
- `tests/unit/security-pilot-runner-guards.test.js`: 8 passed, 0 failed, 0 cancelled, 0 skipped.
- Syntax and diff checks passed; runner remains `BLOCKED`/exit 3 because Docker is unavailable.

## Status

`BLOCKED` by missing local Docker runtime/image and transformers cache. Real PostgreSQL SQL readback, migration, and integration pass remain unverified until those prerequisites are intentionally made available locally. The dedicated volume is never removed by the runner (`down --remove-orphans` only).
