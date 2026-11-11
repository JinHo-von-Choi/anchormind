import { logWarn } from "../../logger.js";

const instant = value => {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : Symbol("invalid-cache-date");
};

/** 캐시 payload를 현재 DB 본문·검토·만료 버전과 대조한다. 실패는 cache miss다. */
export async function validateHotCacheFragments({ fetched, store, keyId, query, scope }) {
  const candidates = fetched.filter(fragment => fragment?.content && fragment.content_hash);
  if (candidates.length === 0) return [];
  let metadata;
  try {
    metadata = await store.getCacheValidation(
      candidates.map(fragment => fragment.id), query.agentId ?? "default", keyId, query._groupKeyIds ?? [], {
        viewerKeyId: query.viewerKeyId, workspace: query.workspace ?? null,
        allWorkspaces: query.allWorkspaces === true, includeSuperseded: query.includeSuperseded === true,
        includePeerAgents: query.includePeerAgents === true, _isMaster: query._isMaster === true
      }
    );
  } catch (err) {
    logWarn(`[HotCache] metadata revalidation failed; falling back to DB search: ${err.message}`);
    return [];
  }
  const current = new Map(metadata.map(row => [row.id, row]));
  const valid = candidates.filter(fragment => {
    const row = current.get(fragment.id);
    return row && row.content_hash === fragment.content_hash
      && (row.review_state ?? null) === (fragment.review_state ?? null)
      && instant(row.valid_to) === instant(fragment.valid_to);
  });
  return !scope || scope.isNoop() ? valid : valid.filter(fragment => scope.applyTo(fragment));
}
