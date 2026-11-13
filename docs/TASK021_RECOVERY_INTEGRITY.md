# Task 021: recovery integrity and fault-injection hardening

## Lifecycle audit

The publication state machine was audited from readiness through retained-file finalization. Checkpoint zero records the immutable product gallery, exact variant associations, color ownership, batch identity, and Task 019 evidence before mutation. Staged upload, `fileCreate`, product reference addition, variant replacement, original reference removal, gallery reorder, original restoration, generated detachment, generated reference removal, and original reorder each record an intent checkpoint before the Shopify mutation and a result checkpoint afterward.

The audit found three integrity gaps: missing variants could be interpreted as empty associations in lookup expressions, duplicate IDs were not rejected consistently, and the checkpoint loader validated shape but not contradictory ownership evidence. Terminal publication verification compared live state but did not independently assert every durable step and the absence of pending intent. These gaps are now closed without changing authorization or adding mutations.

Response-loss rules remain fail-closed. `fileCreate` without a durable returned ID is an ownership conflict and is never repeated. Association, detach, reference, and reorder intents are reconciled against a complete live snapshot; only an exact pre-state or exact post-state is accepted. A failed intent checkpoint prevents the mutation call. A failed result checkpoint leaves the durable intent available for restart reconciliation. No filename, timestamp, or product reference establishes global Shopify File ownership, and rollback never calls `fileDelete`.

## Exact-state invariants

Every Shopify publication snapshot must be marked complete and contain unique product-media IDs, unique variant IDs, and unique media IDs within each variant association. Product gallery order is significant. Variant array order is not significant: comparison uses the exact variant GID set and the exact ordered media association recorded for each GID.

Fresh readiness requires the complete snapshot variant set to equal the current product variant set. Recovery accepts only transitional states justified by durable evidence: original or generated association around a pending replacement, recorded generated association after completion, and only the still-attached ordered subset of immutable originals during gallery removal. Published state requires the exact generated gallery order, exact generated association for every immutable variant, every required durable step, and no pending intent.

Rollback accepts only original or operation-generated evidence during transition. Completion and retained-file finalization require the exact original ordered gallery, exact original variant GID set and associations, no generated product or variant references, and a consistent `no_global_delete` retained-file disposition.

## Checkpoint validation and recovery

The loader falls back only when `JSON.parse` fails for a numbered checkpoint, which represents an interrupted or truncated write. Once a complete JSON value parses, it must validate as an operation object: missing fields, wrong types, unsupported versions or statuses, wrong directory identity, and contradictory evidence fail startup immediately instead of falling back to obsolete state. Temporary files remain outside the numbered-checkpoint scan. Validated invariants include operation/product identity, supported status and rollback mode, unique original and expected media, unique colors, unique variant ownership across colors, unique created-media ownership, exact item-to-snapshot variant coverage, valid item state and intent, intent prerequisites, completed-step uniqueness, original association membership, and Task 019 evidence when schema version 1 is declared.

Legacy `expectedPublishedMediaOrder` compatibility is applied to an in-memory clone only after a complete JSON object is parsed. It is never written back, and it does not exempt any other missing or invalid field from schema validation.

Legacy version 1 records remain supported. Missing Task 019 fields are accepted unless the record explicitly declares source-validation schema version 1. Historical append-gallery ordering remains distinct from replace-gallery ordering. No historical checkpoint is rewritten or normalized on disk.

## Fault-injection and restart matrix

| Boundary | Injected outcome | Required decision |
| --- | --- | --- |
| Intent persistence | Write fails | Mutation is not called; in-memory blocker or prior checkpoint remains |
| Staged upload | Request fails before resource URL | Partial and safely retryable from durable intent |
| `fileCreate` response/checkpoint window | ID is not durable | Explicit uncertain-creation conflict; never repeat |
| Product reference or variant replacement | Response lost | Reconcile exact live pre/post state; reject partial subsets |
| Original removal or reorder | Interrupted intent | Reconcile allowed ordered transitional gallery; reject unrelated state |
| Source freshness/readback | Download, hash, alpha, or mapping failure | Stop before upload or resume mutation |
| Rollback restoration/detachment | Mutation or readback failure | `rollback_partial` or conflict; never terminal success |
| Finalization | Incomplete/duplicate/mismatched snapshot | Ineligible; no checkpoint transition |
| Checkpoint file | Truncated JSON/temp file | Recover previous complete checkpoint |
| Complete checkpoint | Contradictory identity/ownership evidence | Fail startup closed; do not fall back or mutate |

Tests use temporary data roots and Shopify test doubles only. Restart tests construct a fresh `PublishingService` from persisted checkpoints. Existing tests cover every mutation family, before-mutation failure, post-mutation reconciliation, partial multi-step recovery, source freshness failure, rollback interruption, and finalization. Task 021 adds duplicate product-media, variant-identity, and variant-association cases; terminal readback rejection; cross-page duplicate detection; and contradictory complete-checkpoint startup failure.

## Historical compatibility and limitations

The 64-file Task 018 Stage E checkpoint set remains byte-for-byte unchanged and readable. Task 019 provenance remains mandatory only for operations that declare its schema. Task 020 process ownership still surrounds all recovery initialization.

Local JSON checkpoints use atomic rename but are not cryptographically authenticated or transactional across the filesystem and Shopify. Provider-side non-idempotency can still require operator reconciliation when no durable external identity exists. This hardening does not establish production readiness; Task 024 remains the production-readiness target.

