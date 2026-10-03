/**
 * 읽기 경로 workspace 허가 지표 등록 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * memento_workspace_read_authz_total이 공용 레지스트리에 카운터로 등록되어 있고 라벨이 surface, reason,
 * outcome 셋이며, 라벨 값 집합이 판정 표면과 거부 사유 상수에서 도출되고, 집합 밖 값은 other로 닫히는지 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { register } from "../../lib/metrics.js";
import {
  workspaceReadAuthzTotal,
  recordWorkspaceReadAuthz,
  READ_AUTHZ_SURFACES,
  READ_AUTHZ_REASONS,
  READ_AUTHZ_OUTCOMES
} from "../../lib/memory/read/read-authz-metrics.js";
import {
  WORKSPACE_READ_TOOLS,
  WORKSPACE_READ_REASONS,
  RESOURCE_READ_SURFACE,
  MODE_PRESET_SURFACE,
  MODE_PRESET_REASON
} from "../../lib/memory/read/workspace-read-policy.js";

async function valueOf(labels) {
  const { values } = await workspaceReadAuthzTotal.get();
  const hit = values.find(v => Object.entries(labels).every(([k, x]) => v.labels[k] === x));
  return hit ? hit.value : 0;
}

describe("memento_workspace_read_authz_total 등록", () => {
  it("공용 레지스트리에 카운터로 등록되어 있다", async () => {
    const metric = register.getSingleMetric("memento_workspace_read_authz_total");
    assert.ok(metric, "레지스트리에 없다");
    assert.equal(metric, workspaceReadAuthzTotal);
    const { type } = await metric.get();
    assert.equal(type, "counter");
  });

  it("라벨은 surface, reason, outcome 셋이다", () => {
    assert.deepEqual([...workspaceReadAuthzTotal.labelNames].sort(), ["outcome", "reason", "surface"]);
  });

  it("라벨 값 집합은 판정 표면과 사유 상수에서 도출된다", () => {
    assert.deepEqual([...READ_AUTHZ_SURFACES].sort(),
      [...Object.keys(WORKSPACE_READ_TOOLS), RESOURCE_READ_SURFACE, MODE_PRESET_SURFACE].sort());
    assert.deepEqual([...READ_AUTHZ_REASONS].sort(), [...WORKSPACE_READ_REASONS, MODE_PRESET_REASON].sort());
    assert.deepEqual([...READ_AUTHZ_OUTCOMES].sort(), ["denied", "would_deny"]);
  });

  it("집합 밖 라벨 값은 other로 기록한다", async () => {
    const labels = { surface: "other", reason: "other", outcome: "other" };
    const before = await valueOf(labels);
    recordWorkspaceReadAuthz("/v1/unknown?x=1", "free text", "maybe");
    assert.equal(await valueOf(labels), before + 1);
  });

  it("집합 안 라벨 값은 그대로 기록한다", async () => {
    const labels = { surface: "recall", reason: "explicit_out_of_range", outcome: "would_deny" };
    const before = await valueOf(labels);
    recordWorkspaceReadAuthz("recall", "explicit_out_of_range", "would_deny");
    assert.equal(await valueOf(labels), before + 1);
  });
});
