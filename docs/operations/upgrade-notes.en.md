# Upgrade Notes

Use this for servers that are already installed and need to move to a new version, with the existing data and setup kept in place. First install? See the [README](../../README.en.md#how-do-i-install-it).

## Common procedure

Use this order every time. It keeps migrations ahead of the restart, which matters because the new code expects the new columns to exist.

1. Back up. `scripts/ops/backup.sh --label pre-migration`
2. Get the code.
   ```bash
   git pull origin main
   npm install
   ```
3. Run migrations before restarting. The new code uses the new columns.
   ```bash
   npm run migrate
   ```
4. Restart the service: systemd, pm2, docker, or whatever you use.

`npm run migrate` applies only migrations that have not been applied yet, in order. Same command for old versions. It reads DB connection settings from `.env`.

Most upgrades stop here. Only the cases below need extra work.

## When extra work is needed

| Situation | What to do |
|-----------|-----------|
| Update adds anchor permission, admin accounts, and body lexical search (migration-053 to 060) | [Section 1](#1-anchor-permission-admin-accounts-body-lexical-search-migration-053-to-060) |
| Update changes how duplicates are judged (migration-050) | [Section 2](#2-duplicate-scope-switch-migration-050) |
| Update introduces agent scope (migration-047) | [Section 3](#3-agent-scope-switch-migration-047) |
| You changed the embedding provider or dimension | [Section 4](#4-after-changing-the-embedding-provider-or-dimension) |
| Production DB has millions of rows | [Section 5](#5-very-large-production-databases) |

## 1. Anchor permission, admin accounts, body lexical search (migration-053 to 060)

What changes:

- Setting an anchor now requires the `anchor` permission on the key.
- Admin accounts can sign in with a password and TOTP.
- `recall` can now match words in the body text.

These migrations only add columns and tables. They do not create indexes on large tables; use `scripts/ops/online-index.mjs` to build those indexes while writes continue.

Order for an existing installation:

1. Before deploying, grant the permission to keys that use anchors.
   ```bash
   node scripts/grant-anchor-permission.js --apply
   ```
2. Before `npm run migrate`, build the `case_events(source_fragment_id)` index. See [online-migration.md](online-migration.md#migration-053--060-배포-순서) for the command.
3. Run `npm run migrate`.
4. After the migration, build the body lexical index. It finishes right away on an empty table.
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

A new server only needs step 4.

Notes:

- Body lexical search is not used by `recall` until the index in step 4 is valid.
- To use admin accounts, first set `MEMENTO_ADMIN_SEAL_KEY` in the environment. It must be 32 bytes, either base64 or 64-char hex; `openssl rand -hex 32` produces a valid value. Keep it in the server environment and in an offline copy, never in the repository or logs.
- Without admin accounts, only master-key sign-in works. Create the first owner by calling `POST /v1/internal/model/nothing/admin-users/bootstrap` with the master key.

Rollback is covered in [online-migration.md](online-migration.md#migration-053--060-배포-순서).

## 2. Duplicate scope switch (migration-050)

What changes: identical text is now judged a duplicate by key plus workspace, rather than by key alone (`MEMENTO_DEDUP_SCOPE=workspace`, the default). Workspace is part of the check.

The migration does not complete the switch by itself. The old per-key indexes remain in place, so you still need to run the finishing command.

```bash
# Without options it only prints what it would do
node scripts/ops/finish-dedup-scope.mjs

# The actual switch. Pass the target through environment variables (this script does not read .env)
PGHOST=<host> PGDATABASE=<db> PGUSER=<user> PGPASSWORD=<password> \
  node scripts/ops/finish-dedup-scope.mjs --confirm
```

To check which indexes exist now:

```sql
SELECT c.relname, i.indisvalid, i.indisready
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relnamespace = 'agent_memory'::regnamespace
   AND c.relname IN ('uq_frag_hash_per_key', 'uq_frag_hash_master',
                     'fragments_new_key_id_content_hash_idx', 'fragments_new_content_hash_idx',
                     'uq_frag_hash_ws_per_key', 'uq_frag_hash_ws_master');
```

For a large production DB, build the new index before `npm run migrate`. See the procedure and rollback notes here: [online-migration.md](online-migration.md#중복-판정-범위-전환).

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

If you change `EMBEDDING_PROVIDER` or `EMBEDDING_DIMENSIONS` in `.env`, make the vector column dimension match and regenerate embeddings for existing fragments. Keep them in sync.

```bash
EMBEDDING_DIMENSIONS=<new dimension> node scripts/post-migrate-flexible-embedding-dims.js
node scripts/backfill-embeddings.js
```

Use the same script for models above 2000 dimensions, including Gemini `gemini-embedding-001` at 3072; for switching to a local model, follow the [local embedding guide](../embedding-local.md). No separate path is needed.

## 5. Very large production databases

The migration-034 bundle runs `CREATE UNIQUE INDEX` inside a transaction. This can lock busy tables. On tables with millions of rows, run these two statements by hand before `npm run migrate` to reduce locking; if the indexes already exist, the migration skips them.

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

- To apply one file by hand: `psql $DATABASE_URL -f lib/memory/migrations/<file>`. Use `npm run migrate` when you can; it also records history and handles the opclass replacement.
- migration-046 does not exist. The gap is deliberate.
- If you added a new migration file, run `npm run lint:migrations` first. Conventions are in [migration-conventions.md](../migration-conventions.md).
- Name rollback SQL `rollback-migration-NNN-*.sql`. `migrate` only picks up `migration-*.sql`, so files with the `rollback-` prefix never run automatically.
- Optional cleanup: preview with `node scripts/cleanup-noise.js --dry-run`, then remove noise fragments with `--execute`. For old installations that need one-time embedding normalization, run `node scripts/normalize-vectors.js`.
