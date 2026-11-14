# Task 024 Release 1 production acceptance

## Verdict

**ENGINEERING PASS — LIVE ACCEPTANCE PENDING.** Local engineering, deterministic Shopify doubles, production frontend serving, Windows launch/shutdown, persistence, recovery, backup, and historical-integrity gates pass. This task does not authorize a live Shopify mutation, so production acceptance cannot be declared.

## Deployment architecture

Release 1 uses the built React assets and compiled Express API under an installed Node.js 20.19+ runtime. No Vite development server, Codex, GitHub, Electron, or manually managed terminal is used during normal operation. The root launchers are `Start-Mockup-Automation.cmd` and `Stop-Mockup-Automation.cmd`; an optional PowerShell utility installs a desktop shortcut.

The start launcher accepts exact `false` read-only mode without a publishing token or allowlist, while exact `true` mode requires both. Malformed flag values fail. Backend and launcher use the same exact-true rule, and the launcher never enables publishing. It also validates Shopify read configuration, persistent data, production origin, dependencies, runtime, and build output.

Existing-process reuse no longer trusts public health plus a local file. Separate random instance/shutdown capabilities and a startup UUID are bound to PID, actual installation, and canonical data directory. A constant-time authenticated identity challenge must match the runtime record before reuse or shutdown. A temporary named mutex serializes launchers; Task 020 remains final ownership. Missing/corrupt/stale/mismatched records, PID reuse, fake health services, identity failure, and uncertain live processes fail closed without force-kill or record overwrite.

The stop launcher reads an ignored local runtime capability and sends it only to the loopback shutdown endpoint. Incorrect tokens are rejected. Successful shutdown waits for HTTP requests and releases the Task 020 lock afterward; failure does not force-kill or enable a second writer. Closing the browser has no server effect.

## Local acceptance coverage

The complete mocked Release 1 lifecycle discovers a three-color Draft product with three sizes per color, validates three current transparent Shopify sources, generates three mockups, checks preserved source bytes and foreground/background pixels, verifies generation hashes, publishes under an exact product confirmation, replaces the gallery, maps all nine variants, verifies final order and associations, persists terminal evidence, and rejects a second publication.

Existing and expanded suites cover invalid configuration and credentials behavior, scopes, allowlisting, identity and title changes, missing/duplicate variants, media and association drift, source transparency and hashes, preview corruption, concurrent and duplicate publication, upload and mutation interruption, uncertain creation, verification failure, restart recovery, rollback without global deletion, retained-file finalization, strict checkpoints, atomic persistence, backup/restore, restoration reconciliation, stale and failed marker clearance, and Windows cross-process ownership.

Final hardening validation recorded 191 passing API tests and one passing web test (192 total), including 16 launcher/runtime-control tests. Lint, the shared/API/web production build, and `git diff --check` passed. Process-level acceptance ran the actual compiled API from the installation path containing spaces in both read-only and publishing-enabled fixture modes. Read-only mode served the dashboard, reported publishing disabled, rejected a publication request with 403, rejected an unauthenticated identity challenge with 401, authenticated concurrent reuse, stopped gracefully, and restarted safely. Enabled fixture mode also launched and stopped successfully without contacting Shopify. The offline backup CLI independently created and validated an isolated manifest. No live Shopify endpoint was contacted.

The compositor preserves source files byte-for-byte. Opaque foreground pixels retain their exact RGB values; transparent pixels reveal the selected background. Semitransparent antialiased pixels are alpha-composited normally, so their output pixel necessarily combines foreground and background. Scaling is uniform, fit-inside, centered, without enlargement, cropping, recoloring, or distortion. The operator must visually approve every generated color before publication; automated integrity checks do not substitute for visual quality review.

## Live acceptance plan — pending separate authorization

The historical Task 018 product `gid://shopify/Product/15608846975264` is ineligible and must not be reused. Before any mutation, the operator must identify a new disposable Draft product and provide its exact GID. Read-only preparation must record:

- Draft status, title, handle, complete gallery order, and all variant GIDs/options;
- exactly Black, Navy, and White with three sizes each where using the preferred fixture;
- three current transparent PNG sources and reliable color/variant associations;
- complete baseline screenshots/evidence and a validated offline local backup;
- exact allowlist entry, expected generated order, nine expected variant mappings, and typed confirmation;
- recovery steps for every mutation boundary and a separately authorized rollback decision.

The publication sequence would checkpoint intent, stage and create three generated files, attach them, replace nine variant associations, detach original product references without deleting global files, reorder the gallery, then obtain a complete exact readback before recording `published`. Expected rollback would reattach retained originals, restore nine immutable associations and original order, remove generated product references, retain generated global files, and verify exact restoration. Publication authorization does not imply rollback authorization.

No proposed test Product GID was supplied and no live read or mutation was performed. The live gate is therefore **PENDING AUTHORIZATION**. Production acceptance requires a separate prompt identifying the new disposable product and expressly authorizing the precise publication mutation sequence; rollback requires its own authorization.

## Historical and release boundaries

Task 018’s 64 live and 64 backup checkpoints remain byte-identical and terminal `rolled_back_files_retained`. Release 1 supports one background replacement per eligible product. Repeat replacement, Printful API integration, supplier registries, and permanent source libraries remain out of scope. Task 024 introduces no global Shopify deletion and no automatic cleanup of recovery evidence.
