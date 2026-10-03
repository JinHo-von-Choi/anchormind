/**
 * 읽기 경로 workspace 허가 판정 지표.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 허가 밖 판정만 센다. 라벨 값은 모두 닫힌 집합이고 집합 밖 값은 other로 기록한다.
 *   surface: workspace 허가 도구 이름, resources/read, mode_preset
 *   reason : workspace 거부 사유 4종, preset_requires_master
 *   outcome: would_deny(warn에서 통과시킨 요청), denied(enforce에서 거부한 요청)
 * 키별 표본은 같은 판정의 경고 로그(키 id, 표면, 사유, 대상 workspace)로 남는다.
 */

import promClient   from "prom-client";
import { register } from "../../metrics.js";
import {
  WORKSPACE_READ_TOOLS,
  WORKSPACE_READ_REASONS,
  RESOURCE_READ_SURFACE,
  MODE_PRESET_SURFACE,
  MODE_PRESET_REASON
} from "./workspace-read-policy.js";

export const READ_AUTHZ_SURFACES = Object.freeze([
  ...Object.keys(WORKSPACE_READ_TOOLS), RESOURCE_READ_SURFACE, MODE_PRESET_SURFACE
]);
export const READ_AUTHZ_REASONS  = Object.freeze([...WORKSPACE_READ_REASONS, MODE_PRESET_REASON]);
export const READ_AUTHZ_OUTCOMES = Object.freeze(["would_deny", "denied"]);

/** 허가 밖 판정 건수 (surface, reason, outcome별) */
export const workspaceReadAuthzTotal = new promClient.Counter({
  name      : "memento_workspace_read_authz_total",
  help      : "읽기 경로 workspace 허가와 master 전용 preset 판정에서 허가 밖으로 판정된 요청 수",
  labelNames: ["surface", "reason", "outcome"],
  registers : [register]
});

const closed = (value, allowed) => (allowed.includes(value) ? value : "other");

/**
 * 허가 밖 판정 하나를 기록한다.
 *
 * @param {string}                   surface
 * @param {string}                   reason
 * @param {"would_deny"|"denied"}    outcome
 */
export function recordWorkspaceReadAuthz(surface, reason, outcome) {
  workspaceReadAuthzTotal.inc({
    surface: closed(surface, READ_AUTHZ_SURFACES),
    reason : closed(reason, READ_AUTHZ_REASONS),
    outcome: closed(outcome, READ_AUTHZ_OUTCOMES)
  });
}
