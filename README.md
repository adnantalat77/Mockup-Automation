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

The API acquires an OS-backed exclusive lock for its canonical `DATA_DIR` before initializing any persistent service. Starting a second API against the same local Windows data directory fails safely with a clear duplicate-instance diagnostic; it does not read-repair or write shared state. Graceful shutdown releases the lock after the HTTP server closes, and Windows releases it automatically after a crash. See [docs/TASK020_SINGLE_INSTANCE.md](docs/TASK020_SINGLE_INSTANCE.md).

Publication and rollback recovery validate unique, complete Shopify snapshots; exact gallery ordering; exact variant GID sets and associations; internally consistent checkpoints; and all durable terminal steps. Contradictory complete checkpoints fail startup, while truncated writes fall back to the previous complete checkpoint. See [docs/TASK021_RECOVERY_INTEGRITY.md](docs/TASK021_RECOVERY_INTEGRITY.md).

Critical local records use flushed temporary writes and atomic promotion, asset reads enforce recorded SHA-256 evidence, and malformed batch recovery fails closed. Backups and restores are explicit offline operations protected by the API data-directory lock; restored state never automatically replays Shopify mutations. See [docs/TASK022_OPERATIONAL_RESILIENCE.md](docs/TASK022_OPERATIONAL_RESILIENCE.md).

A marked restored data directory remains mutation-blocked until an authorized operator runs complete read-only Shopify reconciliation. Clearance accepts only an exact terminal published, rolled-back, retained-file rollback, or abandoned state for every affected product, records durable evidence, rechecks for drift, and atomically preserves the cleared marker. See [docs/TASK023_END_TO_END_STABILIZATION.md](docs/TASK023_END_TO_END_STABILIZATION.md).

Open <http://127.0.0.1:3000>. The API listens on <http://127.0.0.1:3001>. During local development, Vite proxies same-origin `/api` requests to the API, avoiding browser CORS and `localhost` IPv4/IPv6 resolution differences. The environment file is optional because local defaults are built in. For separate-origin production hosting only, set `VITE_API_URL` to the deployed API origin.

```powershell
npm test
npm run build
npm run lint
```

These commands are root scripts backed by npm workspaces. `npm test` runs API image/upload tests; `npm run build` builds shared types, API, and web production assets.

## Windows Release 1 launcher

After the one-time installation (`npm install`, `.env` configuration, and `npm run build`), normal operation does not use Vite or require an npm command. Double-click `Start-Mockup-Automation.cmd` in the repository root, or run `scripts\windows\Install-DesktopShortcut.ps1` once to create **Mockup Automation** on the desktop. The launcher validates Node.js 20.19+, the production build, dependencies, explicit persistent `DATA_DIR`, Shopify read configuration, an exact `true`/`false` publishing flag, and the production loopback origin. Read-only mode (`SHOPIFY_PUBLISHING_ENABLED=false`) requires neither a publishing authorization token nor a product allowlist. Enabled publishing additionally requires both. The launcher never changes the flag. It starts the compiled API hidden, serves the built dashboard at <http://127.0.0.1:3001>, retains logs under ignored `logs/`, and opens the default browser.

An existing process is reused only after a random startup capability authenticates a loopback identity challenge and binds the response to the recorded PID, startup UUID, actual installation path, and canonical locked data directory. Health output alone is never trusted. A Windows named mutex coordinates concurrent launchers only during startup; it is released automatically and does not replace the Task 020 process-lifetime data lock. Missing, corrupt, stale, mismatched, or unverifiable runtime ownership fails closed without killing a process or overwriting an uncertain record.

Closing the browser does not stop the API or interrupt work. Double-click `Stop-Mockup-Automation.cmd` to request token-protected graceful shutdown. The API stops accepting requests, waits for active requests, and releases its data-directory lock only after HTTP shutdown succeeds. The stop command never force-kills a failed shutdown. See [docs/RELEASE1_WINDOWS_OPERATOR_GUIDE.md](docs/RELEASE1_WINDOWS_OPERATOR_GUIDE.md).

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

New publication is eligible only for the exact disposable draft test product or a product GID explicitly listed in the server-side `SHOPIFY_PUBLISH_PRODUCT_IDS` allowlist. The allowlist is empty by default. A real product also requires the exact confirmation `PUBLISH <product GID>`; search visibility alone never grants publishing eligibility.

