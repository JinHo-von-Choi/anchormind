# Whole-branch security hardening round 2 report

## Scope

- Base: `48db144` with the first hardening commit `67f14d0` present.
- No database, model download, external service, push, PR, merge, or deployment was used.

## Implemented

- AutoReflect, session rotation/expiry/shutdown paths, and admin reflect endpoints now return before tracker, LLM, or memory work when `MEMENTO_SECURITY_PILOT_AUTOMATION=off` or `MEMENTO_AUTO_REFLECT=false`.
- Added a pure startup validator. A security-pilot process fails closed unless the transformers provider is local-only, all offline flags and the configured cache/snapshot exist, AutoReflect and LLM chains are disabled, and external model/API URLs or credentials are absent. The server validates before creating a listener or starting schedulers.
- Added one canonical HuggingFace path resolver for hub root, model directory, and snapshot. The runner exports the hub root and snapshot; the embedder uses the same root and snapshot with `allowRemoteModels=false` and `local_files_only=true`.
- Restored non-pilot legacy/master GraphLinker, retro-link, and co-retrieval behavior only for an unscoped request. Any authenticated partial tuple still fails closed; pilot unscoped work is skipped. Consolidator retro-link imports are skipped in the pilot, while non-pilot consolidation remains legacy-compatible.

## Verification

- RED-first round-2 test: `tests/unit/whole-branch-fix-round2.test.js` failed before the new contracts/guards existed, then passed after implementation.
- Focused security/related suite: **94 passed, 0 failed, 0 cancelled**.
- Full `npm test`: **2595 total, 2579 passed, 7 failed, 7 cancelled, 2 skipped**. The failures are the same pre-existing fixture/mock-export family recorded in the first-round report (consolidator stage/workspace fixtures, active-session tracker export, and search query export); the new focused security tests are green.
- Syntax, shell, and whitespace checks passed. ESLint reported **0 errors** and one pre-existing warning at `lib/sessions.js:516` (`preserveRedis` unused).

## Boundary

No real security-pilot runtime was started because its local model snapshot and database are external runtime prerequisites. The validator intentionally rejects a direct pilot startup without an explicitly exported snapshot path.
