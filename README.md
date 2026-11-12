# Mockup-Automation

Phase 1 local Windows application for Equipd Wear. It composites an original transparent apparel PNG over a user-supplied JPEG/PNG background while preserving both source files. Shopify search and publishing are visibly disabled and are not implemented.

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

Open <http://localhost:3000>. The API listens on <http://localhost:3001>. The environment file is optional because local defaults are built in.

```powershell
npm test
npm run build
npm run lint
```

These commands are root scripts backed by npm workspaces. `npm test` runs API image/upload tests; `npm run build` builds shared types, API, and web production assets.

## Local workflow

1. Upload a JPEG or PNG background (maximum 12 MB by default).
2. Upload an original transparent garment PNG. The server verifies actual alpha pixel values; a `.png` suffix alone is not enough.
3. Select **Generate Preview** and compare the original garment to the generated PNG.

Local source assets are stored beneath ignored `data/uploads/`; generated previews are stored beneath ignored `data/generated/`. Files receive generated UUID names. To change limits or ports, copy `.env.example` to `.env` and edit local values.

## Safety and current limitations

- No Shopify credentials, API calls, publishing, Printful sync, AI generation, background removal, garment recoloring, or batch processing.
- Product search and publishing controls are future-phase placeholders and disabled.
- Metadata is local JSON beside the assets. SQLite remains reserved for a later phase when durable relational metadata is needed.
- The garment is centered and proportionally downscaled only if necessary to fit. It is never cropped or nonuniformly scaled.
- Uploaded files are available through ID-validated API routes, not a public source directory.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the service boundary and image guarantees.
