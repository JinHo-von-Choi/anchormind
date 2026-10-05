# Upgrade Notes

For servers that are already installed and need to move to a new version. For a first install, see the [README](../../README.en.md#how-do-i-install-it).

## Common procedure

Every upgrade follows the same order.

1. Back up. `scripts/ops/backup.sh --label pre-migration`
2. Get the code.
   ```bash
   git pull origin main
   npm install
   ```
3. Apply migrations first, before restarting. The new code uses the new columns.
   ```bash
   npm run migrate
   ```
4. Restart the service (systemd, pm2, docker, whatever you use).

`npm run migrate` applies only the migrations not yet applied, in order. The command is the same when upgrading from an old version. It reads DB connection settings from `.env`.

Most upgrades end here. Only the cases below need extra work.

## When extra work is needed

| Situation | What to do |
|-----------|-----------|
| Update that adds anchor permission, admin accounts and body lexical search (migration-053 to 060) | [Section 1](#1-anchor-permission-admin-accounts-body-lexical-search-migration-053-to-060) |
| Update that changes how duplicates are judged (migration-050) | [Section 2](#2-duplicate-scope-switch-migration-050) |
| Update that introduces agent scope (migration-047) | [Section 3](#3-agent-scope-switch-migration-047) |
| You changed the embedding provider or dimension | [Section 4](#4-after-changing-the-embedding-provider-or-dimension) |
| Production DB with millions of rows | [Section 5](#5-very-large-production-databases) |

## 1. Anchor permission, admin accounts, body lexical search (migration-053 to 060)

What changes:

- Setting an anchor requires the `anchor` permission on the key.
- Admin accounts that sign in with a password and TOTP are added.
- `recall` gains a search path that matches words in the body text.

These migrations only add columns and tables. Indexes on large tables are not created by the migration; `scripts/ops/online-index.mjs` builds them without blocking writes.

Order for an existing installation:

1. Before deploying, grant the permission to keys that use anchors.
   ```bash
   node scripts/grant-anchor-permission.js --apply
   ```
2. Before `npm run migrate`, build the `case_events(source_fragment_id)` index. The command is in [online-migration.md](online-migration.md#migration-053--060-배포-순서).
3. Run `npm run migrate`.
4. After the migration, build the body lexical index. On an empty table it finishes immediately.
   ```bash
   node scripts/ops/online-index.mjs --dry-run --index idx_fragments_content_tokens
   PGHOST=<host> PGDATABASE=<db> PGUSER=<user> PGPASSWORD=<password> \
     node scripts/ops/online-index.mjs --confirm --index idx_fragments_content_tokens --data-dir <data directory>
   ```
5. Fill in tokens and key secrets for existing fragments.
   ```bash
   node scripts/backfill-content-tokens.mjs --confirm
   node scripts/ops/backfill-key-secrets.mjs --confirm
   ```

A newly installed server only needs step 4.

Notes:

- Until the index in step 4 is valid, body lexical search does not take part in `recall`.
- To use admin accounts, first set the environment variable `MEMENTO_ADMIN_SEAL_KEY` (32 bytes, base64 or 64-char hex). The output of `openssl rand -hex 32` works. Keep it only in the server environment and an offline copy, never in the repository or logs.
- Without admin accounts only master-key sign-in works. Create the first owner by calling `POST /v1/internal/model/nothing/admin-users/bootstrap` with the master key.

Rollback is described in [online-migration.md](online-migration.md#migration-053--060-배포-순서).

## 2. Duplicate scope switch (migration-050)

What changes: identical text is now judged a duplicate per key and workspace instead of per key (`MEMENTO_DEDUP_SCOPE=workspace`, the default).

The migration alone does not finish the switch. The per-key indexes are still there, so a finishing command is needed.

```bash
# Without options it only prints what it would do
node scripts/ops/finish-dedup-scope.mjs

# The actual switch. Pass the target through environment variables (this script does not read .env)
PGHOST=<host> PGDATABASE=<db> PGUSER=<user> PGPASSWORD=<password> \
  node scripts/ops/finish-dedup-scope.mjs --confirm
```

To see which indexes currently exist:

```sql
SELECT c.relname, i.indisvalid, i.indisready
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relnamespace = 'agent_memory'::regnamespace
   AND c.relname IN ('uq_frag_hash_per_key', 'uq_frag_hash_master',
                     'fragments_new_key_id_content_hash_idx', 'fragments_new_content_hash_idx',
                     'uq_frag_hash_ws_per_key', 'uq_frag_hash_ws_master');
```

On a large production DB, build the new index before `npm run migrate`. Procedure and rollback: [online-migration.md](online-migration.md#중복-판정-범위-전환).

## 3. Agent scope switch (migration-047)

### Concept

- An `agentId` of `default`, or none, is shared memory for the same key and workspace.
- Any other value is memory only that agent sees.
- Ordinary clients should omit `agentId` or use `default`.
- `includePeerAgents=true`, which also shows other agents' memory, is master-key only.

### Existing clients keep working for now

`MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE` defaults to `true`, so clients that already use a non-`default` `agentId` keep working. Each use writes a warning log and increments `mcp_legacy_unbound_agent_scope_total`.

In this mode agents that share one API key cannot be told apart. After migrating your clients, once that counter stops growing, set it to `false` in `.env` to switch to strict mode.

### Upgrade order

1. Apply migration-047 (adds nullable columns).
2. Deploy the new code to every instance and confirm the old code no longer writes.
3. Count the work first.
   ```bash
   memento-mcp anchor-scope --backfill-snapshots
   ```
4. Run the backfill.
   ```bash
   memento-mcp anchor-scope --backfill-snapshots --execute --approve-backfill
   ```

Both `fragment_versions` and `case_events` need this, and `migrate` warns about what remains.

Until it is done, existing change history may look empty. It processes up to 1,000 batches per run, and `--batch-size` is 1 to 10,000 (default 500). If it hits the limit it exits with the committed count, so run the same command again to continue.

Rows whose source is missing or deleted stay quarantined. If any exist the run fails with `SNAPSHOT_BACKFILL_INCOMPLETE` and reports `sourceMissing` and `sourceDeleted` counts. Re-running does not recover them; an administrator has to review them.

### To move existing anchors into the shared scope

1. Preview: `memento-mcp anchor-scope --classifications <file>`. Add `--include-non-anchors` to include ordinary fragments.
2. Execute: prepare an approval JSON with a `shared` list, then pass `--execute --approve-shared`. Items classified `private` or `unconfirmed` are not changed.

### Cautions

- Old sessions must reconnect and run `initialize` again. Old sessions without an authorization header may fail with `-32001`.
- Normalization moves the agent value of fragments and version records in one transaction. Rolling back the migration does not undo normalization. Keep a separate backup if you may need to revert.

## 4. After changing the embedding provider or dimension

If you change `EMBEDDING_PROVIDER` or `EMBEDDING_DIMENSIONS` in `.env`, align the vector column dimension and regenerate embeddings for existing fragments.

```bash
EMBEDDING_DIMENSIONS=<new dimension> node scripts/post-migrate-flexible-embedding-dims.js
node scripts/backfill-embeddings.js
```

Models above 2000 dimensions (for example Gemini `gemini-embedding-001`, 3072) use the same script. The full procedure for switching to a local model is in the [local embedding guide](../embedding-local.md).

## 5. Very large production databases

The migration-034 bundle runs `CREATE UNIQUE INDEX` inside a transaction. On tables with millions of rows, run these two statements by hand before `npm run migrate` to reduce locking. If they already exist the migration skips them.

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_tenant
  ON agent_memory.fragments (key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_master
  ON agent_memory.fragments (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NULL;
```

To confirm, run `\d agent_memory.fragments` in psql and check that both indexes appear.

## Working with migration files directly

- To apply a single file by hand: `psql $DATABASE_URL -f lib/memory/migrations/<file>`. Prefer `npm run migrate`, which also records history and handles the opclass replacement.
- migration-046 does not exist (a deliberate gap).
- If you added a new migration file, run `npm run lint:migrations` first. Conventions: [migration-conventions.md](../migration-conventions.md).
- Name rollback SQL `rollback-migration-NNN-*.sql`. `migrate` only picks up `migration-*.sql`, so files with the `rollback-` prefix are never run automatically.
- Optional cleanup: preview with `node scripts/cleanup-noise.js --dry-run`, then remove noise fragments with `--execute`. If an old installation needs a one-time embedding normalization, run `node scripts/normalize-vectors.js`.
