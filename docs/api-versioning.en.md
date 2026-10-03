# API and Export Format Version Policy

Author: 최진호
Date: 2026-10-03

This document states how the surfaces the server exposes (MCP protocol, tool schemas, admin REST API, database schema, export files) stay compatible across versions. The Korean edition is [api-versioning.md](api-versioning.md).

## Scope

| Surface | Version marker | Compatibility rule |
|-|-|-|
| MCP protocol | Specification revision date (for example `2025-11-25`) | The supported revisions are listed in `lib/protocol-versions.js`. A revision is removed only after the MCP specification's deprecation ledger marks it deprecated |
| Tool schemas | Major version in `package.json` | Additions only within one major version |
| Admin REST API | Major version in `package.json` | An incompatible change goes through a `Deprecation` header and a 6 month window |
| Database schema | Migration number | Expand then contract. The expand step is compatible with the previous server version (N-1) |
| Export files | Format version (integer) | Reading keeps the current version and the one before it |

## MCP protocol

When the revision a client proposes in `initialize` is in the supported list, that revision is negotiated. Otherwise the newest supported revision at or below the proposed value is used, and when there is none, the oldest listed revision. The result is always one entry of the supported list. Adding a revision to the list is a backward compatible change; a revision leaves the list only when the specification's deprecation ledger lists it.

## Tool schemas

Allowed within one major version:

- adding an optional parameter
- adding a response field
- adding a tool
- clarifying descriptions

Only in the next major version:

- adding a required parameter
- removing, renaming or changing the meaning of a parameter or response field
- renaming or removing a tool

Readers of a response must ignore fields they do not know.

## Admin REST API

Paths are `/v1/internal/model/nothing/...`. Adding a field or an optional parameter needs no window. A change that breaks existing callers (removing a response field, changing its meaning, adding a required parameter) follows this procedure.

1. The old behavior stays for at least 6 months from the announcement date.
2. During that period affected responses carry a `Deprecation` header and the removal date in a `Sunset` header.
3. The old behavior is removed in the first major version after the window ends.

Exception: when a caller names a lower export format version with `format_version` or `Accept`, the response has that version's structure, so columns missing from the lower version are the requested format and not a compatibility break (see "Negotiation and downgrade" below).

## Database schema

Migrations are split into expand and contract.

| Step | Allowed changes | Condition |
|-|-|-|
| Expand | nullable column, new table, new index, NOT VALID constraint | The previous server version (N-1) keeps working unchanged. Applied within one release |
| Contract | dropping a column, tightening a constraint, dropping a table | Only when every server runs a version that includes the expand step, in a release other than the one that added it |

File conventions and the index procedure for large tables follow [Migration Conventions](migration-conventions.md) and [Online Migration](operations/online-migration.md).

## Export file format

### Versions

| Version | Structure | Read | Write |
|-|-|-|-|
| 2 | header line, fragment lines, link lines, optional version lines, end line | yes | default |
| 1 | fragment lines without a header, 17 columns | yes. Reading is not removed before 2027-10-03 | on request |

Reading keeps the current version and the one before it. When a new format version appears, reading of the version two steps back may be removed, and the date in this table is updated and announced before it is. A header with a version that cannot be read is rejected before anything is written (admin API: 400 `unsupported_format_version`, CLI: exit code 1).

Importing a version 1 file adds `deprecated: true` and `accepted_until` to `format` in the response.

### Version 2 records

One line is one record and the `record` field names its kind. An object without `record` is read as a fragment (a version 1 line).

| record | Content |
|-|-|
| `header` | `format` (`memento-fragments`), `version`, `schema_migration` (last migration number of the exporting server), `exported_at`, `scope` (export filters), `includes` (record kinds present) |
| `fragment` | All fragment columns (list below) |
| `link` | `from_id`, `to_id`, `relation_type`, `created_at`, `weight`, `confidence`, `decay_rate`, `quarantine_state`. Only links that are not deleted and whose two ends are both exported fragments |
| `version` | Fragment amendment history (`fragment_versions`). Present only when requested |
| `end` | `counts`: lines per kind. Import compares it with what it read to report a truncated file |

Fragment columns: `id`, `content`, `content_hash`, `topic`, `type`, `keywords`, `importance`, `source`, `agent_id`, `key_id`, `is_anchor`, `ttl_tier`, `estimated_tokens`, `created_at`, `valid_from`, `valid_to`, `accessed_at`, `access_count`, `verified_at`, `utility_score`, `case_id`, `goal`, `outcome`, `phase`, `resolution_status`, `assertion_status`, `context_summary`, `session_id`, `workspace`, `workspace_source`, `idempotency_key`, `affect`, `validation_warnings`, `quality_verified`, `quality_rationale`.

Columns that are not written: `embedding` (the target server rebuilds it), `linked_to` (rebuilt from the link lines), `ema_activation`, `ema_last_updated`, `last_decay_at`, `morpheme_indexed`, `split_attempt_failed_at`, `workspace_inferred`, `inference_confidence`, `backfill_batch_id` (server internal state). Rows closed by expiry (rows with `valid_to`) are not exported.

