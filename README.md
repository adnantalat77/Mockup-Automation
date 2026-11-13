# Mockup-Automation

Local Windows application for Equipd Wear. The primary workflow selects a Shopify product, uploads one background, generates and reviews a preview for each reliably mapped garment color, and optionally uses guarded publishing and recovery. Publishing remains disabled by default.

## Prerequisites

- Windows 10/11
- Node.js 20.19+ (Node 22 LTS recommended)
- npm 10+
- Git and VS Code

Sharp installs prebuilt Windows binaries through npm; no separate ImageMagick installation is required for a normal supported Node version.

## Setup and commands

From PowerShell in the repository root:

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open <http://127.0.0.1:3000>. The API listens on <http://127.0.0.1:3001>. During local development, Vite proxies same-origin `/api` requests to the API, avoiding browser CORS and `localhost` IPv4/IPv6 resolution differences. The environment file is optional because local defaults are built in. For separate-origin production hosting only, set `VITE_API_URL` to the deployed API origin.

```powershell
npm test
npm run build
npm run lint
```

These commands are root scripts backed by npm workspaces. `npm test` runs API image/upload tests; `npm run build` builds shared types, API, and web production assets.

## Local workflow

1. Connect Shopify and select a product through the read-only catalog search.
2. Upload one JPEG or PNG background (maximum 12 MB by default).
3. Select **Generate All Mockups** to create previews for every reliably mapped transparent garment source.
4. Review or regenerate individual color cards, download the completed ZIP, and separately validate publishing readiness when publishing is enabled.

The legacy manual garment upload and standalone two-image preview are no longer shown in the dashboard. Their backend validation and Sharp compositing services remain available for automated tests and are reused by bulk generation.

## Optional Shopify read-only setup

Create and install an app through Shopify's Dev Dashboard, release a configuration with only the `read_products` Admin API scope, and confirm the app and Equipd Wear store are in the same Shopify organization. Client credentials are not eligible for stores outside the app's organization.

Copy `.env.example` to the repository-root `.env` and set:

```text
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
SHOPIFY_API_VERSION=2026-10
```

Restart `npm run dev`. The backend exchanges these credentials for a short-lived token, caches it only in memory, refreshes it shortly before expiry, and checks for `read_products`. Credentials and tokens never enter browser responses or application logs. If the variables are absent, the local server and background upload remain available, but the primary product-selection and bulk-generation workflow cannot start.

Product image-to-color mappings are considered reliable only when Shopify exposes a direct variant image or media association. Shared and unassociated images are marked for manual review. A Shopify image must pass decoded-format and meaningful-alpha validation before it can be used for preview generation.

## Bulk mockup generation

After selecting a Shopify product and uploading one background, choose **Generate All Mockups**. The backend paginates product images, media, and variants, then creates one job per Shopify color. A color is generated only when exactly one transparent PNG has a direct variant/media association. Missing sources and conflicts are skipped with a manual-review explanation; filenames and alt text are never used to guess.

At most two colors are processed concurrently, a batch is limited to 50 colors, transient Shopify failures receive one retry, and cancellation stops queued work while allowing an in-flight image write to finish safely. Progress and per-color results are persisted under ignored local `data/batches/` metadata, and the dashboard restores the most recently updated batch. Interrupted jobs are marked for regeneration when the API restarts. Completed colors can be regenerated individually or downloaded together as an uncompressed ZIP archive. ZIP creation is limited to 150 MB of source preview data.

Local source assets are stored beneath ignored `data/uploads/`; generated previews are stored beneath ignored `data/generated/`. Files receive generated UUID names. To change limits or ports, copy `.env.example` to `.env` and edit local values.

## Phase 4 publishing and recovery

Publishing remains unavailable unless all three server-side gates pass: `SHOPIFY_PUBLISHING_ENABLED=true`, a private `SHOPIFY_PUBLISHING_AUTH_TOKEN` of at least 32 characters, and live verification of `read_products`, `write_products`, and `write_files`. The authorization value is entered only for a protected operation and sent in `X-Publish-Authorization`; it is not persisted by the browser. Mutation requests also require an approved local origin and an explicit `PUBLISH` or `ROLLBACK` confirmation value.

New publication is additionally restricted in code to the exact disposable draft product `gid://shopify/Product/15608846975264` titled `Mockup Automation - TEST ONLY`. No production-product allowlist or approval workflow is active.

Before publishing, the API completely paginates product media, variants, and each variant's media, validates every color-to-variant association and generated PNG, and writes checkpoint zero under ignored `data/publications/`. Every mutation has a preceding intent checkpoint and a following result checkpoint. Original media are retained. Partial retries reconcile the immutable snapshot against live Shopify state and stop on external drift or an uncertain file-creation result.

New publication readiness and partial-operation recovery are separate workflows. **Publish All** only creates a new operation when no nonterminal operation blocks the product. An eligible `partial` history entry is checked using its immutable operation and batch IDs plus a complete live snapshot, then continued with **Resume Publication**. The resume endpoint cannot create a new operation and reconciles live state again before continuing.

