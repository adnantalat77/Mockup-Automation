# Task 017A: publication lifecycle and recovery hardening

## Successful publication completion

`published` means the service completed its mutation sequence and then verified a fresh, complete Shopify snapshot: exact product identity, exact generated-only gallery order, complete variant identity, and every intended generated association. Only that verified status is nonblocking. It remains an immutable, readable audit record and is not rolled back automatically.

`validated`, `publishing`, `partial`, `rolling_back`, `rollback_partial`, and `conflict` remain blocking. Uncertain file creation and deletion outcomes remain conflicts requiring manual reconciliation. `rolled_back`, `rolled_back_files_retained`, and `abandoned` are terminal and nonblocking.

A completed batch cannot be published twice. A later replacement requires a new Phase 3 batch and a new operation snapshot.

When a transparent Shopify garment source is first validated and used, Phase 3 preserves an unchanged local garment asset in ignored local storage and records it on the batch item. After gallery replacement detaches the original Shopify product reference, a later batch may reuse that exact preserved source for the same product and color. It never treats the opaque generated gallery image as a new garment source, and a missing or invalid preserved asset fails publishing closed.

## Sequential replacements and supersession

Publication startup loads the batch, obtains the per-product lock, repeats preflight and blocker checks inside that lock, creates the new immutable snapshot from the current complete Shopify state, and atomically persists checkpoint zero before any mutation. The lock remains held through publication completion.

Each new operation records `predecessorOperationId` for the latest durable operation on that product. That explicit checkpoint link establishes supersession after restart without rewriting older snapshots.

For Gallery 1 → Gallery 2 → Gallery 3:

- Publication A snapshots Gallery 1 and verifies Gallery 2.
- Publication B has a new batch, records A as its predecessor, and snapshots Gallery 2.
- Rolling back B restores Gallery 2.
- A cannot roll back after B's checkpoint exists, even if B later rolls back or fails. This prevents an older snapshot from overwriting newer work.
- Older operation directories and all prior checkpoints remain unchanged and readable.

An unresolved operation prevents B from starting. Two simultaneous starts cannot both pass the blocker check because the decision and initial checkpoint are in the same product-level critical section. If the initial checkpoint write fails, the process retains an in-memory conflict so it cannot silently start another operation; no Shopify mutation has yet occurred. A restart relies only on complete durable checkpoints and fails closed for interrupted mutation intents.

## Rollback eligibility

The server rejects rollback when any newer durable operation exists for the same product. The UI labels such records as superseded and hides rollback controls, but server enforcement is authoritative.

The latest eligible operation still uses the existing complete-snapshot comparison, variant restoration, original-reference restoration, ordering verification, ownership checks, and structured cleanup outcomes. A generated `fileDelete` request whose result is uncertain is immediately classified as a nonretryable `conflict` with `cleanup_outcome_uncertain`; it is not exposed as an ordinary `rollback_partial` retry.

## Retained-file finalization for real products

Finalization remains metadata-only and performs no Shopify mutation. It is available for:

- the exact disposable test product with its existing title and Draft requirement; or
- a real product whose exact GID is present in `SHOPIFY_PUBLISH_PRODUCT_IDS`.

For a real product, the live ID and title must match the immutable operation. Draft status is not required. Both validation and the final action require a fresh complete media/variant snapshot. The action revalidates under the product lock and requires:

- `productRestored: true`;
- exact original gallery order and complete original variant associations;
- no generated ID attached to the product or any variant;
- every item rolled back and cleanup-pending;
- every generated ID covered by `retained_ownership_unproven` with reason `global_references_unverifiable`;
- no uncertain creation/deletion, unrelated cleanup failure, restoration mismatch, or other conflict kind;
- exact `FINALIZE <operation ID> FILES RETAINED` confirmation.

Finalization preserves the generated global Shopify Files, records verification evidence, and transitions to terminal `rolled_back_files_retained`. Removing a product from the allowlist prevents future finalization; the allowlist is never inferred from historical publication.

## Historical compatibility and limitations

Task 015/016 checkpoints without `predecessorOperationId` remain readable. The first later operation records the historical operation as its predecessor, preventing the older record from overwriting newer work. Append-style records without `publicationMode` retain their existing semantics.

The architecture remains single-process and local JSON based. The in-memory product lock does not coordinate multiple API processes or machines; running more than one API instance against the same data directory is unsupported and must fail operational review. File-system atomic rename protects individual checkpoints but is not a distributed transaction.

## Controlled live-test prerequisites

Publishing remains disabled and the real-product allowlist empty by default. Before any separately authorized test: independently review the code and checkpoint backup, run one API process only, allowlist one exact product GID, verify required Shopify scopes and product mappings, generate a new complete batch, confirm rollback prerequisites, and monitor the full verification result. This implementation made no live Shopify request or mutation during Task 017A.
