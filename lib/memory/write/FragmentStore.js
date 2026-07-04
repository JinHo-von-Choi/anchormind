/**
 * FragmentStore - 파편 저장소 파사드 (읽기/쓰기 분리)
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 * 수정일: 2026-03-03 (Temporal Schema - valid_from/valid_to, searchAsOf 추가)
 * 수정일: 2026-03-03 (API 키 격리 - key_id 컬럼, 조회 필터 추가)
 * 수정일: 2026-03-15 (읽기/쓰기 분리 — FragmentReader / FragmentWriter 위임)
 */

import { FragmentReader } from "../read/FragmentReader.js";
import { FragmentWriter } from "./FragmentWriter.js";
import { LinkStore }      from "../link/LinkStore.js";
import { FragmentGC }     from "../consolidate/FragmentGC.js";

export class FragmentStore {
  constructor() {
    this.reader = new FragmentReader();
    this.writer = new FragmentWriter();
    this.links  = new LinkStore();
    this.gc     = new FragmentGC();
  }

  // ── Read delegations ────────────────────────────────────────────────────────

  getById(id, agentId, keyId, groupKeyIds)                            { return this.reader.getById(id, agentId, keyId, groupKeyIds); }
  getByIds(ids, agentId, keyId, groupKeyIds)                          { return this.reader.getByIds(ids, agentId, keyId, groupKeyIds); }
  getHistory(fragmentId, agentId, keyId, groupKeyIds)                 { return this.reader.getHistory(fragmentId, agentId, keyId, groupKeyIds); }
  searchByKeywords(keywords, options)                                  { return this.reader.searchByKeywords(keywords, options); }
  searchByTopic(topic, options)                                        { return this.reader.searchByTopic(topic, options); }
  searchBySemantic(queryEmbedding, limit, minSimilarity, agentId, keyId, includeSuperseded, timeRange, workspace, affect, morphemeOnly = false) {
    return this.reader.searchBySemantic(queryEmbedding, limit, minSimilarity, agentId, keyId, includeSuperseded, timeRange, workspace, affect, morphemeOnly);
  }
  searchByTimeRange(from, to, options)                                  { return this.reader.searchByTimeRange(from, to, options); }
  searchAsOf(asOf, agentId, opts, keyId)                               { return this.reader.searchAsOf(asOf, agentId, opts, keyId); }
  searchBySource(source, agentId, keyId, limit)                        { return this.reader.searchBySource(source, agentId, keyId, limit); }
  findCaseIdBySessionTopic(sessionId, topic, keyId, groupKeyIds)        { return this.reader.findCaseIdBySessionTopic(sessionId, topic, keyId, groupKeyIds); }
  findErrorFragmentsBySessionTopic(sessionId, topic, keyId, groupKeyIds) { return this.reader.findErrorFragmentsBySessionTopic(sessionId, topic, keyId, groupKeyIds); }
  findByIdempotencyKey(idempotencyKey, keyId)                          { return this.reader.findByIdempotencyKey(idempotencyKey, keyId); }

  // ── Write delegations ───────────────────────────────────────────────────────

  ensureSchema()                                                       { return this.writer.ensureSchema(); }
  insert(fragment)                                                     { return this.writer.insert(fragment); }
  update(id, updates, agentId, keyId, existing)                       { return this.writer.update(id, updates, agentId, keyId, existing); }
  delete(id, agentId, keyId)                                          { return this.writer.delete(id, agentId, keyId); }
  deleteMany(ids, agentId, keyId)                                     { return this.writer.deleteMany(ids, agentId, keyId); }
  deleteByAgent(agentId)                                              { return this.writer.deleteByAgent(agentId); }
  incrementAccess(ids, agentId, opts)                                 { return this.writer.incrementAccess(ids, agentId, opts); }
  touchLinked(retrievedIds, agentId, keyId)                           { return this.writer.touchLinked(retrievedIds, agentId, keyId); }
  archiveVersion(fragment, agentId)                                   { return this.writer.archiveVersion(fragment, agentId); }
  updateTtlTier(id, ttlTier, keyId = null)                              { return this.writer.updateTtlTier(id, ttlTier, keyId); }
  patchAssertion(id, assertionStatus, keyId = null)                    { return this.writer.patchAssertion(id, assertionStatus, keyId); }
  updateCaseId(fragmentId, caseId, keyId)                              { return this.writer.updateCaseId(fragmentId, caseId, keyId); }
  deleteExpired()                                                      { return this.writer.deleteExpired(); }

  // ── GC delegations ──────────────────────────────────────────────────────────

  decayImportance()                                                    { return this.gc.decayImportance(); }
  transitionTTL()                                                      { return this.gc.transitionTTL(); }
  decayEmaActivation()                                                 { return this.gc.decayEmaActivation(); }

  // ── Link delegations ────────────────────────────────────────────────────────

  createLink(fromId, toId, relationType, agentId, weight)              { return this.links.createLink(fromId, toId, relationType, agentId, weight); }
  createLinks(pairs, agentId)                                          { return this.links.createLinks(pairs, agentId); }
  getLinkedFragments(fromIds, relationType, agentId, keyId)           { return this.links.getLinkedFragments(fromIds, relationType, agentId, keyId); }
  getLinkedIds(fragmentId, agentId, keyId)                            { return this.links.getLinkedIds(fragmentId, agentId, keyId); }
  isReachable(startId, targetId, agentId, keyId)                      { return this.links.isReachable(startId, targetId, agentId, keyId); }
  getRCAChain(startId, agentId, keyId, groupKeyIds)                   { return this.links.getRCAChain(startId, agentId, keyId, groupKeyIds); }
}
