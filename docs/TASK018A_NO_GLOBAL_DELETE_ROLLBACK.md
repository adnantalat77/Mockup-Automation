# Task 018A: Explicit No-Global-Delete Rollback

## API contract

The protected rollback endpoint is `POST /api/publishing/:operationId/rollback`. It requires the normal publishing authorization and origin safeguards plus this exact body:

```json
{
  "confirm": "ROLLBACK",
  "mode": "no_global_delete"
}
```

Missing or unsupported modes are rejected before rollback service work begins. The UI describes the action as: “Restore original product images. Generated Shopify Files will be retained globally.”

## Safety invariants

`no_global_delete` is the only supported rollback mode. Its service control flow cannot call `verifyFileDeletionSafe`, `deleteFile`, Shopify `fileDelete`, or an equivalent global-deletion operation. Removing a generated reference from the operation product never establishes permission to delete its underlying global file.

The mode retains the existing product lock, operation supersession check, complete live snapshot comparison, immutable original snapshot, drift detection, mutation intent checkpoints, atomic checkpoint writes, and exact post-restoration verification. Historical operation files remain version 1 and the optional `rollbackMode` field does not invalidate older checkpoints.

## Checkpoint semantics

The selected mode is persisted before restoration mutations. Each generated media item ends with:

- `status: rolled_back`
- `cleanupPending: true`
- `cleanupOutcome.kind: retained_by_operator`
- `cleanupOutcome.reasonCode: global_deletion_prohibited_by_operator`

The operation becomes `conflict` after successful product restoration because retained global files require explicit finalization. `productRestored` becomes true only after a fresh complete snapshot exactly matches the original media order and every original variant association.

Finalization accepts deliberate retention only when every item has consistent structured evidence, generated references are absent from the product and variants, no unrelated error or conflict exists, and the product is the disposable test product or currently allowlisted. It requires `FINALIZE <operation ID> FILES RETAINED`, performs no Shopify mutation, and is never automatic. Historical ownership-unproven retained-file finalization remains compatible.

## Controlled Stage D procedure

1. Back up and validate the operation checkpoints.
2. Fetch a complete live snapshot and confirm it exactly matches the published operation state.
3. Submit one protected rollback request with `confirm: ROLLBACK` and `mode: no_global_delete`.
4. Do not retry an uncertain response automatically.
5. Fetch a fresh complete snapshot and verify original gallery ordering, all original variant associations, absence of generated product references, and preservation of global files.
6. Review retained-file finalization separately. Do not finalize without operation-specific authorization.

Task 018A itself authorizes implementation and mocked tests only. It does not authorize this procedure against Shopify.
