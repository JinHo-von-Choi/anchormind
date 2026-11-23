/**
 * 만료 GC 적체 근사 게이지
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 *   memento_gc_backlog  만료 삭제 직후에 센 남은 후보 수. 상한(GC_BACKLOG_COUNT_CAP)에서 세기를 멈추는 근사값이다.
 *                       삭제 주기가 한 번도 끝나지 않은 프로세스는 0으로 내보낸다.
 */

import promClient   from "prom-client";
import { register } from "../../metrics.js";

/** 만료 삭제 후 남은 후보 수(근사) */
export const gcBacklog = new promClient.Gauge({
  name     : "memento_gc_backlog",
  help     : "만료 삭제 직후 남은 GC 후보 수(근사, 상한에서 멈춰 센다)",
  registers: [register]
});

/**
 * 적체 게이지를 기록한다.
 *
 * @param {number} count
 */
export function setGcBacklog(count) {
  gcBacklog.set(count);
}

/** 보존 모드 때문에 건너뛴 정리 단계 수(RetentionGuard) */
export const lifecycleSkippedTotal = new promClient.Counter({
  name      : "memento_lifecycle_skipped_total",
  help      : "자동 정리가 꺼져(보존 모드 manual 또는 재개 대기) 건너뛴 정리 단계 수",
  labelNames: ["stage", "reason"],
  registers : [register]
});