If startup finds a persisted `create_file` intent without a checkpointed Shopify media ID, the operation is marked as an uncertain-creation conflict. Neither restart recovery nor a partial-operation retry repeats `fileCreate`; manual reconciliation is required to locate and establish ownership of any file Shopify may have created.

The Shopify workflow uses staged uploads, `fileCreate`, file-processing polling, `fileUpdate` product references, `productVariantsBulkUpdate`, `productVariantDetachMedia` for originally unassigned variants, `productReorderMedia`, and guarded `fileDelete`. It does not use deprecated `productDeleteMedia`. See [docs/PHASE4_LIVE_TEST.md](docs/PHASE4_LIVE_TEST.md) before any separately approved live test.

Variant publishing uses `productVariantsBulkUpdate` with `mediaId` and `allowPartialUpdates: false`. This replaces an existing variant image association instead of attempting to append a second association. The immutable pre-publication variant-media snapshot remains the rollback source of truth; rollback restores each original `mediaId` before removing the generated product reference.

Published ordering is deterministic: all original media remain in their original order, followed by generated media in batch color order. The API verifies this ordering after Shopify's asynchronous reorder job. Checkpoints are written to uniquely named temporary files and atomically renamed; startup ignores temporary or malformed files and recovers the newest structurally valid checkpoint.

`productReorderMedia` jobs are polled through Shopify's `job(id: ID!) { id done }` QueryRoot field. A missing job, GraphQL error, or failure to complete within 20 polls at 500 ms leaves the publication partial. Recovery first reconciles the complete live product state: an already-completed target order is checkpointed without another reorder, while a safe but unfinished order can retry only the idempotent reorder step. Created files and completed variant replacements are never repeated.

Rollback distinguishes restoring the product from deleting generated files globally. When the original product media order and every variant association have been freshly verified, generated references are absent from the product, and Shopify cannot prove that the generated files are exclusively owned, an explicit **Check Rollback Finalization** review can approve **Finalize Restored Product**. Finalization performs no Shopify mutation and records the terminal `rolled_back_files_retained` status. This means the product is restored while the listed generated files intentionally remain in Shopify Content → Files; it does not claim global deletion succeeded. The action is operation-specific, authorization-protected, confirmed explicitly, product-locked, and checkpointed after a second live verification.

Cleanup is classified per generated media ID as safely deleted, retained because ownership is unproven, failed, or uncertain. Finalization accepts only the machine-readable retained-ownership outcome. Existing finalized Task 015 checkpoints remain terminal and readable; legacy unfinalized conflicts without structured outcomes fail closed and are not inferred from error text or array lengths. See [docs/PHASE4_PRODUCTION_READINESS.md](docs/PHASE4_PRODUCTION_READINESS.md) for the full audit and NO-GO production recommendation.

### Disposable Phase 4 test reset

`Abandon Partial Operation` is hard-coded to the draft product `gid://shopify/Product/15608846975264` titled `Mockup Automation - TEST ONLY`. It is a metadata-only terminal action. Before enabling confirmation, the backend retrieves a complete live snapshot and requires exact equality with the operation's original product-media order, variant IDs, and variant-media associations, plus absence of every operation-created media ID from the product and variants. It never deletes Shopify Files. Each verified abandonment adds an immutable checkpoint containing the timestamp, reason, and verification evidence. Every nonterminal operation on the product must be individually abandoned or rolled back before a fresh publication is allowed.

## Safety and current limitations

- Shopify publishing is disabled by default and has not been exercised against a live store by the automated test suite. Product search remains available with `read_products` only.
- Shopify Admin GraphQL 2026-10 does not expose a complete inverse list of product references from a file. Consequently, the production adapter refuses global `fileDelete` automatically after detaching the operation product; it preserves the file and reports a conflict for manual ownership verification. Tests exercise deletion only through an explicit mocked ownership proof.
- Rollback results report product restoration separately from generated-file cleanup. `productRestored: true` means media ordering and variant associations match the original snapshot even when `cleanupConflicts` requires manual file cleanup.
- `rolled_back_files_retained` is terminal for publication locking, but the recorded retained files still require separate manual ownership review before any global deletion.
- No Printful sync, AI generation, background removal, garment recoloring, pricing, inventory, SKU, or fulfillment mutations.
- Metadata is local JSON beside the assets. SQLite remains reserved for a later phase when durable relational metadata is needed.
- EXIF orientation is normalized before background dimensions are chosen, so rotated portrait JPEGs produce portrait previews without stretching.
- The garment is centered and proportionally downscaled only if necessary to fit. It is never cropped or nonuniformly scaled.
- Uploaded files are available through strict RFC-compatible UUID-validated API routes, not a public source directory.
- A failed background replacement retains the previously validated background and labels that state explicitly.
- Current dependency-audit findings and deferred breaking remediations are recorded in [docs/SECURITY.md](docs/SECURITY.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the service boundary and image guarantees.
