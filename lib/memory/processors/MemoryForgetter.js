/**
 * MemoryForgetter - 파편 망각(forget)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 * MemoryRememberer.forget이 위임한다. host는 store, index를 가진 MemoryRememberer다.
 */

import { forgetCascadeEnabled } from "../../config.js";
import { addPurge, emptyPurge, forgetReceipt } from "../write/ForgetCascade.js";
import { logWarn } from "../../logger.js";
import { extractRequestCtx } from "../keyId.js";

/** topic 지정 forget이 한 번에 지우는 파편 수 */
const TOPIC_BATCH = 200;

/**
 * forget - 파편 망각
 *
 * @param {Object} params
 *   - id          {string} 특정 파편 ID
 *   - topic       {string} 주제 전체 삭제
 *   - beforeDays  {number} N일 전 이전 파편 삭제
 *   - force       {boolean} permanent 파편도 삭제 여부
 * @returns {Object} { deleted, protected, purged? } purged는 삭제 연쇄(MEMENTO_FORGET_CASCADE)가 켜졌을 때 싣는다
 */
export async function forgetFragments(host, params) {
  const ctx = extractRequestCtx(params);

  /** dryRun은 어떤 지정 방식이든 지우지 않는다. id면 그 파편을, topic이면 지울 대상 전체를 미리 본다. */
  if (params.dryRun === true) return forgetPreview(host, params, ctx);

  const tally = { deleted: 0, protected: 0, purged: forgetCascadeEnabled() ? emptyPurge() : null };
  if (params.id) {
    const early = await forgetById(host, params, ctx, tally);
    if (early) return early;
  }
  if (params.topic) await forgetByTopic(host, params, ctx, tally);
  return forgetReceipt(tally);
}

/**
 * forget dryRun 응답. 실제 삭제는 id 대상을 지운 뒤 topic 대상을 지우므로, 둘 다 주고 id 대상을 지울 수
 * 있으면 topic 미리보기(id 대상 제외)를 simulated.topic_targets에 싣는다. 대상 지정이 없으면 지울 것이 없다.
 */
async function forgetPreview(host, params, ctx) {
  if (!params.id && !params.topic) return { dryRun: true, simulated: null, error: "id or topic is required" };
  if (!params.id) return forgetTopicDryRun(host, params, ctx);

  const preview = await forgetDryRun(host, params, ctx);
  if (params.topic && preview.simulated?.would_delete) {
    preview.simulated.topic_targets = (await forgetTopicDryRun(host, params, ctx, params.id)).simulated;
  }
  return preview;
}

/** forget dryRun 응답 */
async function forgetDryRun(host, params, { agentId, keyId, groupKeyIds }) {
  const frag = await host.store.getById(params.id, agentId, keyId, groupKeyIds);
  if (!frag) return { dryRun: true, simulated: null, error: "Fragment not found or no permission" };

  const linkedCount = Array.isArray(frag.linked_to) ? frag.linked_to.length : 0;
  const wouldDelete = !(frag.ttl_tier === "permanent" && !params.force);

  return {
    dryRun   : true,
    simulated: {
      fragment    : { id: frag.id, type: frag.type, content: frag.content, ttl_tier: frag.ttl_tier },
      linked_count: linkedCount,
      would_delete: wouldDelete,
      reason      : wouldDelete ? null : "permanent 파편은 force 옵션 필요"
    }
  };
}

/**
 * id 지정 삭제. 삭제하지 않고 끝나는 경우(없음, 권한 없음, permanent 보호)의 응답을 돌려주고,
 * 삭제했으면 tally에 더한 뒤 null을 돌려준다.
 */
async function forgetById(host, params, { agentId, keyId, groupKeyIds }, tally) {
  const frag = await host.store.getById(params.id, agentId, keyId, groupKeyIds);
  if (!frag) {
    /**
     * 삭제의 목표 상태는 "그 파편이 없는 것"이다. 이미 없는 대상에 대한
     * 재호출은 목표가 달성돼 있으므로 실패가 아니다. 반면 남의 파편을
     * 지우려는 시도는 실패여야 하므로 두 경우를 갈라 응답한다.
     */
    const probe = typeof host.store.probeAccess === "function"
      ? await host.store.probeAccess(params.id, agentId, keyId, groupKeyIds)
      : null;
    /** 판정할 수 없으면 찾지 못한 것으로 답한다. 모르는 것을 성공으로 답하지 않는다. */
    if (!probe) {
      return { deleted: 0, protected: 0, error: "Fragment not found or no permission" };
    }
    if (probe.exists && !probe.accessible) {
      return { deleted: 0, protected: 0, error: "No permission to delete this fragment" };
    }
    return { deleted: 0, protected: 0 };
  }

  if (frag.ttl_tier === "permanent" && !params.force) {
    return { deleted: 0, protected: 1, reason: "permanent 파편은 force 옵션 필요" };
  }

  await host.index.deindex(frag.id, frag.keywords, frag.topic, frag.type, frag.key_id ?? null, { content: frag.content });
  tally.deleted = tally.purged
    ? await cascadeDelete(host, [frag.id], agentId, keyId, tally)
    : ((await host.store.delete(frag.id, agentId, keyId)) ? 1 : 0);
  return null;
}

