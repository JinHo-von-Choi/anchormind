/**
 * 외부 전송 정책 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * migration-055가 만든 api_keys.egress_policy 열에서 정책 편집과 조회의 왕복, 열이 없는 설치에서의
 * 조회와 다른 정책 열 편집, 외부 전송 관문의 감사 이벤트가 outbox_events에 본문 없이 남는지 본다.
 * 실행마다 전용 데이터베이스를 만들어 쓰고 끝나면 지운다. 외부 제공자는 호출하지 않는다(관문의
 * prepare까지만 부른다).
 */
import crypto                  from "node:crypto";
import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";

const { prepareLaneDatabase, dropLaneDatabase, directQuery } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }  = await import("../../lib/tools/db.js");
const {
  getEgressPolicy,
  invalidateEgressPolicyCache,
  updateKeyPolicy
}                       = await import("../../lib/admin/ApiKeyStore.js");
const { openEgressGate, EGRESS_AUDIT_TOPIC } = await import("../../lib/llm/EgressGate.js");
const { EgressSkippedError }                 = await import("../../lib/llm/EgressPolicy.js");

/** 시험용 키 한 개를 만든다. */
async function createKey() {
  const tag      = crypto.randomBytes(4).toString("hex");
  const { rows } = await directQuery(
    `INSERT INTO agent_memory.api_keys (name, key_hash, key_prefix, permissions)
     VALUES ($1, $2, $3, '{read,write}') RETURNING id`,
    [`egress-${tag}`, `hash-${tag}`, `mmcp_${tag}`]
  );
  return rows[0].id;
}

after(async () => {
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("api_keys.egress_policy 왕복", () => {
  it("migration-055가 jsonb 열을 만든다", async () => {
    const { rows } = await directQuery(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'agent_memory' AND table_name = 'api_keys' AND column_name = 'egress_policy'`);
    assert.deepEqual(rows, [{ data_type: "jsonb", is_nullable: "YES" }]);
  });

  it("편집한 정책을 그대로 읽고, 다른 열 편집은 정책 열을 건드리지 않는다", async () => {
    const keyId  = await createKey();
    const policy = { local_only: false, approved_providers: ["codex-cli"], workspaces: { closed: { local_only: true } } };
    assert.equal(await getEgressPolicy(keyId), null);

    const result = await updateKeyPolicy(keyId, { egress_policy: policy });
    assert.equal(result.before.egress_policy, null);
    assert.deepEqual(result.after.egress_policy, policy);
    invalidateEgressPolicyCache(keyId);
    assert.deepEqual(await getEgressPolicy(keyId), policy);

    const other = await updateKeyPolicy(keyId, { symbolic_hard_gate: true });
    assert.equal(Object.hasOwn(other.after, "egress_policy"), false);
    const { rows } = await directQuery(`SELECT egress_policy FROM agent_memory.api_keys WHERE id = $1`, [keyId]);
    assert.deepEqual(rows[0].egress_policy, policy);

    await updateKeyPolicy(keyId, { egress_policy: null });
    invalidateEgressPolicyCache(keyId);
    assert.equal(await getEgressPolicy(keyId), null);
  });

  it("local_only 키는 외부 제공자를 거르고 단계를 건너뛴다", async () => {
    const keyId = await createKey();
    await updateKeyPolicy(keyId, { egress_policy: { local_only: true } });
    invalidateEgressPolicyCache(keyId);
    const gate = await openEgressGate({ stage: "split", keyId });
    assert.throws(() => gate.filter([{ name: "codex-cli" }]), EgressSkippedError);
    assert.deepEqual(gate.filter([{ name: "codex-cli" }, { name: "ollama", baseUrl: "http://127.0.0.1:11434" }]).map(p => p.name), ["ollama"]);
  });

  it("외부 제공자로 보내기 전에 본문 없는 감사 이벤트를 outbox에 남긴다", async () => {
    const keyId  = await createKey();
    const gate   = await openEgressGate({ stage: "evaluate", keyId, workspace: "team" });
    const secret = "ghp_" + "e".repeat(36);
    const sent   = await gate.prepare({ name: "codex-cli" }, `본문 ${secret}`, { systemPrompt: "s" });
    assert.ok(!sent.prompt.includes(secret));

    const { rows } = await directQuery(
      `SELECT aggregate_id, payload FROM agent_memory.outbox_events WHERE topic = $1 AND aggregate_id = $2`,
      [EGRESS_AUDIT_TOPIC, keyId]);
    assert.equal(rows.length, 1);
    const { payload } = rows[0];
    assert.equal(payload.key_id, keyId);
    assert.equal(payload.stage, "evaluate");
    assert.equal(payload.provider, "codex-cli");
    assert.equal(payload.provider_class, "external");
    assert.deepEqual(payload.workspaces, ["team"]);
    assert.equal(payload.bytes, Buffer.byteLength(sent.prompt) + 1);
    assert.ok(!JSON.stringify(payload).includes("본문"));
  });
});

describe("egress_policy 열이 없는 설치", () => {
  it("조회는 null이고 다른 정책 열 편집은 동작하며 정책 편집은 42703이다", async () => {
    const keyId = await createKey();
    await directQuery(`ALTER TABLE agent_memory.api_keys DROP COLUMN egress_policy`);
    try {
      invalidateEgressPolicyCache(keyId);
      assert.equal(await getEgressPolicy(keyId), null);
      const result = await updateKeyPolicy(keyId, { symbolic_hard_gate: true });
      assert.equal(result.after.symbolic_hard_gate, true);
      await assert.rejects(updateKeyPolicy(keyId, { egress_policy: { local_only: true } }), { code: "42703" });
    } finally {
      await directQuery(`ALTER TABLE agent_memory.api_keys ADD COLUMN IF NOT EXISTS egress_policy JSONB`);
    }
  });
});