Before publishing, the API completely paginates product media, variants, and each variant's media, validates exactly one generated PNG per color and exactly one color mapping for every variant, and writes checkpoint zero under ignored `data/publications/`. Every mutation has a preceding intent checkpoint and a following result checkpoint. Original Shopify Files are retained even after their product references are detached. Partial retries reconcile the immutable snapshot against live Shopify state and stop on external drift or an uncertain file-creation result.

New publication readiness and partial-operation recovery are separate workflows. **Publish All** only creates a new operation when no nonterminal operation blocks the product. An eligible `partial` history entry is checked using its immutable operation and batch IDs plus a complete live snapshot, then continued with **Resume Publication**. The resume endpoint cannot create a new operation and reconciles live state again before continuing.

A fully verified `published` operation is a completed Release 1 audit record. Release 1 permits one background-replacement publication per product: any durable `published`, `rolled_back`, or `rolled_back_files_retained` operation makes later batches ineligible for a second independent publication. Partial operations must be resumed or recovered, while rollback remains available for the original operation. Verified abandonment of the narrowly scoped disposable test attempt may permit its intended clean retry. Startup decisions and checkpoint zero are serialized under the product lock. Historical predecessor fields remain readable without authorizing repeat replacement. See [docs/TASK017A_PUBLICATION_LIFECYCLE.md](docs/TASK017A_PUBLICATION_LIFECYCLE.md).

Phase 3 preserves each validated transparent garment source unchanged in ignored local storage. This lets a later batch reuse the same color source after complete gallery replacement has detached the original from the Shopify product. Generated background composites are never promoted to garment sources.

If startup finds a persisted `create_file` intent without a checkpointed Shopify media ID, the operation is marked as an uncertain-creation conflict. Neither restart recovery nor a partial-operation retry repeats `fileCreate`; manual reconciliation is required to locate and establish ownership of any file Shopify may have created.

The Shopify workflow uses staged uploads, `fileCreate`, file-processing polling, `fileUpdate` product references, `productVariantsBulkUpdate`, `productVariantDetachMedia` for originally unassigned variants, and `productReorderMedia`. The supported rollback mode does not invoke `fileDelete` and does not use deprecated `productDeleteMedia`. See [docs/PHASE4_LIVE_TEST.md](docs/PHASE4_LIVE_TEST.md) before any separately approved live test.

Variant publishing uses `productVariantsBulkUpdate` with `mediaId` and `allowPartialUpdates: false`. This replaces an existing variant image association instead of attempting to append a second association. The immutable pre-publication variant-media snapshot remains the rollback source of truth; rollback restores each original `mediaId` before removing the generated product reference.

Published ordering is deterministic: the final product gallery contains only generated media in Phase 3 batch color order. After generated files are attached and all variants are replaced, the API detaches every original product reference without globally deleting its Shopify File, reorders the generated gallery, and verifies exact media and variant equality from a fresh complete snapshot. Checkpoints are written to uniquely named temporary files and atomically renamed; startup ignores temporary or malformed files and recovers the newest structurally valid checkpoint. Historical append-style checkpoints retain their original semantics.

New garment sources carry schema-versioned Shopify provenance and SHA-256 hashes. Preserved detached sources remain available for local preview inspection but are `historical_unverified` and cannot authorize publication. Final publishing preflight redownloads the one current reliably associated source per color, revalidates PNG transparency and variant mapping, compares source bytes, and verifies the source/background/preview generation hashes. See [docs/TASK019_SOURCE_PROVENANCE.md](docs/TASK019_SOURCE_PROVENANCE.md).

For a separately approved controlled real-product test, add only that exact Product GID to `SHOPIFY_PUBLISH_PRODUCT_IDS`, retain the existing feature flag, authorization token, origin, and scope gates, restart the API, generate and review a complete batch, and type the product-specific confirmation shown by the UI. Do not put credentials or access tokens in the allowlist. See [docs/TASK017_GALLERY_REPLACEMENT.md](docs/TASK017_GALLERY_REPLACEMENT.md).

`productReorderMedia` jobs are polled through Shopify's `job(id: ID!) { id done }` QueryRoot field. A missing job, GraphQL error, or failure to complete within 20 polls at 500 ms leaves the publication partial. Recovery first reconciles the complete live product state: an already-completed target order is checkpointed without another reorder, while a safe but unfinished order can retry only the idempotent reorder step. Created files and completed variant replacements are never repeated.