/**
 * topic으로 지울 대상을 고른다. 한 번에 TOPIC_BATCH건까지 고르며, force가 없으면 permanent 파편을 뒤로 보내 지울 수 있는
 * 파편부터 고른다. permanent 파편은 topic 전체 수를, 소유하지 않은 파편은 고른 범위 안의 수를 protected로 센다.
 *
 * @returns {Promise<{toDelete: Object[], protectedCount: number}>}
 */
async function selectTopicTargets(host, params, { agentId, keyId, groupKeyIds }, limit = TOPIC_BATCH) {
  const protectPermanent = !params.force;
  const topicFrags = await host.store.searchByTopic(params.topic, {
    agentId,
    keyId: groupKeyIds ?? (keyId ? [keyId] : undefined),
    workspace: params.workspace ?? params._defaultWorkspace ?? null,
    includeSuperseded: true,
    withTtlTier: true,
    protectPermanent,
    limit,
  });

  const toDelete     = [];
  let protectedCount = protectPermanent ? Number(topicFrags[0]?.permanent_total ?? 0) : 0;
  for (const frag of topicFrags) {
    /** permanent_total에 이미 셌다 */
    if (protectPermanent && frag.ttl_tier === "permanent") continue;

    /** API 키 소유권 검사 (그룹 인식) */
    if (keyId && frag.key_id !== keyId && (!groupKeyIds || !groupKeyIds.includes(frag.key_id))) {
      protectedCount++;
      continue;
    }

    toDelete.push(frag);
  }
  return { toDelete, protectedCount };
}

/**
 * topic 지정 forget의 dryRun 응답. 실제 삭제와 같은 대상을 고르고, 삭제 연쇄가 켜졌으면 연쇄 정리 예상 건수를 싣는다.
 * excludeId는 같은 호출에서 먼저 지울 id 대상이다(실제 topic 조회 시점에는 이미 없다).
 */
async function forgetTopicDryRun(host, params, ctx, excludeId = null) {
  /** id 대상을 빼면 실제 조회보다 한 건 모자라므로 한 건 더 가져온다 */
  const selected       = await selectTopicTargets(host, params, ctx, excludeId ? TOPIC_BATCH + 1 : TOPIC_BATCH);
  const toDelete       = selected.toDelete.filter(f => f.id !== excludeId).slice(0, TOPIC_BATCH);
  const protectedCount = selected.protectedCount;
  const ids       = toDelete.map(f => f.id);
  const simulated = {
    topic       : params.topic,
    would_delete: ids.length,
    protected   : protectedCount,
    linked_count: toDelete.reduce((sum, f) => sum + (Array.isArray(f.linked_to) ? f.linked_to.length : 0), 0),
    fragment_ids: ids
  };
  if (forgetCascadeEnabled()) {
    simulated.purged = ids.length > 0 ? await host.store.previewCascade(ids, ctx.agentId) : emptyPurge();
  }
  return { dryRun: true, simulated };
}

/** topic 지정 삭제 */
async function forgetByTopic(host, params, ctx, tally) {
  const { agentId, keyId } = ctx;
  const { toDelete, protectedCount } = await selectTopicTargets(host, params, ctx);
  tally.protected += protectedCount;
  if (toDelete.length === 0) return;

  /** Redis deindex 병렬 처리 */
  await Promise.all(
    toDelete.map(frag =>
      host.index.deindex(frag.id, frag.keywords, frag.topic, frag.type, frag.key_id ?? null, { content: frag.content })
        .catch(err => logWarn(`[MemoryRememberer] deindex failed: ${err.message}`))
    )
  );

  /** 단일 DELETE ... WHERE id = ANY($1) */
  const ids = toDelete.map(f => f.id);
  tally.deleted += tally.purged
    ? await cascadeDelete(host, ids, agentId, keyId, tally)
    : await host.store.deleteMany(ids, agentId, keyId);
}

/** 삭제 연쇄로 지우고 영수증을 tally에 더한다. 지운 대상 수를 돌려준다. */
async function cascadeDelete(host, ids, agentId, keyId, tally) {
  const out    = await host.store.deleteWithCascade(ids, agentId, keyId);
  tally.purged = addPurge(tally.purged, out.purged);
  return out.deleted;
}
