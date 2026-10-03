/**
 * 가져오기 오류 유형
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * DB와 메모리 모듈을 불러오지 않는 가벼운 모듈이다. 관리 처리기가 가져오기 실행기를 불러오기 전에도
 * 오류 유형을 구분할 수 있도록 따로 둔다.
 */

/** 가져오기 프로필 옵션이 서로 맞지 않을 때의 오류. */
export class ImportOptionError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "ImportOptionError";
  }
}

/** 대상 DB가 실패해 가져오기를 이어갈 수 없을 때의 오류. 그때까지의 집계를 담는다. */
export class ImportAbortedError extends Error {
  /**
   * @param {import("./ImportReport.js").ImportReport} report
   * @param {Error} cause
   */
  constructor(report, cause) {
    super(`Import aborted: ${cause.message}`, { cause });
    this.name   = "ImportAbortedError";
    this.report = report;
  }
}
