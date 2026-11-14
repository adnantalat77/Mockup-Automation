# Task 023 engineering stabilization

**Engineering result: PASS, pending independent review.** This result covers the finalized one-time Release 1 workflow and is not a production-readiness declaration.

## Release 1 scope and result

Release 1 supports one complete background-replacement publication per eligible Shopify product. Current transparent Shopify media is the source input; Printful API integration, independent supplier authority, permanent reusable garment-source libraries, and repeat background replacement are explicitly out of scope. Task 023 does not declare production readiness; Task 024 remains the production acceptance milestone.

Task 019 identity and integrity controls remain mandatory. Each initial publication requires a currently attached image with stable MediaImage identity, exactly one reliable product/color mapping, coverage of the exact color variant GID set, meaningful PNG transparency, and SHA-256 equality between downloaded bytes, preserved provenance, and generation evidence. Preview and background hashes are rechecked before mutation and preview bytes are rechecked immediately before upload. Detached historical sources and generated composites cannot authorize publication.

A durable completed Release 1 operation (`published`, `rolled_back`, or `rolled_back_files_retained`) blocks another independent publication for that product, including after restart. An unresolved operation must be resumed, reconciled, rolled back, or—only for the narrowly designated disposable test product—verified and abandoned. Recovery and rollback remain available even though repeat publication is blocked. No destructive source cleanup was introduced; sources and checkpoint evidence are retained whenever publication, rollback, recovery, restoration, or audit may require them.

## Restoration reconciliation and clearance

The API exposes authorization-protected restoration status, validation, and clearance endpoints. The dashboard enables only the reconciliation action while the ordinary publishing controls remain disabled.

Validation is read-only. It checks the Task 022 marker, validates all loaded Task 021 checkpoint structures, accounts for every restored operation, and rejects any partial/conflicted status, pending intent, uncertain creation, or uncertain cleanup. It groups history by product and compares the latest durable operation with a complete Shopify snapshot:

| Terminal state | Required exact live state |
| --- | --- |
| `published` | recorded generated gallery order and each variant's generated media association |
| `rolled_back` | immutable original gallery order and original variant associations |
| `rolled_back_files_retained` | immutable originals restored; generated files may exist globally but cannot reference the product or variants |
| `abandoned` | immutable originals restored; operation-created media cannot reference the product or variants |

Clearance requires the exact `CLEAR RESTORATION <marker SHA-256>` confirmation. It performs validation, atomically persists evidence beneath `restoration-reconciliations/`, performs a second complete validation, compares a deterministic state digest, rereads the marker hash, and atomically renames the marker to a preserved cleared record. It never publishes, rolls back, creates, attaches, detaches, reorders, or deletes Shopify media. A failed evidence write, changed snapshot, changed marker, or failed rename leaves mutation blocking active. Duplicate clearance is idempotent. This is conservative read-check-record-check behavior, not a claimed cross-system transaction.

The API process already owns the Task 020 OS-backed data-directory lock before service initialization. While reconciliation is running, all state-changing publication methods are additionally blocked. After clearance, every ordinary allowlist, freshness, immutable checkpoint, product lock, authorization, origin, and explicit confirmation gate remains mandatory.

## Failure and recovery matrix

| Failure | Result |
| --- | --- |
| incomplete Shopify snapshot/read failure | marker retained; no mutation |
| changed media set/order or variant set/association | external conflict; marker retained |
| unresolved mutation intent/uncertain file ownership | manual existing recovery required; marker retained |
| evidence persistence failure | marker retained |
| crash after evidence but before rename | marker retained; validation may be safely repeated |
| state changes between reads | digest mismatch; marker retained |
| marker rename failure | marker retained |
| duplicate clearance after success | reports already cleared; no Shopify access or mutation |

## End-to-end validation and remaining risks

Automated tests use isolated temporary data and Shopify doubles. The Release 1 lifecycle fixture discovers a Draft product with Black, Navy, and White sources; generates three deterministic previews over a selected background; verifies preserved source bytes, SHA-256 generation evidence, foreground and background pixels; publishes three generated media items; replaces all nine variant associations; verifies exact gallery order and the terminal checkpoint; and rejects a second independent publication. A successful service response alone is not treated as completion.

The broader suite covers source unavailability, opaque and changed sources, mapping drift, missing/duplicate variants, preview changes, confirmation and allowlist failures, concurrent starts, mutation-boundary interruption, checkpoint persistence failure, restart recovery, rollback, uncertain file creation, backup/restore, Windows process ownership, exact restored-state reconciliation, marker persistence, stale clearance, authorization, and zero-mutation reconciliation.

No live Shopify request or mutation was performed. Repeat replacement and supplier refresh were not tested because they are outside Release 1. Task 024 still requires independent review and controlled production acceptance; Task 023 must not itself be treated as a production-readiness declaration.
