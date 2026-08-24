# Whole-branch security hardening round 4 report

## Scope

- Builds on local commits `f94dd02` and `7082ee8` in the security-pilot branch.
- No database, model download, external service, push, PR, merge, or deployment was used.

## Implemented

- The central pilot validator now requires every maintenance/mutation flag to be explicitly `false`: spreading activation, reconsolidation, AutoReflect, GraphLink, consolidation, GC, and all three consolidation subflags. Missing values fail closed.
- Runtime defense-in-depth was added to MemoryRecaller spreading activation, feedback reconsolidation, ReconsolidationEngine, manual `memory_consolidate`, MemoryManager/Reflector/Consolidator consolidation, GraphLinker, FragmentGC, and ConsolidatorGC. Pilot calls return disabled/no-op results before database or write work.
- GraphLinker now rejects all pilot maintenance calls, including an otherwise exact key/workspace tuple. Non-pilot exact and legacy behavior remains unchanged.
- The pilot runner checks the consolidation subflags as well as the top-level flags.

## Verification

- RED-first round-4 tests initially failed on missing central flag validation and runtime guards; after implementation: **5 passed, 0 failed** in the new round-4 suite.
- Focused security/related suite: **121 passed, 0 failed, 0 cancelled**.
- Full `npm test`: **2606 total, 2590 passed, 7 failed, 7 cancelled, 2 skipped**. The seven failures/cancellations remain the existing consolidator fixture/mock-export, active-session tracker export, and search query export family; no new focused security failure appeared.
- Syntax, shell, whitespace, and targeted lint checks passed with **0 errors**. One shell-file ignore warning remains from ESLint configuration.

## Boundary

The actual pilot runtime was not started. Direct hostile `node server.js` startup testing confirmed the validator rejects unsafe mutation flags before listener creation; no listener was observed.
