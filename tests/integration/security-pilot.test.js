import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const { Pool } = pg;
const ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURE_PATH = path.join(ROOT, "tests/fixtures/security-pilot.ndjson");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const DATABASE_URL = process.env.DATABASE_URL ||
  "postgresql://memento_pilot:local_security_pilot_only@127.0.0.1:35434/memento_security_pilot";
const externalNetworkAttempts = [];
const fixture = fs.readFileSync(FIXTURE_PATH, "utf8").trim().split("\n").map(line => JSON.parse(line));

let pool;
let tripwire;
let fixtureLoaded = false;
let MemoryManager;
let toolMemoryStats;
let shutdownPool;
let generateBatchEmbeddings;
let vectorToSql;

function hostFromArgs(args) {
  const [first, second] = args;
  if (typeof first === "string") {
    try { return new URL(first).hostname; } catch { return second || first; }
  }
  if (first && typeof first === "object") return first.hostname || first.host || "127.0.0.1";
  return typeof second === "string" ? second : "127.0.0.1";
}

function installNetworkTripwire() {
  const originals = [];
  const guard = (name, args) => {
    const host = String(hostFromArgs(args)).replace(/^\[|\]$/g, "").toLowerCase();
    if (!LOOPBACK_HOSTS.has(host)) {
      externalNetworkAttempts.push({ name, host });
      const error = new Error(`EXTERNAL_NETWORK_FORBIDDEN: ${host}`);
      error.code = "EXTERNAL_NETWORK_FORBIDDEN";
      throw error;
    }
  };
  const wrap = (target, name) => {
    const original = target[name];
    target[name] = function (...args) {
      guard(`${name}`, args);
      return original.apply(this, args);
    };
    originals.push(() => { target[name] = original; });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (...args) {
    guard("fetch", args);
    return originalFetch.apply(this, args);
  };
  originals.push(() => { globalThis.fetch = originalFetch; });
  for (const [target, name] of [
    [net, "connect"], [net, "createConnection"], [tls, "connect"],
    [http, "request"], [http, "get"], [https, "request"], [https, "get"]
  ]) wrap(target, name);
  const dnsNames = [
    "lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa",
    "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr",
    "resolveSoa", "resolveSrv", "resolveTxt", "reverse"
  ];
  for (const name of dnsNames) {
    const original = dns[name];
    if (typeof original === "function") {
      dns[name] = function (...args) {
        guard(`dns.${name}`, args);
        return original.apply(this, args);
      };
      originals.push(() => { dns[name] = original; });
    }
    const promiseOriginal = dns.promises[name];
    if (typeof promiseOriginal === "function") {
      dns.promises[name] = async function (...args) {
        guard(`dns.promises.${name}`, args);
        return promiseOriginal.apply(this, args);
      };
      originals.push(() => { dns.promises[name] = promiseOriginal; });
    }
  }
  for (const name of ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]) {
    const original = childProcess[name];
    childProcess[name] = function (...args) {
      externalNetworkAttempts.push({ name: `child_process.${name}`, host: null });
      const error = new Error("EXTERNAL_NETWORK_FORBIDDEN: child process");
      error.code = "EXTERNAL_NETWORK_FORBIDDEN";
      throw error;
    };
    originals.push(() => { childProcess[name] = original; });
  }
  return { restore: () => { while (originals.length) originals.pop()(); } };
}

async function queryValue(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] ? Object.values(result.rows[0])[0] : null;
}

