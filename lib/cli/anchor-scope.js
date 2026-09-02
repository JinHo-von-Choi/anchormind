/**
 * non-default anchor 범위 inventory 및 승인된 공유 anchor 정규화.
 * 기본은 dry-run이며 content를 출력하지 않는다.
 */
import fs from "node:fs";
import { shutdownPool } from "../tools/db.js";
import { MemoryManager } from "../memory/MemoryManager.js";
import { FragmentStore } from "../memory/write/FragmentStore.js";
import { classifyAnchors } from "../memory/admin/AnchorScopeInventory.js";
import {
  backfillAgentScopeSnapshots,
  assertBackfillComplete,
  getAgentScopeBackfillStatus,
  getPendingScopeSnapshotCounts,
  hasAgentScopeSnapshotSchema
} from "../memory/admin/AgentScopeBackfill.js";

export const usage = [
  "Usage: memento-mcp anchor-scope [options]",
  "",
  "Inventory non-default anchors. Default: dry-run.",
  "",
  "Options:",
  "  --classifications <file>   JSON: { shared: [ids], private: [ids] }",
  "  --workspace <name>         Restrict inventory to one workspace",
  "  --agent <id>               Restrict inventory to one current agent",
  "  --include-non-anchors      Include every legacy non-default fragment",
  "  --backfill-snapshots       Inspect/backfill version and case-event snapshots",
  "  --batch-size <n>           Snapshot backfill batch size (default: 500)",
  "  --execute                  Normalize approved shared anchors to default",
  "  --approve-shared           Required together with --execute",
  "  --approve-backfill         Required for snapshot backfill execution",
  "  --json                     Print JSON",
].join("\n");

function loadClassifications(file) {
  if (!file) return { shared: new Set(), private: new Set() };
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    shared : new Set(Array.isArray(raw.shared) ? raw.shared.map(String) : []),
    private: new Set(Array.isArray(raw.private) ? raw.private.map(String) : [])
  };
}

export function parseStrictBooleanFlag(args, name) {
  const value = args[name];
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  throw new Error(`--${name} must be supplied once as a boolean flag`);
}

export function assertNoNormalizationFailures(results) {
  const failures = results.filter(result => !result.updated || result.cacheConsistent === false);
  if (failures.length > 0) {
    throw new Error(`agent scope normalization failed for ${failures.length} item(s)`);
  }
}

/**
 * 승인 목록 전체의 id/agent/workspace를 먼저 확인한 뒤에만 실제 정규화를 시작한다.
 * 따라서 global과 named workspace 항목이 섞여 있어도 잘못된 후행 항목 때문에
 * 선행 항목만 바뀌는 예측 가능한 부분 적용을 피한다.
 */
export async function normalizeApprovedFragments(manager, approved, { anchorsOnly = true } = {}) {
  const prepared = approved.map(item => ({
    item,
    options: { anchorsOnly, workspace: item.workspace ?? null, allWorkspaces: false }
  }));

  for (const { item, options } of prepared) {
    const validation = await manager.validateFragmentAgentNormalization(
      item.id, item.agentId, options
    );
    if (!validation.valid) {
      throw new Error(`agent scope normalization preflight failed for ${item.id}: ${validation.error}`);
    }
  }

  const results = [];
  for (const { item, options } of prepared) {
    const result = await manager.normalizeFragmentAgentToDefault(
      item.id, item.agentId, options
    );
    results.push({
      id: item.id,
      updated: result.updated === true,
      error: result.error,
      ...(result.cacheWarning ? { cacheWarning: result.cacheWarning } : {}),
      ...(result.databaseUpdated === true ? { databaseUpdated: true } : {}),
      ...(result.cacheConsistent === false ? { cacheConsistent: false } : {})
    });
  }
  return results;
}

export default async function anchorScope(args) {
  const execute = parseStrictBooleanFlag(args, "execute");
  const approveShared = parseStrictBooleanFlag(args, "approve-shared");
  const approveBackfill = parseStrictBooleanFlag(args, "approve-backfill");
  const includeNonAnchors = parseStrictBooleanFlag(args, "include-non-anchors");
  const snapshotMode = parseStrictBooleanFlag(args, "backfill-snapshots");
  if (snapshotMode) {
    if (execute && !approveBackfill) {
      throw new Error("--backfill-snapshots --execute requires explicit --approve-backfill");
    }
    if (!execute && approveBackfill) {
      throw new Error("--approve-backfill requires --execute");
    }
    try {
      const before = await getAgentScopeBackfillStatus();
      if (!before.migrationReady) {
        throw new Error("migration-046 must be applied before snapshot backfill");
      }
      const batchSize = args["batch-size"] === undefined ? 500 : Number(args["batch-size"]);
      const updated = execute
        ? await backfillAgentScopeSnapshots({ batchSize })
        : null;
      const after = execute ? await getAgentScopeBackfillStatus() : null;
      console.log(JSON.stringify({ dryRun: !execute, before, ...(updated ? { updated, after } : {}) }, null, 2));
      if (execute) assertBackfillComplete(after);
      return;
    } finally {
      await shutdownPool();
    }
  }

  if (execute && !approveShared) {
    throw new Error("--execute requires explicit --approve-shared");
  }
  if (execute && !args.classifications) {
    throw new Error("--execute requires --classifications <file>");
  }

  try {
    if (execute && !await hasAgentScopeSnapshotSchema()) {
      throw new Error("migration-046 must be applied before agent scope normalization");
    }
    const classifications = loadClassifications(args.classifications);
    const store = new FragmentStore();
    const rows = await store.inventoryNonDefaultFragments({
      workspace: args.workspace || null,
      agentId  : args.agent || null,
      anchorsOnly: !includeNonAnchors
    });
    const inventory = classifyAnchors(rows, classifications);
    const approved = inventory.filter(item => item.category === "shared");
    const results = [];

    if (execute) {
      const pendingSnapshots = await getPendingScopeSnapshotCounts(
        approved.map(item => item.id)
      );
      if (pendingSnapshots.total > 0) {
        throw new Error(
          `approved fragments have ${pendingSnapshots.total} pending scope snapshot(s) ` +
          `(versions=${pendingSnapshots.fragmentVersions}, events=${pendingSnapshots.caseEvents}); ` +
          "run --backfill-snapshots first"
        );
      }
      const manager = MemoryManager.create();
      results.push(...await normalizeApprovedFragments(manager, approved, {
        anchorsOnly: !includeNonAnchors
      }));
    }

    const summary = {
      dryRun: !execute,
      counts: {
        total      : inventory.length,
        shared     : approved.length,
        private    : inventory.filter(item => item.category === "private").length,
        unconfirmed: inventory.filter(item => item.category === "unconfirmed").length
      },
      scope: includeNonAnchors ? "all-fragments" : "anchors-only",
      inventory,
      ...(execute ? { results } : { wouldNormalize: approved.map(item => item.id) })
    };

    console.log(JSON.stringify(summary, null, 2));
    assertNoNormalizationFailures(results);
  } finally {
    await shutdownPool();
  }
}
