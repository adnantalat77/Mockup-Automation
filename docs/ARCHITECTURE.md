# Application architecture

The browser talks only to the local Express API. Uploads are held in memory while Sharp validates their decoded content, then written under `data/` with UUID filenames. No original filename is used as a filesystem path.

- `apps/web`: React/Vite dashboard on port 3000.
- `apps/api`: Express upload, asset, validation, and Sharp compositing endpoints on port 3001.
- `packages/shared`: transport types shared by both applications.
- `data/uploads`: original backgrounds and garments (ignored by Git).
- `data/generated`: generated PNG previews (ignored by Git).

SQLite is intentionally deferred because current metadata can be stored beside local assets. The dashboard's primary path is Shopify product selection, background upload, bulk generation, and guarded publishing or recovery. The legacy manual garment upload and standalone preview interface have been removed, while their API validation and Sharp compositing services remain available and support automated coverage and batch processing.

## Phase 2 Shopify read-only boundary

`ShopifyService` is backend-only. It reads optional credentials from the repository-root `.env`, uses the 2026-10 client-credentials endpoint, caches short-lived tokens in process memory, refreshes before expiration or once after a 401, and never returns tokens or credentials to the browser. Connectivity checks query `currentAppInstallation.accessScopes` and require `read_products`. Phase 2 read-only routes invoke no GraphQL mutations; Phase 4 mutation methods are separately gated by the publishing boundary below.

The API provides read-only status, product title search, product detail, and transparent source-import routes. Product and image GIDs are strictly validated. Remote images must use HTTPS on Shopify CDN hosts; redirects are followed manually and revalidated, authority components are rejected, response size is checked before and during streaming, and downloads time out. Decoded PNG/JPEG content and alpha pixels are checked with the existing Sharp validators.

Color mappings use only direct Shopify variant image or media associations. An image associated with one color is reliable; images associated with multiple colors or no variants are marked for manual review. Filenames and alt text are never used to infer mappings. Importing a transparent source writes a preserved local copy and does not change the Shopify product.

When Shopify variables are absent or incomplete, the status route reports the integration unavailable. Local upload and compositing APIs remain operational, but the dashboard cannot begin its Shopify-based bulk workflow.

## Phase 3 batch processing

Shopify product detail connections are cursor-paginated with a 20-page safety cap. Unique images are decoded and alpha-validated sequentially, with at most 250 relevant images retained. Batch creation accepts only a validated product GID and an existing local background UUID. It caps work at 50 colors and two active batches.

`BatchService` derives candidates exclusively from reliable Shopify variant/media associations. Exactly one compatible transparent candidate is queued; missing and conflicting mappings are persisted as manual-review skips. Two workers process colors concurrently. Each worker downloads and revalidates its source, reads the preserved background, calls the existing `compositePreview`, and writes a new preview without changing either source. Transient Shopify failures receive one retry.

Batch JSON metadata is stored under ignored `data/batches/` and serialized per batch to prevent concurrent write races. On startup, interrupted queued or processing items become failed review items rather than being resumed silently. Cancellation sets a durable flag, prevents new items from starting, and lets in-flight processing complete safely. Individual successful mappings can be regenerated after the batch stops.

ZIP export includes only successful previews, uses unique sanitized color filenames, performs no image transformation, and rejects archives whose input previews exceed 150 MB. The archive is assembled in memory, so this limit is a deliberate local safety bound.

## Image guarantees

The API decodes files with Sharp instead of trusting extensions or browser MIME types. Garment PNGs are converted to raw RGBA for alpha-pixel inspection. Validation requires at least 16 meaningful alpha pixels or 0.1% of the image, whichever is greater (bounded by total pixels), using alpha values at or below 250. This rejects opaque files and isolated near-opaque edge artifacts while retaining legitimate partially transparent antialiasing.

Backgrounds are auto-oriented from EXIF metadata before the output dimensions are read. Preview generation uniformly scales the complete garment only when it is larger than the normalized background, centers it, never crops or stretches it, and writes a new high-quality PNG. Input buffers and stored source files are not overwritten. Asset lookup accepts only strict UUID values generated by the server.

The frontend commits a new background selection only after server validation succeeds. A failed replacement clears the browser file input, retains the last validated background, and explicitly reports that the current selection was retained. Shopify source import reports its preserved local copy inline; generated comparisons are presented in the bulk gallery rather than a standalone preview section.

## Phase 4 publishing boundary

`PublishingService` is the only service that coordinates Shopify mutations. It accepts only completed Phase 3 batches, revalidates the current product mappings and all generated PNGs, and serializes publication or rollback work per product. Express protects every publishing route with a server feature flag, a 32-character minimum shared authorization secret, an allowlisted local browser origin, explicit confirmation text for mutations, and a live check for `read_products`, `write_products`, and `write_files`. Credentials and access tokens remain inside `ShopifyService`.

New publication is hard-restricted to the exact disposable draft test product. This is intentionally narrower than a future production allowlist. Rollback remains tied to an existing immutable operation so an operation is not stranded if product status changes after publication.

The publish sequence is staged upload, `fileCreate`, `MediaImage.fileStatus` polling, `fileUpdate(referencesToAdd)`, then `productVariantsBulkUpdate` with the generated `mediaId` for every size variant mapped to the color and `allowPartialUpdates: false`. This supported update replaces the variant's existing singular media association; original product media files remain on the product and are never deleted. Shopify GraphQL user errors and asynchronous job failures are treated as failures; the existing GraphQL transport provides throttling waits, transient retries, and one token refresh after an unauthorized response.

