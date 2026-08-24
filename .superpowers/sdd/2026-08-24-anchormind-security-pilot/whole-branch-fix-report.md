# Whole-branch security hardening fix report

## Scope

- Base: `48db144`
- Changes are limited to fail-closed background graph automation, health/metrics authentication, exact topic/working-memory scope propagation, and offline local-model loading.
- No real data, external network service, deployment, push, PR, or merge was used.

## Implemented

- `MEMENTO_SECURITY_PILOT_AUTOMATION=off` now returns before scheduler startup and skips server reranker/tokenizer automation.
- Scheduler `embedding_ready` no longer calls `GraphLinker` without an authoritative exact `(key_id, workspace)` tuple.
- `GraphLinker.linkFragment`, `retroLink`, and co-retrieval links fail closed without a scalar exact tuple; dedup, link, `valid_to`, and `access_count` mutations remain behind exact scope predicates.
- Health and metrics now return `401` when no access key is configured unless `MEMENTO_AUTH_DISABLED=true`; actual handlers share the same check.
- Topic suggestions accept strict exact key/workspace scope; authenticated recall passes that scope.
- Working Memory namespaces include encoded key/workspace for authenticated sessions, reject partial scopes, and preserve only the unscoped legacy namespace for requests without an authenticated key. Context, remember, reflect, and session consolidation pass the scope through.
- Local transformers loading sets `allowRemoteModels=false`, local-only loading, and configured cache/snapshot paths in offline/security-pilot mode.

## Verification

- RED test first: `tests/unit/whole-branch-fix.test.js` failed before implementation because the new policy/helper contracts did not exist.
- Focused security suite: **61 passed, 0 failed**.
- Syntax and whitespace checks passed: `node --check` for changed server/scheduler/GraphLinker/FragmentIndex files and `git diff --check`.
- Full `npm test` still has the pre-existing baseline failures/cancellations documented by the parent task; no new failure was observed in the focused security set. The unrelated baseline failures include mock export/linkage issues and consolidator fixture import mismatches.

## Remaining boundary

- The scheduler cannot safely enumerate tenant tuples from the current `embedding_ready` payload, so it explicitly skips graph linking. Enabling tenant-wide background graph work requires a separately reviewed authoritative key/workspace enumeration API.
- Spreading Activation and the dedicated Task 4 runtime remain disabled and were not broadened.
