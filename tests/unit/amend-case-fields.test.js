/**
 * Unit tests: amend의 케이스 필드 갱신과 미지원 필드·만료 파편 처리.
 *
 * SKILL.md와 lib/jsonrpc.js가 안내하는 케이스 종결 절차
 * amend(id, resolutionStatus, outcome, phase)가 실제로 반영되는지 검증한다.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { amendDefinition } = await import("../../lib/tools/memory-schemas.js");

describe("amend 스키마", () => {
  const props = amendDefinition.inputSchema.properties;

  it("케이스 종결 필드 3종을 노출한다", () => {
    assert.ok(props.resolutionStatus, "resolutionStatus 필요");
    assert.ok(props.outcome, "outcome 필요");
    assert.ok(props.phase, "phase 필요");
  });

  it("resolutionStatus enum이 저장 경로와 일치한다", () => {
    assert.deepEqual(props.resolutionStatus.enum, ["open", "resolved", "abandoned"]);
  });

  it("기존 필드가 유지된다", () => {
    for (const k of ["id", "content", "topic", "keywords", "type", "importance",
                     "isAnchor", "supersedes", "assertionStatus", "agentId", "dryRun"]) {
      assert.ok(props[k], `${k}가 사라지면 안 된다`);
    }
  });
});

const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");

describe("FragmentWriter 갱신 허용 필드", () => {
  const src = FragmentWriter.prototype._diffUpdatableFields.toString();

  it("케이스 상태 3종을 SET 절 대상으로 포함한다", () => {
    assert.ok(src.includes("resolution_status = $"), "resolution_status UPDATE 필요");
    assert.ok(src.includes("outcome = $"), "outcome UPDATE 필요");
    assert.ok(src.includes("phase = $"), "phase UPDATE 필요");
  });

  it("기존 갱신 필드가 유지된다", () => {
    for (const col of ["content", "topic", "keywords", "type", "importance",
                       "is_anchor", "assertion_status"]) {
      assert.ok(src.includes(`${col} = $`), `${col} 갱신이 사라지면 안 된다`);
    }
  });
});

describe("FragmentReader.getById 만료 조회 옵션", () => {
  it("includeExpired 미지정 시 valid_to IS NULL 조건을 유지한다", async () => {
    const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
    const src = FragmentReader.prototype.getById.toString();
    assert.ok(src.includes("valid_to IS NULL"), "기본 경로는 유효 파편만 조회해야 한다");
    assert.ok(src.includes("includeExpired"), "만료 포함 옵션이 있어야 한다");
  });
});
