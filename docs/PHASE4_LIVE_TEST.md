# Phase 4 separately approved live test

Do not run this procedure against a production product without a separate, explicit approval. Automated tests use mocked Shopify responses and make no live mutations.

1. In Shopify, create a disposable draft test product with representative color and size variants. Do not use an active Equipd Wear or Printful-managed product.
2. Export or otherwise record the test product's current media and variant associations independently.
3. In the Shopify Dev Dashboard, manually grant only `read_products`, `write_products`, and `write_files`, release the configuration, and reinstall or approve the app as Shopify requires. The application never changes scopes itself.
4. Confirm `data/publications/` is writable and backed up. Keep the API bound to `127.0.0.1`; do not expose it publicly.
5. Set `SHOPIFY_PUBLISHING_ENABLED=true` and set `SHOPIFY_PUBLISHING_AUTH_TOKEN` to a newly generated random secret of at least 32 characters. Restart the local application.
6. Build a completed Phase 3 batch for the disposable product. First run **Validate readiness** only. Review the exact image count, affected variants, color mappings, and before/after previews.
7. After a separate approval for this specific test product and batch, enter the local authorization secret, use **Publish All**, and confirm the publication dialog. Do not close the API while it is running.
8. Verify in Shopify that each created image is associated with every intended size variant for its color, originals remain present, and no product fields outside media changed. Retain the publication operation ID and checkpoint folder.
9. Test **Restore Original Images** only after separately approving rollback. Verify original associations and ordering, and confirm only operation-created files were removed.
10. Immediately set `SHOPIFY_PUBLISHING_ENABLED=false`, clear the authorization secret, restart the API, and remove the temporary app write scopes if they are no longer needed.

If any step reports `partial`, `rollback_partial`, or `conflict`, stop. Preserve the checkpoint directory, inspect the current Shopify product state, and resolve the discrepancy manually before retrying. Never delete media merely because its filename resembles a generated mockup.
