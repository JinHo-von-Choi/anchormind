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
import { extractRequestCtx } from "../keyId.js";
import { canActOnGroupFragment, isShareReadable } from "../groupGrants.js";

/** topic 지정 forget이 한 번에 지우는 파편 수 */
const TOPIC_BATCH = 200;

/** id 지정 forget의 대상 조회. 대체된(valid_to가 있는) 파편도 지울 수 있어야 하므로 닫힌 행까지 읽는다. */
const FORGET_LOOKUP = Object.freeze({ includeExpired: true });

const NOT_OWNER_REASON = "다른 키가 쓴 파편은 그 키나 그룹에서 forget 권한을 받은 키만 지울 수 있다";

/**
 * 이 키가 지울 수 있는 파편인가. master(keyId 없음)는 모든 파편을 지울 수 있다.
 */
function ownsFragment(frag, keyId) {
  return !keyId || frag.key_id === keyId;
}

/**
 * id 지정 삭제를 할 수 있는가. 쓴 키이거나, 같은 그룹에서 forget 권한을 받은 키다(amend와 같은 규칙).
 * topic 지정 삭제는 여러 파편을 한꺼번에 지우므로 위임하지 않고 쓴 키의 파편만 지운다.
 *
 * @param {Object} frag
 * @param {{ keyId: string|null }} ctx
 * @param {Object} params
 * @returns {boolean}
 */
function canForgetById(frag, ctx, params) {
  return ownsFragment(frag, ctx.keyId)
    || canActOnGroupFragment({ keyId: ctx.keyId, groupGrants: params._groupGrants }, "forget", frag.key_id ?? null);
}

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
/**
 * id 지정 삭제 대상 조회. 공유하지 않은 workspace의 그룹 멤버 파편은 없는 파편으로 본다.
 */
async function lookupForget(host, params, { agentId, keyId, groupKeyIds }) {
  const frag = await host.store.getById(params.id, agentId, keyId, groupKeyIds, FORGET_LOOKUP);
  return frag && isShareReadable(frag, { keyId, groupShareScopes: params._groupShareScopes }) ? frag : null;
}

async function forgetDryRun(host, params, { agentId, keyId, groupKeyIds }) {
  const frag = await lookupForget(host, params, { agentId, keyId, groupKeyIds });
  if (!frag) return { dryRun: true, simulated: null, error: "Fragment not found or no permission" };

  const linkedCount = Array.isArray(frag.linked_to) ? frag.linked_to.length : 0;
  const reason      = !canForgetById(frag, { keyId }, params) ? NOT_OWNER_REASON
    : (frag.ttl_tier === "permanent" && !params.force) ? "permanent 파편은 force 옵션 필요" : null;

  return {
    dryRun   : true,
    simulated: {
      fragment    : { id: frag.id, type: frag.type, content: frag.content, ttl_tier: frag.ttl_tier },
      linked_count: linkedCount,
      would_delete: reason === null,
      reason
    }
  };
}

/**
 * id 지정 삭제. 삭제하지 않고 끝나는 경우(없음, 권한 없음, permanent 보호)의 응답을 돌려주고,
 * 삭제했으면 tally에 더한 뒤 null을 돌려준다.
 */
async function forgetById(host, params, { agentId, keyId, groupKeyIds }, tally) {
  const frag = await lookupForget(host, params, { agentId, keyId, groupKeyIds });
  if (!frag) {
    /**
     * 삭제의 목표 상태는 "그 파편이 없는 것"이다. 이미 없는 대상에 대한 재호출은 목표가 달성돼 있으므로 실패가
     * 아니다. 읽을 수 없는 다른 키의 파편도 이 키에게는 없는 파편이므로 같은 응답을 준다. 응답을 가르면 다른 키
     * 파편 id의 존재 여부가 드러난다. 읽을 수 있는 그룹 파편은 아래에서 권한 오류로 답한다.
     */
    return { deleted: 0, protected: 0 };
  }

  if (!canForgetById(frag, { keyId }, params)) {
    return { deleted: 0, protected: 0, error: "No permission to delete this fragment", reason: NOT_OWNER_REASON };
  }
  if (frag.ttl_tier === "permanent" && !params.force) {
    return { deleted: 0, protected: 1, reason: "permanent 파편은 force 옵션 필요" };
  }

  /** 위임 삭제는 소유 키 이름으로 지운다. 삭제 계층은 그 키의 파편만 지운다. */
  const ownerKeyId = ownsFragment(frag, keyId) ? keyId : frag.key_id;
  /** 색인과 참조는 삭제 계층(cleanupDeletedRows)이 실제로 지운 행만 정리한다. */
  tally.deleted = tally.purged
    ? await cascadeDelete(host, [frag.id], agentId, ownerKeyId, tally)
    : ((await host.store.delete(frag.id, agentId, ownerKeyId, { copies: false })) ? 1 : 0);
  return null;
}

/**
 * topic으로 지울 대상을 고른다. 한 번에 TOPIC_BATCH건까지 고르며, force가 없으면 permanent 파편을 뒤로 보내 지울 수 있는
 * 파편부터 고른다. 삭제는 쓴 키만 하므로 그룹의 다른 키 파편은 고르지 않는다. permanent 파편은 topic 전체 수를 protected로 센다.
 *
 * @returns {Promise<{toDelete: Object[], protectedCount: number}>}
 */
async function selectTopicTargets(host, params, { agentId, keyId }, limit = TOPIC_BATCH) {
  const protectPermanent = !params.force;
  const topicFrags = await host.store.searchByTopic(params.topic, {
    agentId,
    keyId: keyId ? [keyId] : undefined,
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

    /** 조회가 이미 쓴 키로 좁혔다. 다른 키 파편이 섞이면 지우지 않는다. */
    if (!ownsFragment(frag, keyId)) {
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

  /** 색인과 참조는 삭제 계층(cleanupDeletedRows)이 실제로 지운 행만 정리한다. */
  const ids = toDelete.map(f => f.id);
  tally.deleted += tally.purged
    ? await cascadeDelete(host, ids, agentId, keyId, tally)
    : await host.store.deleteMany(ids, agentId, keyId, { copies: false });
}

/** 삭제 연쇄로 지우고 영수증을 tally에 더한다. 지운 대상 수를 돌려준다. */
async function cascadeDelete(host, ids, agentId, keyId, tally) {
  const out    = await host.store.deleteWithCascade(ids, agentId, keyId);
  tally.purged = addPurge(tally.purged, out.purged);
  return out.deleted;
}
