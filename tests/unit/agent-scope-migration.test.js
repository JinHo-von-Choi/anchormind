import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(path.join(
  here, "../../lib/memory/migrations/migration-046-agent-scope-audit.sql"
), "utf8");
const schema = readFileSync(path.join(here, "../../lib/memory/memory-schema.sql"), "utf8");

describe("migration-046 fragment version scope", () => {
  it("nullable snapshot 컬럼만 추가하여 구버전 writer와 롤링 호환된다", () => {
    assert.match(migration, /ALTER TABLE agent_memory\.fragment_versions[\s\S]*ADD COLUMN IF NOT EXISTS agent_id[\s\S]*ADD COLUMN IF NOT EXISTS workspace/);
    assert.doesNotMatch(migration, /UPDATE agent_memory\.fragment_versions/);
    assert.doesNotMatch(migration, /ALTER COLUMN agent_id SET NOT NULL/);
  });

  it("private history를 shared로 오분류할 DEFAULT를 두지 않고 workspace NULL은 허용한다", () => {
    const ddl = migration.replace(/--.*$/gm, "");
    const versions = schema.match(/CREATE TABLE IF NOT EXISTS agent_memory\.fragment_versions \([\s\S]*?\n\);/)?.[0] ?? "";
    assert.doesNotMatch(ddl, /ALTER COLUMN agent_id SET DEFAULT/);
    assert.doesNotMatch(ddl, /ALTER COLUMN workspace SET NOT NULL/);
    assert.match(versions, /agent_id\s+TEXT/);
    assert.doesNotMatch(versions, /agent_id[^\n]*NOT NULL/);
    assert.doesNotMatch(versions, /agent_id[^\n]*DEFAULT/);
  });

  it("legacy case event 컬럼은 migration 소유이고 backfill은 별도 배치로 분리한다", () => {
    assert.match(migration, /ALTER TABLE agent_memory\.case_events[\s\S]*ADD COLUMN IF NOT EXISTS agent_id[\s\S]*ADD COLUMN IF NOT EXISTS workspace/);
    assert.doesNotMatch(migration, /UPDATE agent_memory\.case_events/);
    const caseAlters = [...migration.matchAll(/ALTER TABLE agent_memory\.case_events[\s\S]*?;/g)]
      .map(match => match[0]).join("\n");
    assert.doesNotMatch(caseAlters, /ALTER COLUMN agent_id SET NOT NULL/);
    assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS agent_memory\.case_events/);
  });
});
