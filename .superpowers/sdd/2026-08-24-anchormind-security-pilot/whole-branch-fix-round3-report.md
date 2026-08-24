# Whole-branch security hardening round 3 report

## Scope

- Builds on local commit `f94dd02` from the same security-pilot branch.
- No database, model download, external service, push, PR, merge, or deployment was used.

## Implemented

- Security-pilot startup now requires a non-empty `MEMENTO_ACCESS_KEY`, rejects `MEMENTO_AUTH_DISABLED=true`, and accepts only the resolved bind host `127.0.0.1`. Unset bind host remains valid because the shared resolver defaults to `127.0.0.1`; wildcard, IPv6, loopback aliases, and non-loopback addresses fail closed.
- The pilot contract is snapshot-only: `EMBEDDING_MODEL` must be an absolute path exactly matching the selected snapshot, directly under the canonical model's `snapshots` directory. Validation requires the cache/model/snapshot paths plus `config.json`, `tokenizer.json`, and a q8 ONNX file.
- The checked-in environment template leaves `EMBEDDING_MODEL` empty until the runner selects and exports the validated snapshot. The runner exports the same snapshot to `EMBEDDING_MODEL`, `SECURITY_PILOT_MODEL_SNAPSHOT`, and the integration process, with authentication and loopback bind settings explicit.
- Startup validation remains before HTTP server construction/listener creation, and malicious authentication/bind combinations are rejected before filesystem checks.

## Verification

- RED-first round-3 suite initially failed on missing auth/bind/snapshot-only guards; after implementation: **14 passed, 0 failed** across the round-2 and round-3 contract tests.
- Focused security/related suite: **116 passed, 0 failed, 0 cancelled**.
- Full `npm test`: **2601 total, 2585 passed, 7 failed, 7 cancelled, 2 skipped**. The seven failures/cancellations remain the existing consolidator fixture/mock-export, active-session tracker export, and search query export family; no new focused security failure appeared.
- Syntax, shell, and whitespace checks passed. ESLint reported **0 errors**; warnings are the pre-existing `preserveRedis` unused argument and shell-file ignore warning.

## Boundary

The actual pilot runtime was not started because its local model snapshot and dedicated database are external runtime prerequisites. The validator intentionally rejects direct pilot startup until the runner has selected a complete local snapshot and exported its absolute path.
