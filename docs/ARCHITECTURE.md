# Phase 1 architecture

The browser talks only to the local Express API. Uploads are held in memory while Sharp validates their decoded content, then written under `data/` with UUID filenames. No original filename is used as a filesystem path.

- `apps/web`: React/Vite dashboard on port 3000.
- `apps/api`: Express upload, asset, validation, and Sharp compositing endpoints on port 3001.
- `packages/shared`: transport types shared by both applications.
- `data/uploads`: original backgrounds and garments (ignored by Git).
- `data/generated`: generated PNG previews (ignored by Git).

SQLite is intentionally deferred because Phase 1 metadata can be stored beside local assets. Shopify services, credentials, catalog reads, publishing writes, variant mapping, rollback, AI edits, and batch processing are outside Phase 1.

## Image guarantees

The API decodes files with Sharp instead of trusting extensions or browser MIME types. Garment PNGs are converted to raw RGBA for alpha-pixel inspection and rejected when all pixels are opaque. Preview generation uniformly scales the complete garment only when it is larger than the background, centers it, never crops it, and writes a new high-quality PNG. Input buffers and files are not overwritten.
