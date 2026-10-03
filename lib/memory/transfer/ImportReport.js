/**
 * ImportReport - 가져오기 집계
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 파편, 링크, 이력 줄마다 imported(새로 기록), duplicates(이미 있어 기록하지 않음),
 * rejected(유형이 있는 사유로 받아들이지 않음), errors(행 문제가 아닌 실패)를 센다. 행은 네
 * 분류 중 정확히 하나에 들어간다.
 */

import { V1_ACCEPTED_UNTIL } from "./exportFormat.js";

/** 거부 사유 유형. 응답의 rejected_by_reason 키로 쓴다. */
export const REJECT_REASONS = Object.freeze({
  INVALID_JSON          : "invalid_json",
  INVALID_RECORD        : "invalid_record",
  INVALID_ROW           : "invalid_row",
  INPUT_INVALID         : "input_invalid",
  POLICY_VIOLATION      : "policy_violation",
  ID_CONFLICT           : "id_conflict",
  DATABASE_REJECTED     : "database_rejected",
  LINK_INVALID          : "link_invalid",
  LINK_ENDPOINT_MISSING : "link_endpoint_missing",
  VERSION_FRAGMENT_MISSING: "version_fragment_missing"
});

/** 거부 표본으로 남기는 최대 건수. */
export const MAX_REJECT_SAMPLES = 20;

/** 집계 대상 줄 종류. */
const ENTITIES = Object.freeze(["fragments", "links", "versions"]);

/** 유형별 집계 객체 하나. */
function emptyCounts() {
  return { imported: 0, duplicates: 0, rejected: 0, errors: 0 };
}

export class ImportReport {
  /**
   * @param {Object}  [options]
   * @param {boolean} [options.dryRun=false]
   * @param {boolean} [options.restore=false]
   */
  constructor({ dryRun = false, restore = false } = {}) {
    this.dryRun            = dryRun;
    this.restore           = restore;
    this.lines             = 0;
    this.formatVersion     = null;
    this.entities          = Object.fromEntries(ENTITIES.map(e => [e, emptyCounts()]));
    this.rejectedByReason  = {};
    this.rejectSamples     = [];
    this.errorSamples      = [];
    this.transformed       = 0;
    this.ignored           = { key_id: 0, is_anchor: 0 };
    this.warnings          = [];
    this.embeddingQueued   = null;
  }

  /** 새로 기록한 행. */
  imported(entity) {
    this.entities[entity].imported++;
  }

  /** 이미 있어 기록하지 않은 행. */
  duplicate(entity) {
    this.entities[entity].duplicates++;
  }

  /**
   * 유형이 있는 사유로 받아들이지 않은 행.
   *
   * @param {string} entity
   * @param {string} reason - REJECT_REASONS 값
   * @param {{line?: number, detail?: string}} [info]
   */
  reject(entity, reason, { line, detail } = {}) {
    this.entities[entity].rejected++;
    this.rejectedByReason[reason] = (this.rejectedByReason[reason] ?? 0) + 1;
    if (this.rejectSamples.length < MAX_REJECT_SAMPLES) {
      this.rejectSamples.push({ entity, reason, ...(line !== undefined ? { line } : {}), ...(detail ? { detail } : {}) });
    }
  }

  /**
   * 행 문제가 아닌 실패(연결 오류 등)로 기록하지 못한 행.
   *
   * @param {string} entity
   * @param {{line?: number, detail?: string}} [info]
   */
  error(entity, { line, detail } = {}) {
    this.entities[entity].errors++;
    if (this.errorSamples.length < MAX_REJECT_SAMPLES) {
      this.errorSamples.push({ entity, ...(line !== undefined ? { line } : {}), ...(detail ? { detail } : {}) });
    }
  }

  /**
   * 파일에 있었지만 반영하지 않은 필드를 센다.
   *
   * @param {"key_id"|"is_anchor"} field
   */
  ignoredField(field) {
    this.ignored[field]++;
  }

  /**
   * @param {string} code
   * @param {Object} [detail]
   */
  warn(code, detail = {}) {
    this.warnings.push({ code, ...detail });
  }

  /**
   * 한 종류의 줄 수 합계.
   *
   * @param {string} entity
   * @returns {number}
   */
  total(entity) {
    const c = this.entities[entity];
    return c.imported + c.duplicates + c.rejected + c.errors;
  }

  /**
   * 응답과 CLI 요약에 쓰는 객체. 최상위 imported, duplicates, rejected, errors는 파편 집계다.
   * skipped는 duplicates와 같은 값이다.
   *
   * @returns {Object}
   */
  toJSON() {
    const f = this.entities.fragments;
    const format = { version: this.formatVersion };
    if (this.formatVersion === 1) {
      Object.assign(format, { deprecated: true, accepted_until: V1_ACCEPTED_UNTIL });
    }
    return {
      dryRun           : this.dryRun,
      restore          : this.restore,
      format,
      lines            : this.lines,
      imported         : f.imported,
      duplicates       : f.duplicates,
      skipped          : f.duplicates,
      rejected         : f.rejected,
      errors           : f.errors,
      rejected_by_reason: { ...this.rejectedByReason },
      fragments        : { ...f },
      links            : { ...this.entities.links },
      versions         : { ...this.entities.versions },
      transformed      : this.transformed,
      ignored          : { ...this.ignored },
      ...(this.embeddingQueued !== null ? { embedding_queued: this.embeddingQueued } : {}),
      warnings         : [...this.warnings],
      rejected_samples : [...this.rejectSamples],
      error_samples    : [...this.errorSamples]
    };
  }
}