Media reorder polling uses the dedicated QueryRoot `job(id:)` field rather than `node(id:)`; Shopify's `Job` type does not implement `Node`. The service requires a returned job and waits for `done` with a 20-attempt, 500 ms bounded poll before reading final product ordering. On recovery from an interrupted `reorder_published` intent, the complete live snapshot must still contain exactly the immutable original and operation-created media plus the expected generated variant associations. If media are already in target order, the reorder step is checkpointed complete without mutation. Otherwise only the reorder mutation is repeated; file creation, product references, and variant replacement remain completed.

Fresh publication and partial recovery use separate API contracts. Fresh readiness applies the first-publication preflight rules and `publish` always creates a new operation; both are blocked by an existing nonterminal product operation. Recovery is addressed by immutable operation ID plus batch ID, is limited to `partial` operations, and validates a complete live snapshot through the existing fail-closed comparison rules. `resume` validates and reconciles again in the product-locked continuation path and never creates an operation. Abandoned, conflicted, completed, wrong-batch, and externally changed operations cannot be resumed.

Recovery metadata lives in ignored `data/publications/<operation UUID>/`. Each JSON checkpoint is first written to a uniquely named temporary file and atomically renamed to a monotonically increasing final filename. Checkpoint `000000.json` contains the original ordered product media IDs, original variant-media associations, generated preview IDs, mappings, and operation identity before any mutation. Every mutation is bracketed by an intent checkpoint and a result checkpoint. Startup validates structure, ignores temporary or malformed checkpoints, and loads the newest complete checkpoint.

Rollback first compares current media with the union of snapshot media and media created by the operation. Missing originals, variant-association drift, or unrelated additions produce a conflict requiring manual review. Otherwise it detaches created variant media and removes the created product reference. Global file deletion proceeds only when the adapter can prove exclusive ownership; otherwise the file is preserved and the operation becomes a conflict. Partial failures are checkpointed and can be retried safely. This mechanism intentionally does not restore unrelated external changes or any non-media product field.

An operation whose product restoration succeeded but whose generated files were preserved for uncertain global ownership can be explicitly finalized as `rolled_back_files_retained`. Read-only verification requires the designated disposable draft product, structured per-item cleanup evidence, a complete immutable snapshot, exact live original media ordering, exact live variant identity and associations, and absence of every generated media ID from the product and variants. The finalization request repeats that verification inside the product lock, performs no Shopify mutation, and appends evidence containing the status transition, confirmation, verified originals, retained generated IDs, and cleanup conflicts. The terminal status unblocks future publication without representing the retained Shopify Content files as deleted.

Generated-file cleanup uses a discriminated per-item outcome: `deleted_safely`, `retained_ownership_unproven`, `cleanup_failed`, or `cleanup_outcome_uncertain`. Only the retained outcome with stable reason code `global_references_unverifiable` can be finalized. A persisted `delete_file` intent without a completed deletion step is converted on startup to an uncertain outcome and can never be retried automatically. Historical finalized Task 015 checkpoints remain readable without modification; historical unfinalized conflicts lacking structured outcomes are rejected rather than classified from text.

Publication snapshots use independent cursor loops for product media, product variants, and every variant's nested media connection. Missing, repeated, or excessive cursors fail the operation closed. Partial publication retries use the original snapshot, reconcile each known created media ID and association against the live complete graph, and never repeat `fileCreate` after an uncertain response. The intended published order is original media in original order followed by generated media in batch color order.

A durable `create_file` intent without `createdMediaId` represents the crash window after the request may have reached Shopify but before its response could be checkpointed. Startup marks that item `uncertainCreation` and the operation `conflict`; the partial retry path applies the same check independently. This state cannot return to automatic file creation.

Rollback compares the complete live variant-media graph with the expected operation state before mutation. Because Shopify Admin GraphQL 2026-10 does not expose a complete inverse reference connection for a File, the production adapter cannot prove global exclusivity. It therefore removes only the current product reference, preserves the underlying file, and records a conflict pending manual reference verification rather than risk deleting a shared file.

Rollback records `productRestored` independently from `cleanupConflicts`. This distinguishes a product whose original ordering and variant associations are fully restored from residual operation-created files that were deliberately preserved because exclusive ownership could not be proven.

For rollback, variants with one original association are grouped by original media ID and restored through `productVariantsBulkUpdate` before generated product references are removed. Originally unassigned variants use `productVariantDetachMedia`. More than one original association, mixed replacement results, or any association outside the immutable original/generated alternatives fails closed for manual review. Interrupted bulk replacements are reconciled from the complete live variant snapshot before another mutation is considered.

## Disposable test-operation abandonment

Abandonment is a narrowly scoped terminal transition for `gid://shopify/Product/15608846975264` only. The service also verifies the exact title `Mockup Automation - TEST ONLY` and `DRAFT` status. It accepts only partial, rollback-partial, or conflicted operations. A complete paginated live snapshot must exactly equal the immutable original media ordering and complete variant-association graph, and no recorded generated media ID may remain referenced by the product or any variant.

Validation performs reads only. Final abandonment re-runs validation while holding the per-product operation lock, then atomically checkpoints `abandoned`, `abandonedAt`, a user-supplied reason, and the complete verification evidence. Repeated calls are idempotent. Abandoned operations cannot resume or roll back, but their full prior checkpoint history remains unchanged. Stored Shopify Files are explicitly outside the proof: they are neither inferred safe nor deleted. Any other nonterminal operation for the product blocks a fresh publication.
