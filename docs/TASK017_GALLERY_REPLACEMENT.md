# Task 017: complete gallery replacement

## Operator workflow

1. Search Shopify by title and select the intended product. Search follows cursors for up to 100 matches; narrow broader searches.
2. Confirm the displayed images, color count, and complete variant count, then upload one background.
3. Generate the Phase 3 batch and resolve every skipped or ambiguous color. Publishing requires one successful preview per unique color and exactly one mapping for every variant.
4. Validate publishing readiness. Review each before/after color card, the number of variants using it, the current gallery count, and the generated-only final count.
5. For a real product, type the exact server-provided `PUBLISH gid://shopify/Product/<id>` confirmation. The disposable test product retains `PUBLISH` compatibility.
6. Verify the resulting storefront separately before moving to another product. Use operation recovery rather than starting a second operation if publication is partial.

## Mapping and final-state invariants

Color mappings come only from Shopify variant/image or variant/media associations. Filenames and alt text are never used to guess. All size variants of one color share that color's single generated mockup. Missing colors, duplicate color outputs, variants without a color, incomplete snapshots, and variants mapped zero or multiple times block publication.

For a new replacement operation:

- `expectedPublishedMediaOrder` is the generated media IDs in Phase 3 color order.
- The final product gallery must equal that array exactly; originals and unrelated media are forbidden.
- Every immutable variant ID must exist and reference only its intended generated color media ID.
- Product ID and title must still equal the completed batch identity.

The mocked acceptance case covers eight colors, ten sizes per color, eight outputs, and all 80 variant associations.

## Recoverable Shopify sequence

Checkpoint zero records the product identity, ordered original media IDs, all original variant-media associations, color mappings, and preview IDs before mutation.

1. Stage each generated PNG and checkpoint intent before `fileCreate`.
2. Record the returned media ID immediately. An interrupted create without a durable ID is an uncertain conflict and is never automatically repeated.
3. Wait for the file, attach it to this product with `fileUpdate(referencesToAdd)`, and replace that color's variants with `productVariantsBulkUpdate(allowPartialUpdates: false)`.
4. After all generated variant associations are complete, detach each original from this product with `fileUpdate(referencesToRemove)`. This does not call `fileDelete` and does not remove the original Shopify File globally.
5. Reorder generated media deterministically with `productReorderMedia`, wait for its asynchronous job, and fetch a fresh complete publication snapshot.
6. Mark success only after exact gallery order, variant identity, and variant association verification.

Every mutation is preceded by an intent checkpoint and followed by a result checkpoint. Checkpoints use temporary files plus atomic rename. Recovery accepts only the immutable operation and a complete live snapshot, rejects unrelated drift, and reconciles mutations that may already have completed. Existing append-style operations lacking `publicationMode: replace_gallery` keep their historical behavior.

## Rollback

Replacement rollback does not assume originals remain attached. It reattaches every retained original file, restores the immutable variant associations (including originally unassigned variants), removes generated references from the product, and restores the exact original media order. A fresh complete snapshot must prove product restoration.

Original files are never globally deleted by replacement publishing. Generated files are deleted only when the existing ownership safeguard can prove exclusive operation ownership. Otherwise the product may be fully restored while generated files are retained with structured cleanup evidence for manual review.

## Eligibility and configuration

Publishing remains disabled unless the existing feature flag, private authorization token, allowed local origin, and required live scopes all pass. Search results do not imply permission to publish.

`SHOPIFY_PUBLISH_PRODUCT_IDS` is an optional comma-separated list of exact Shopify Product GIDs. It is empty in `.env.example` and no local `.env` is changed by this task. Invalid entries fail service construction. The disposable draft test product remains separately eligible only when its ID, title, and draft status match.

A controlled real-product test requires all of the following before startup:

- independent review of this implementation and its local checkpoint backup;
- one exact approved Product GID in `SHOPIFY_PUBLISH_PRODUCT_IDS`;
- publishing deliberately enabled with the existing authorization and origin controls;
- the pinned scopes already required by the application;
- a fully generated, manually reviewed batch with no skipped colors;
- explicit product-specific confirmation in the dashboard;
- a rollback and storefront-verification plan.

Do not put credentials, tokens, shop domains, or wildcard values in the allowlist.

## Limitations and readiness

- Shopify mutations were not executed while implementing or testing this feature; all publication tests use mocks.
- Local JSON checkpoints are appropriate for the intended single local operator, not concurrent users or distributed workers.
- Search intentionally caps a single query at 100 complete matches; a catalog of roughly 400 products is supported through narrower title searches rather than a full-catalog dashboard.
- A color with more than 250 variants is rejected because the current guarded bulk mutation is not split across calls.
- Shopify does not provide the adapter with authoritative global inverse file references, so generated-file cleanup can remain a manual conflict even after the product is restored.
- The first controlled real-product attempt remains a review-gated operation, not an assertion of general production readiness.

The implementation is suitable for a separately approved, closely observed first-product test only after code review, environment configuration, checkpoint backup, and confirmation of current Shopify API behavior. Publishing is still off and the real-product allowlist is still empty by default.