### Negotiation and downgrade

The export format version is chosen in this order.

1. An explicit value: admin API `format_version` query parameter, CLI `--format-version`
2. The `version` parameter of the `Accept` header (for example `application/x-ndjson; version=1`)
3. The current version

A version that cannot be produced gets 406 with the supported list from the admin API and exit code 1 from the CLI. The response carries `X-Memento-Export-Format-Version` with the actual version and `Vary: Accept`.

Choosing a lower version (downgrade) exports in that version's structure. Version 1 carries the 17 fragment columns only: no header line, end line, links, history, `key_id`, `workspace`, `context_summary` or `content_hash`. A downgraded file does not regain the dropped information. A file of a higher version is rejected by a server that reads only lower versions; within one version unknown fields are ignored.

### Import rules

| Item | Rule |
|-|-|
| Target key | The caller chooses the key to write (admin API `key_id` query parameter, CLI `--key`). Without it the scope is master (`key_id` NULL). The `key_id` of a file row is never read; ignored values are counted in `ignored.key_id` |
| Anchor | `is_anchor` follows the file only on the owner path (admin API, CLI on the server host). Other paths ignore it and count it in `ignored.is_anchor` |
| Write gate | Every fragment line goes through the semantic write gate (secret masking, storage length cut, minimum quality, policy decision, workspace permission) before it is written |
| Normal import | The gate may change or reject content. Rows it changed are counted in `transformed`. importance gets the per-type cap and `ttl_tier` is `warm` |
| Restore (`restore=trusted`, `--restore`) | Owner path only, format version 2 files only. Skips the minimum quality check and the storage length cut and writes `importance`, `ttl_tier` and `workspace_source` as in the file. Secret masking still applies while `MEMENTO_WRITE_GATE` is on (when it is off, import lines have no gate steps and content is neither trimmed nor masked). `quality_verified` and `quality_rationale` of the file are restored too. Content is trimmed at both ends, so it is not byte exact. Whether the run completes, aborts or stops on an error, the admin API and the CLI write one audit log line (`outcome`: completed, aborted, failed, plus the counts so far) |
| Timestamps | `created_at` and `valid_from` use the file value. A value that cannot be parsed or lies after tomorrow is ignored and the server time is used |
| Per column handling | Columns that follow the file: `id`, `content` (after the gate rules), `topic`, `type`, `keywords` (lowercased), `importance` (per-type cap on normal import), `source`, `agent_id`, `is_anchor` (owner path), `ttl_tier` (`warm` on normal import), `created_at`, `valid_from`, `case_id`, `goal`, `outcome`, `phase`, `resolution_status`, `assertion_status`, `context_summary`, `session_id` (when a string), `workspace`, `workspace_source` (on normal import `explicit` when `workspace` is set, otherwise `unscoped`), `idempotency_key`, `affect`. Recomputed columns: `content_hash`, `estimated_tokens`, `validation_warnings` (decided by the gate; the file value is not trusted). Column chosen by the target: `key_id`. Columns that follow the file only in restore: `quality_verified`, `quality_rationale` (left empty on normal import). Columns that take the server value at import time: `access_count`, `accessed_at`, `verified_at`, `utility_score`. Column not imported: `valid_to` (closed rows are not exported). Embeddings are rebuilt (the admin API queues them) and `linked_to` is rebuilt from the link lines |
| Order | Links and versions must follow the fragment lines. A link is written only when both end fragments were handled in the same run |
| dryRun | Runs the same path and rolls the transaction back at the end. The counts equal those of a real run and no gate metrics are recorded. It is one transaction, so it holds the locks of the rows it wrote until it ends; run it when no other work writes the same fragments and split files into about 5000 fragment lines each |
| Duplicates and conflicts | Content that is already stored is a duplicate. The same id with different content is rejected as `id_conflict`. When the same row is imported concurrently the row is checked once more and counted as a duplicate when the content is the same. `--idempotent` counts only the same id within the same key as a duplicate; an id owned by another key is `id_conflict`. An `idempotency_key` used by another row is rejected as `idempotency_conflict` |
| Unrecognizable input | Input with no header line, no end line, and only lines that are not JSON or not records is refused without writing anything (admin API 400 `no_valid_records`, CLI exit code 1) |

Counts are imported (newly written), duplicates (same content already stored), rejected (typed reason) and errors (failures that are not about the row); a row falls in exactly one. The response format is in the import section of the [API reference](api-reference.en.md).

### Round trip property

A row that already satisfies the storage rules (masking, per-type length cap, minimum quality) keeps its `content_hash` and links when exported and imported into an empty database, and among all exported columns every column keeps its value except the recomputed column (`validation_warnings`), the columns that take server values (`access_count`, `accessed_at`, `verified_at`, `utility_score`) and the restore-only columns (`quality_verified`, `quality_rationale`) listed under "Per column handling". Restore keeps the restore-only columns too. Normal import reports rows that do not satisfy them (existing rows over the length cap or under the minimum quality, rows hit by the per-type importance cap) as `transformed` (reasons `content`, `importance`) or `rejected`. When such rows must be restored as stored, use restore on the owner path.
