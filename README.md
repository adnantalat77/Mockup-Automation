# Mockup-Automation

Local Windows application for Equipd Wear. Phase 1 composites an original transparent apparel PNG over a user-supplied JPEG/PNG background. Phase 2 adds optional read-only Shopify catalog access. Phase 3 generates and reviews one local preview per reliably mapped garment color. Phase 4 adds guarded bulk publishing and recovery, disabled by default.

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

1. Upload a JPEG or PNG background (maximum 12 MB by default).
2. Upload an original transparent garment PNG. The server verifies a meaningful number of actual alpha pixel values; a `.png` suffix or a few stray transparent edge pixels is not enough. Partially transparent antialiased pixels count as transparency.
3. Select **Generate Preview** and compare the original garment to the generated PNG.

## Optional Shopify read-only setup

Create and install an app through Shopify's Dev Dashboard, release a configuration with only the `read_products` Admin API scope, and confirm the app and Equipd Wear store are in the same Shopify organization. Client credentials are not eligible for stores outside the app's organization.

Copy `.env.example` to the repository-root `.env` and set:

```text
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
SHOPIFY_API_VERSION=2026-10
```

Restart `npm run dev`. The backend exchanges these credentials for a short-lived token, caches it only in memory, refreshes it shortly before expiry, and checks for `read_products`. Credentials and tokens never enter browser responses or application logs. If the variables are absent, manual Phase 1 operation continues unchanged.

Product image-to-color mappings are considered reliable only when Shopify exposes a direct variant image or media association. Shared and unassociated images are marked for manual review. A Shopify image must pass the same decoded-format and meaningful-alpha validation as a manual garment before it can be used for preview generation.

## Bulk mockup generation

After selecting a Shopify product and uploading one background, choose **Generate All Mockups**. The backend paginates product images, media, and variants, then creates one job per Shopify color. A color is generated only when exactly one transparent PNG has a direct variant/media association. Missing sources and conflicts are skipped with a manual-review explanation; filenames and alt text are never used to guess.

At most two colors are processed concurrently, a batch is limited to 50 colors, transient Shopify failures receive one retry, and cancellation stops queued work while allowing an in-flight image write to finish safely. Progress and per-color results are persisted under ignored local `data/batches/` metadata, and the dashboard restores the most recently updated batch. Interrupted jobs are marked for regeneration when the API restarts. Completed colors can be regenerated individually or downloaded together as an uncompressed ZIP archive. ZIP creation is limited to 150 MB of source preview data.

Local source assets are stored beneath ignored `data/uploads/`; generated previews are stored beneath ignored `data/generated/`. Files receive generated UUID names. To change limits or ports, copy `.env.example` to `.env` and edit local values.

## Phase 4 publishing and recovery

Publishing remains unavailable unless all three server-side gates pass: `SHOPIFY_PUBLISHING_ENABLED=true`, a private `SHOPIFY_PUBLISHING_AUTH_TOKEN` of at least 32 characters, and live verification of `read_products`, `write_products`, and `write_files`. The authorization value is entered only for a protected operation and sent in `X-Publish-Authorization`; it is not persisted by the browser. Mutation requests also require an approved local origin and an explicit `PUBLISH` or `ROLLBACK` confirmation value.

Before publishing, the API re-fetches the product, validates every color-to-variant association and generated PNG, and writes checkpoint zero under ignored `data/publications/`. Every successful Shopify mutation creates another immutable, sequence-numbered checkpoint. Original media are retained. Rollback removes only media IDs recorded as created by that operation, restores recorded variant associations and ordering, and stops for manual review if unrelated media changed.

The Shopify workflow uses staged uploads, `fileCreate`, file-processing polling, `fileUpdate` product references, `productVariantAppendMedia`/`productVariantDetachMedia`, `productReorderMedia`, and `fileDelete`. It does not use deprecated `productDeleteMedia`. See [docs/PHASE4_LIVE_TEST.md](docs/PHASE4_LIVE_TEST.md) before any separately approved live test.

## Safety and current limitations

- Shopify publishing is disabled by default and has not been exercised against a live store by the automated test suite. Product search remains available with `read_products` only.
- No Printful sync, AI generation, background removal, garment recoloring, pricing, inventory, SKU, or fulfillment mutations.
- Metadata is local JSON beside the assets. SQLite remains reserved for a later phase when durable relational metadata is needed.
- EXIF orientation is normalized before background dimensions are chosen, so rotated portrait JPEGs produce portrait previews without stretching.
- The garment is centered and proportionally downscaled only if necessary to fit. It is never cropped or nonuniformly scaled.
- Uploaded files are available through strict RFC-compatible UUID-validated API routes, not a public source directory.
- A failed replacement upload retains the previously validated selection and preview and labels that state explicitly.
- Current dependency-audit findings and deferred breaking remediations are recorded in [docs/SECURITY.md](docs/SECURITY.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the service boundary and image guarantees.
