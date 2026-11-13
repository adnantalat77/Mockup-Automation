# Task 022: operational resilience and backup recovery

## Persistent data inventory

The configured data directory contains garment source bytes and provenance metadata, background bytes, generated previews, batch JSON, append-only publication checkpoints, generated Shopify media ownership evidence, rollback/finalization evidence, and restoration markers. Shopify credentials and feature/allowlist configuration remain environment-owned and are not copied into data backups. Operator-selected backup directories remain outside the live data root.

The audit found direct two-file asset writes, in-place batch overwrite, silent malformed-batch discard, missing asset hash enforcement, and checkpoint writes without a content flush. An interrupted asset metadata write could leave orphan bytes; an interrupted batch overwrite could erase its previous valid state; malformed batch metadata could look like an empty history. Publication intent ordering was already fail-closed, but its temporary checkpoint needed an explicit file flush.

## Durability and failure behavior

Critical writes now use a unique temporary file in the destination directory, write and flush the complete content, and rename it into place. On Windows, direct replacement may be denied while a destination exists; the fallback moves the prior batch record to a uniquely named replacement backup, promotes the flushed temporary file, and restores the prior record if promotion fails. If the process stops inside that replacement window, batch startup restores the preserved prior record whenever the destination is absent. If a destination exists, the uncertain backup is preserved rather than automatically deleted. Windows does not provide a portable Node directory-fsync guarantee, so file content is flushed but post-rename directory durability remains filesystem-dependent. This limitation is surfaced rather than represented as cross-system atomicity.

Asset metadata is published only after bytes are durably stored. Metadata failure returns no asset reference; orphan bytes are not treated as usable evidence or automatically deleted. Asset reads validate identity and recorded SHA-256. Missing, unreadable, or mismatched bytes fail explicitly. Batch startup rejects malformed metadata instead of silently discarding it. Batch replacement preserves the previous record until the new content is complete. Publication checkpoints retain unique append-only filenames and now use the same flushed temporary-write primitive.

Publication checkpoint persistence builds a separate durable snapshot and updates `operation.updatedAt` plus the in-memory durable record only after promotion succeeds. Any checkpoint write, flush, or rename failure places that product in a process-local persistence-blocked set. Every subsequent mutation intent and every publication, resume, rollback, abandonment, or finalization entry point rejects until process restart and Task 021 reconciliation. A failed result checkpoint therefore cannot silently advance to another Shopify mutation. Restart reloads only the last complete checkpoint, whose pending intent drives established reconciliation. Terminal state is not exposed through the durable record until its terminal checkpoint succeeds.

`ENOSPC`, `EACCES`, `EPERM`, rename failure, unreadable metadata, missing bytes, and hash mismatch are surfaced as structured persistence failures. The API returns HTTP 507 for disk-full and a non-success response for other persistence failures. No Shopify mutation can follow a failed publication intent checkpoint.

## Operator-controlled backup and restoration

Backup operations are offline CLI operations and acquire the same canonical data-directory lock as the API. They fail if the API or another backup/restore process owns the directory. They never expose an HTTP restoration endpoint.

From the repository root:

```powershell
npx tsx apps/api/src/backup-cli.ts create "C:\path\to\data" "D:\Mockup Backups\2026-11-13"
npx tsx apps/api/src/backup-cli.ts validate "D:\Mockup Backups\2026-11-13"
npx tsx apps/api/src/backup-cli.ts restore "C:\path\to\data" "D:\Mockup Backups\2026-11-13" RESTORE_VALIDATED_BACKUP
```

Creation copies a stable, exclusively owned data tree, records every relative path, byte length, and SHA-256 in `manifest.json`, validates the completed staging tree, and then publishes the backup directory. Validation rejects missing, extra, duplicate, hash-mismatched, or path-traversing entries.

Restoration validates the backup before touching live data, copies it to a sibling staging directory, validates the staged copy, and writes `RESTORED_FROM_BACKUP.json` into staging before any live rename. It also durably writes a sibling restoration transaction journal naming the live, previous, and staged paths. It then renames the current live directory to a timestamped `pre-restore` recovery directory and promotes the already-marked staging tree. Promotion failure restores the prior directory. A crash before promotion leaves the prior data and marked staging path recorded in the journal; a crash after promotion leaves the live restored tree already marked. Both another restore and normal API runtime startup check for that journal and fail before mutable initialization, preventing an empty replacement data directory from being mistaken for clean state. The previous live directory is never automatically deleted.

A restore is only local filesystem recovery. It cannot prove that Shopify still matches the restored checkpoint. The API actively checks the marker and blocks fresh publication, resume, rollback, abandonment, and retained-file finalization before any Shopify read or mutation. Marker clearing is intentionally not implemented in Task 022: startup, a partial readback, or operator confirmation cannot clear it. The controlled procedure is to stop the API, preserve the restored tree and its `pre-restore` predecessor, independently compare every restored operation and affected product against complete live Shopify state, and only remove the marker in a separately reviewed recovery action. Until that procedure exists, restored data remains mutation-blocked. Existing allowlist, confirmation, exact variant/media, source freshness, no-global-delete, and checkpoint-integrity checks remain necessary but are not themselves sufficient to clear the marker. No operation resumes automatically after restoration.

## Trusted source refresh

The application currently has one independently verifiable authority channel: a transparent Shopify media source that is presently attached to the exact product and reliably associated with every variant of exactly one color. Downloaded bytes are decoded, alpha-validated, SHA-256 recorded, and bound to product, color, MediaImage ID, source reference, dimensions, acquisition time, and validation time. A new batch and preview are mandatory, and publication redownloads and rechecks that same current source.

Historical preserved bytes remain `historical_unverified`; generated previews are never sources. Wrong product/color mapping, changed hashes, detached media, ambiguous media, opaque bytes, and missing authority remain blocked.

The repeat-background-replacement HIGH limitation is **not resolved** when a full-gallery publication removes the only supplier-canonical transparent media. This repository has no independently authenticated supplier registry, signed source manifest, or supplier API against which a detached local file can be verified. Operator approval alone would not establish supplier authority, so Task 022 deliberately does not add a bypass. The missing dependency is an independently maintained, product/color/version-bound canonical source channel. Until provided, the safe workflow is to keep publication blocked or restore a currently attached, reliably associated canonical source through a separately governed Shopify process. This must be resolved by Task 023 at the latest.

## Fault-injection coverage and limitations

Tests inject disk-full and permission failures, metadata failure after asset bytes, missing and hash-mismatched assets, corrupt batch metadata, backup hash mismatch, path traversal, active-owner restoration rejection, and successful restore with prior-state preservation. Existing Task 019–021 suites continue to cover image decoding, source changes, stale previews, checkpoint interruption, restored-state reconciliation, and mutation uncertainty.

Remaining limitations include Windows directory metadata flush portability, lack of cryptographic authentication for a backup manifest against a malicious local administrator, and no cross-system transaction with Shopify. Backups must be stored on independently protected media and restoration must be followed by live reconciliation. This work does not establish production readiness.