async function queryRows(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function loadFixture() {
  const keys = fixture.filter(row => row.kind === "api_key");
  const fragments = fixture.filter(row => row.kind === "fragment");
  const embeddings = await generateBatchEmbeddings(fragments.map(row => row.content));
  await pool.query("BEGIN");
  try {
    for (const key of keys) {
      await pool.query(
        `INSERT INTO agent_memory.api_keys
           (id, name, key_hash, key_prefix, allowed_workspaces)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET allowed_workspaces = EXCLUDED.allowed_workspaces`,
        [key.id, key.name, `security-pilot-hash-${key.id.slice(-4)}`, key.id.slice(-8), key.allowed_workspaces]
      );
    }
    for (const row of fragments) {
      await pool.query(
        `INSERT INTO agent_memory.fragments
           (id, content, topic, keywords, type, content_hash, agent_id,
           key_id, workspace, session_id, case_id, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, 'default', $7, $8, $9, $10, $11::vector)
         ON CONFLICT (id) DO UPDATE SET
           content = EXCLUDED.content, topic = EXCLUDED.topic,
           keywords = EXCLUDED.keywords, key_id = EXCLUDED.key_id,
           workspace = EXCLUDED.workspace, session_id = EXCLUDED.session_id,
           case_id = EXCLUDED.case_id, embedding = EXCLUDED.embedding,
           valid_to = NULL`,
        [row.id, row.content, row.topic, [row.topic], row.type, `security-pilot-hash-${row.id.slice(-4)}`,
          row.key_id, row.workspace, row.session_id, row.case_id, vectorToSql(embeddings[fragments.indexOf(row)])]
      );
    }
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

function scopeFor(keyId, workspace) {
  return { _keyId: keyId, _groupKeyIds: [keyId], workspace };
}

async function recallWithScope(scope) {
  const manager = MemoryManager.getInstance();
  return manager.recall({
    ...scope,
    text: "Synthetic key A workspace A fact",
    includeLinks: false,
    fragmentCount: 1
  });
}

async function fragmentHistoryWithScope(id, scope) {
  const manager = MemoryManager.getInstance();
  const result = await manager.fragmentHistory({ id, ...scope });
  return result.error ? { success: false, error: result.error } : { success: true, ...result };
}

async function memoryStatsWithScope(scope) {
  return toolMemoryStats({ ...scope });
}

before(async () => {
  tripwire = installNetworkTripwire();
  pool = new Pool({ connectionString: DATABASE_URL, host: "127.0.0.1", port: 35434 });
  await pool.query("SELECT 1");
  const { env: transformersEnv } = await import("@huggingface/transformers");
  const snapshot = process.env.SECURITY_PILOT_MODEL_SNAPSHOT;
  assert.ok(snapshot, "security pilot model snapshot must be selected by the runner");
  assert.ok(
    fs.existsSync(path.join(snapshot, "onnx/model_quantized.onnx")) ||
      fs.existsSync(path.join(snapshot, "onnx/model_q8.onnx")),
    "security pilot requires the local q8 ONNX model"
  );
  transformersEnv.cacheDir = process.env.SECURITY_PILOT_MODEL_CACHE
    ? path.dirname(process.env.SECURITY_PILOT_MODEL_CACHE)
    : path.dirname(path.dirname(path.dirname(snapshot)));
  transformersEnv.localModelPath = snapshot;
  transformersEnv.allowLocalModels = true;
  transformersEnv.allowRemoteModels = false;
  process.env.EMBEDDING_MODEL = snapshot;
  await import("../../lib/memory/MemoryManager.js").then(module => { MemoryManager = module.MemoryManager; });
  ({ tool_memoryStats: toolMemoryStats } = await import("../../lib/tools/memory.js"));
  ({ shutdownPool } = await import("../../lib/tools/db.js"));
  ({ generateBatchEmbeddings, vectorToSql } = await import("../../lib/tools/embedding.js"));
  await loadFixture();
  fixtureLoaded = true;
});

after(async () => {
  try {
    if (pool) {
      if (fixtureLoaded) {
        await pool.query("DELETE FROM agent_memory.fragments WHERE topic = $1", ["security-pilot-synthetic"]);
        await pool.query("DELETE FROM agent_memory.api_keys WHERE id = ANY($1::text[])", [
          fixture.filter(row => row.kind === "api_key").map(row => row.id)
        ]);
      }
      await pool.end();
    }
    await shutdownPool?.();
  } finally {
    tripwire?.restore();
    console.log(`[security-pilot] external_network_attempts=${externalNetworkAttempts.length}`);
  }
});

test("pilot database is the dedicated pgvector database", async () => {
  assert.equal(await queryValue("SELECT current_database()"), "memento_security_pilot");
  assert.equal(await queryValue("SELECT extname FROM pg_extension WHERE extname = 'vector'"), "vector");
  assert.equal(await queryValue(
    "SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a " +
      "JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE n.nspname = 'agent_memory' AND c.relname = 'fragments' AND a.attname = 'embedding'"
  ), "vector(384)");
  assert.equal(await queryValue(
    "SELECT count(*) FROM agent_memory.fragments WHERE topic = $1 AND embedding IS NOT NULL",
    ["security-pilot-synthetic"]
  ), "3");
});

test("NDJSON fixture readback contains exactly the synthetic key/workspace rows", async () => {
  const rows = await queryRows(
    "SELECT key_id, workspace FROM agent_memory.fragments WHERE topic = $1 ORDER BY key_id, workspace",
    ["security-pilot-synthetic"]
  );
  const expected = fixture.filter(row => row.kind === "fragment")
    .map(row => ({ key_id: row.key_id, workspace: row.workspace }))
    .sort((left, right) => `${left.key_id}|${left.workspace}`.localeCompare(`${right.key_id}|${right.workspace}`));
  assert.deepEqual(rows, expected);
});

test("real PostgreSQL recall scope excludes the other key and workspace", async () => {
  const result = await recallWithScope(scopeFor(
    "00000000-0000-0000-0000-00000000aaaa", "pilot-ws-a"
  ));
  assert.deepEqual(result.fragments.map(row => row.id), ["10000000-0000-0000-0000-00000000aaaa"]);
});

test("real PostgreSQL history and stats stay within the requested scope", async () => {
  const scope = scopeFor("00000000-0000-0000-0000-00000000aaaa", "pilot-ws-a");
  const history = await fragmentHistoryWithScope("10000000-0000-0000-0000-00000000aaab", scope);
  assert.equal(history.success, false);
  const stats = await memoryStatsWithScope(scope);
  assert.equal(stats.stats.total, 1);
});

test("automation remains off and no link/consolidation/GC side effect occurs", async () => {
  assert.equal(process.env.MEMENTO_SECURITY_PILOT_AUTOMATION, "off");
  assert.equal(process.env.MEMENTO_AUTO_REFLECT, "false");
  assert.equal(process.env.MEMENTO_GRAPH_LINK, "false");
  assert.equal(process.env.MEMENTO_CONSOLIDATE, "false");
  assert.equal(process.env.MEMENTO_GC, "false");
  assert.equal(await queryValue("SELECT count(*) FROM agent_memory.fragment_links"), "0");
  assert.equal(await queryValue("SELECT count(*) FROM agent_memory.fragments WHERE topic = 'session_reflect'"), "0");
});

test("pilot external egress remains zero", async () => {
  assert.deepEqual(externalNetworkAttempts.filter(attempt => !LOOPBACK_HOSTS.has(attempt.host)), []);
});
