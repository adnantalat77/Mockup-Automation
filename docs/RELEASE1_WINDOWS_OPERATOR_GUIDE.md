# Release 1 Windows operator guide

## Prerequisites and one-time installation

1. Install 64-bit Node.js 20.19 or newer (Node 22 LTS is recommended), npm 10+, and the application folder on a local Windows drive.
2. Open PowerShell in the application folder once and run `npm install` followed by `npm run build`.
3. Copy `.env.example` to `.env`. Never commit or share `.env`.
4. Set the exact `SHOPIFY_SHOP_DOMAIN`, client ID, client secret, API version, `DATA_DIR`, and `WEB_ORIGIN=http://127.0.0.1:3001`.
5. Leave `SHOPIFY_PUBLISHING_ENABLED=false` until the app scopes and operator process are approved. Read-only startup does not require `SHOPIFY_PUBLISHING_AUTH_TOKEN` or `SHOPIFY_PUBLISH_PRODUCT_IDS`; both may remain empty and all publishing endpoints stay disabled. For an authorized publishing workstation, set the flag exactly to `true`, provide a random authorization token of at least 32 characters, and list only exact approved Product GIDs. Values such as `yes`, `1`, and `enabled` are rejected rather than interpreted.
6. Release the Shopify app with `read_products`, `write_products`, and `write_files`. Do not request unrelated scopes.
7. Optionally create the desktop shortcut:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Install-DesktopShortcut.ps1
   ```

The exact daily launcher is `Start-Mockup-Automation.cmd` in the repository root. The shortcut points to that file and contains no secret or token.

## Daily use

1. Double-click **Mockup Automation** on the desktop or `Start-Mockup-Automation.cmd`.
2. The launcher validates configuration, dependencies, the production build, and persistent data path. It starts one hidden API instance and opens <http://127.0.0.1:3001>. An existing instance is accepted only after its private identity challenge proves the recorded process, startup, installation, and canonical data directory. If ownership is missing, corrupt, stale-but-live, mismatched, or unverifiable, preserve the runtime record, correct the reported condition, and do not start or kill another process.
3. Confirm Shopify shows **Connected** and review the granted scopes.
4. Search for and select the intended product. Confirm its title, Product GID, colors, nine-or-other expected variants, source transparency, and mapping warnings.
5. Upload the approved background and select **Generate All Mockups**.
6. Visually inspect every color preview. Automated hashes prove identity and integrity, but the operator must also verify artwork placement, antialiased edges, color, texture, proportions, and background quality.
7. Enter the local publishing authorization only when ready. Select **Validate new publication** and resolve every blocker.
8. Review the before/after cards and exact variant count. Type the exact product-specific confirmation and publish only the approved product.
9. Do not close or stop the application while publishing. Completion is valid only when history says verified/completed after exact Shopify gallery and variant readback. A partial or conflict result requires its displayed recovery or rollback path.
10. A completed or rolled-back Release 1 product cannot be independently published again.

## Closing and restarting

Closing the browser does not stop the application and cannot cancel an active Shopify operation. When no operation is running, double-click `Stop-Mockup-Automation.cmd`. It requests graceful HTTP shutdown and waits up to 15 seconds. If shutdown fails, it deliberately leaves the process and data lock intact; inspect logs and do not force-start another writer. A normal restart uses the same launcher and explicit `DATA_DIR`.

## Backups and recovery

Stop the application before offline backup commands. Create and validate a backup in a new destination:

```powershell
npx tsx apps/api/src/backup-cli.ts create "C:\path\to\data" "D:\Mockup Backups\2026-11-13"
npx tsx apps/api/src/backup-cli.ts validate "D:\Mockup Backups\2026-11-13"
```

Restore only after validating the backup and preserving the current data directory:

```powershell
npx tsx apps/api/src/backup-cli.ts restore "C:\path\to\data" "D:\Mockup Backups\2026-11-13" RESTORE_VALIDATED_BACKUP
```

A restore writes a marker and blocks every publication transition. Use the dashboard’s authorized **Reconcile Restored Data** workflow. Clearance requires complete read-only Shopify snapshots, exact terminal-state equality, a marker-fingerprint confirmation, durable evidence, and an unchanged second snapshot. Never manually delete the marker.

## Logs and troubleshooting

- Application and startup logs: `<application folder>\logs\`
- Persistent data: the exact `DATA_DIR` configured in `.env`
- A missing runtime message requires Node.js 20.19+.
- A missing build message requires `npm run build` during maintenance.
- A missing configuration message names the required `.env` keys without printing their values.
- A concurrent-launch message means another launcher is still verifying startup. Retry after it finishes. An authenticated existing instance opens normally; a missing/corrupt runtime record, PID mismatch, path mismatch, fake service, or failed identity challenge is intentionally not trusted or killed.
- Shopify disconnected or missing-scope messages require correcting the server-side app configuration; credentials never belong in the browser.
- Partial publication, uncertain file creation, external Shopify drift, restore journals, and corrupted checkpoints fail closed. Preserve all files and use the displayed recovery procedure.

Generated Shopify Files are retained during the supported rollback. Do not delete them globally without a separate ownership review. The application never invokes Shopify `fileDelete`.