Rollback requires the explicit API mode `no_global_delete`. It restores the immutable original product gallery and variant associations, removes generated references from that product, and deliberately retains every generated Shopify File globally. The service never calls ownership verification or `fileDelete` in this mode. After exact restoration is freshly verified, **Check Rollback Finalization** can approve **Finalize Restored Product**. Finalization performs no Shopify mutation and records terminal `rolled_back_files_retained` status. The action is operation-specific, authorization-protected, explicitly confirmed, product-locked, and checkpointed after a second live verification. See [docs/TASK018A_NO_GLOBAL_DELETE_ROLLBACK.md](docs/TASK018A_NO_GLOBAL_DELETE_ROLLBACK.md).

Retained-file finalization supports the disposable Draft test product and exact real-product GIDs still present in `SHOPIFY_PUBLISH_PRODUCT_IDS`. Real-product identity must match the immutable operation, but Draft status is not required. All restoration, structured retained-ownership evidence, complete-snapshot, absence-of-generated-reference, confirmation, and product-lock checks remain mandatory. An uncertain `fileDelete` result is a nonretryable conflict, never an ordinary rollback retry.

Cleanup evidence distinguishes historical ownership-unproven retention from explicit operator-directed retention using `global_deletion_prohibited_by_operator`. Finalization accepts either complete, internally consistent retained outcome, but rejects mixed, missing, failed, or uncertain cleanup evidence. Existing finalized checkpoints remain terminal and readable; legacy unfinalized conflicts without structured outcomes fail closed.

### Disposable Phase 4 test reset

`Abandon Partial Operation` is hard-coded to the draft product `gid://shopify/Product/15608846975264` titled `Mockup Automation - TEST ONLY`. It is a metadata-only terminal action. Before enabling confirmation, the backend retrieves a complete live snapshot and requires exact equality with the operation's original product-media order, variant IDs, and variant-media associations, plus absence of every operation-created media ID from the product and variants. It never deletes Shopify Files. Each verified abandonment adds an immutable checkpoint containing the timestamp, reason, and verification evidence. Every nonterminal operation on the product must be individually abandoned or rolled back before a fresh publication is allowed.

## Safety and current limitations

- Shopify publishing is disabled by default and has not been exercised against a live store by the automated test suite. Product search remains available with `read_products` only.
- Catalog search follows Shopify cursors for up to 100 matching results and fails with an instruction to narrow the query rather than silently truncating a broader match set. Product detail and publication snapshots independently paginate media and variants; incomplete nested associations fail closed.
- Shopify Admin GraphQL 2026-10 does not expose a complete inverse list of product references from a file. The explicit rollback mode therefore preserves generated global files by operator direction and never attempts ownership verification or `fileDelete`.
- Rollback results report product restoration separately from generated-file cleanup. `productRestored: true` means media ordering and variant associations match the original snapshot even when `cleanupConflicts` requires manual file cleanup.
- A cached garment hash proves local integrity, not current artwork freshness. Detached, ambiguous, changed, unavailable, or provenance-free sources can generate inspection previews where safe but block publication.
- Release 1 uses the current transparent Shopify media attached and reliably mapped to the exact product/color/variants as its input. Printful API integration, a permanent reusable garment-source library, supplier registries, and repeat background replacement are intentionally out of scope. Detached historical sources remain unable to authorize a new publication.
- `rolled_back_files_retained` is terminal for publication locking, but the recorded retained files still require separate manual ownership review before any global deletion.
- No Printful sync, AI generation, background removal, garment recoloring, pricing, inventory, SKU, or fulfillment mutations.
- Metadata is local JSON beside the assets. SQLite remains reserved for a later phase when durable relational metadata is needed.
- EXIF orientation is normalized before background dimensions are chosen, so rotated portrait JPEGs produce portrait previews without stretching.
- The garment is centered and proportionally downscaled only if necessary to fit. It is never cropped or nonuniformly scaled.
- Uploaded files are available through strict RFC-compatible UUID-validated API routes, not a public source directory.
- A failed background replacement retains the previously validated background and labels that state explicitly.
- Current dependency-audit findings and deferred breaking remediations are recorded in [docs/SECURITY.md](docs/SECURITY.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the service boundary and image guarantees.
