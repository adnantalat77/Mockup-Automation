# Phase 4 production-readiness audit

Audit date: 2026-11-13  
Scope: publication, recovery, rollback, generated-file cleanup, abandonment, retained-file finalization, persistence, concurrency, and authorization.  
Method: offline source review and mocked automated tests. No live Shopify store request or mutation was performed.

## 1. Executive summary

**Recommendation: NO-GO for production publishing.** Phase 4 has strong fail-closed recovery controls for its designated disposable draft product, but it is not an approved general-production publishing system. This audit further restricts new publication to that exact test product and adds machine-readable cleanup outcomes. Publishing remains disabled by default.

Verified strengths include immutable original-state snapshots, mutation-intent checkpoints, complete publication-state pagination, explicit confirmation, feature/scope/origin/token gates, in-process product locking, uncertain `fileCreate` and `fileDelete` handling, post-mutation reconciliation, and guarded terminal finalization. The main blockers are the absence of a production approval/allowlist model, process-local rather than distributed locking, local JSON without integrity authentication or database transactions, and Shopify's inability in this design to prove global file-reference ownership.

## 2. Current architecture

The React UI calls an Express API. Shopify credentials and cached access tokens stay in the API process. `PublishingService` owns the publication state machine and writes append-only JSON checkpoints under `data/publications/<operation-id>/`. Each checkpoint is written to a unique temporary file and atomically renamed. `ShopifyService` performs GraphQL operations against the pinned `2026-10` Admin API. Sharp generation and preserved Phase 3 batch assets remain separate from publication metadata.

Only `gid://shopify/Product/15608846975264`, titled `Mockup Automation - TEST ONLY`, in `DRAFT` status can start a new publication after this audit. The same identity restriction already protects abandonment and retained-file finalization. Rollback remains operation-specific rather than product-allowlist-specific so a recorded operation can always attempt safe restoration.

## 3. State-transition matrix

| From | To | Trigger and required conditions | Rejected or unsafe cases |
|---|---|---|---|
| none | `validated` | New publish request; completed batch, exact disposable draft product, reliable mappings, valid previews, complete Shopify snapshot, no nonterminal product operation | Wrong product/title/status, incomplete snapshot, invalid batch/mapping, or blocker |
| `validated` | `publishing` | Initial operation checkpoint exists and product lock is acquired | Duplicate operation or active product lock |
| `publishing` | `published` | Every file, product reference, variant replacement, order job, and final live verification succeeds | Any partial item, ordering mismatch, GraphQL/user error, or external drift |
| `publishing` | `partial` | Recoverable item/order failure or startup interruption outside an uncertain non-idempotent boundary | Resume is operation-specific and requires reconciliation |
| `publishing` | `conflict` | Uncertain `fileCreate`, ambiguous live result, or external state conflict | Automatic `fileCreate` replay is forbidden |
| `partial` | `publishing` | Explicit resume with exact operation/batch identity, complete live reconciliation, and product lock | Wrong batch, abandoned/terminal state, external drift, uncertain creation, or competing operation |
| `published`, `partial`, `rollback_partial`, safe `conflict` | `rolling_back` | Explicit rollback, complete expected-state comparison, no uncertain create/delete boundary | Terminal operation, unknown created-file ownership, uncertain deletion, external drift, or product lock |
| `rolling_back` | `rolled_back` | Original associations/order verified and every generated file was safely deleted with explicit ownership proof | Retained, failed, uncertain, or mismatched cleanup |
| `rolling_back` | `conflict` | Product restored but files retained; restoration mismatch; external conflict | Never treated as fully cleaned up |
| `rolling_back` | `rollback_partial` | A retryable restoration/cleanup step failed before a terminal outcome | Interrupted `fileDelete` is instead a conflict and is not retried |
| `conflict` | `rolled_back_files_retained` | Explicit test-product finalization; all items have `retained_ownership_unproven`; no other structured conflict/error; fresh exact live restoration verification; confirmation and product lock | Legacy unstructured conflict, other cleanup outcome, missing/extra media/variant, non-draft/wrong product, duplicate request |
| eligible test `partial`, `rollback_partial`, `conflict` | `abandoned` | Explicit reason and confirmation; exact original state freshly verified; no generated references | Production product, incomplete/drifted state, generated reference, or terminal state |
| `publishing` | `partial` on restart | No uncertain non-idempotent intent is present | `create_file` without ID becomes conflict; pending `delete_file` becomes uncertain-cleanup conflict |
| `rolling_back` | `rollback_partial` on restart | No pending `delete_file` intent | Pending `delete_file` becomes conflict and cannot be replayed |
| `rolled_back`, `rolled_back_files_retained`, `abandoned` | none | Terminal | Resume, rollback, abandonment, and finalization are rejected |

Potentially unsafe transitions found and closed in this audit:

- A persisted `delete_file` intent could previously enter generic rollback recovery. It now becomes `cleanup_outcome_uncertain` and automatic deletion is blocked.
- New publishing was feature-gated but not product-restricted. It is now limited to the exact disposable draft product.
- Retained-file finalization previously inferred cleanup meaning partly from array/error counts. It now requires an explicit structured outcome per media ID and an exclusive structured conflict kind.

## 4. Structured cleanup evidence

Every generated media item can now record exactly one discriminated outcome:

- `deleted_safely`: deletion returned the expected ID after explicit exclusive-ownership proof.
- `retained_ownership_unproven`: global references cannot be enumerated; includes media ID, stable reason code, reason, and timestamp.
- `cleanup_failed`: ownership verification or reference cleanup failed before a confirmed delete result.
- `cleanup_outcome_uncertain`: `fileDelete` may have reached Shopify but no durable result was checkpointed.

Finalization accepts only `retained_ownership_unproven` with reason code `global_references_unverifiable`, matching the item's recorded generated media ID. Human-readable `errors` and `cleanupConflicts` remain audit context but do not classify cleanup.

Historical policy:

- Existing `rolled_back_files_retained` Task 015 checkpoints remain terminal and readable through their stored finalization evidence. They are not rewritten.
- A historical unfinalized conflict without per-item structured outcomes is rejected. The application does not infer ownership uncertainty from text or array lengths and does not silently migrate arbitrary conflicts.
- A future migration would require a separately authorized, explicit evidence-adoption workflow backed by an external ownership registry; none is activated here.

## 5. Shopify API findings

Verified against source and official Shopify 2026-10 documentation:

- `productVariantsBulkUpdate` supports existing `mediaId` association and the code sets `allowPartialUpdates: false`, checks `userErrors`, and verifies all requested variant IDs were returned. [Shopify reference](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productVariantsBulkUpdate)
- `productReorderMedia` is asynchronous and returns a `Job`; the code polls QueryRoot `job(id:)`, bounds polling, then verifies final order. [Shopify reference](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productreordermedia)
- `fileDelete` returns deleted IDs and user errors; the adapter verifies the requested ID. [Shopify reference](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fileDelete)
- Publication media, variants, and each variant's media are independently cursor-paginated and fail on missing/repeated/excessive cursors.
- Catalog product detail paginates top-level images/media/variants. Nested variant media beyond 100 was an uncovered completeness gap; it now fails closed rather than treating a partial association set as reliable.
- HTTP 401, HTTP 429, and GraphQL `THROTTLED` receive one bounded retry. Shopify uses calculated query-cost throttling and a leaky bucket. The client does not yet schedule proactively from `throttleStatus`, so sustained load can fail but does not bypass reconciliation. [Shopify rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)
- Authentication and GraphQL calls now have bounded timeouts. Non-idempotent ambiguous outcomes are not automatically retried by application recovery.
- Global inverse file references cannot be established by the current adapter, so production `verifyFileDeletionSafe` always returns a structured unproven-ownership result. Automatic global deletion therefore remains unavailable.

Untested assumption: official schema documentation and syntax tests support the pinned operations, but no live 2026-10 schema introspection or store mutation was performed during this audit.

## 6. Security findings

Verified controls:

- `SHOPIFY_PUBLISHING_ENABLED=false` is the default.
- Publishing requires a server-side authorization value of at least 32 characters, exact origin validation, and live `read_products`, `write_products`, and `write_files` scope verification.
- Destructive routes require explicit confirmation strings; recovery/finalization are addressed by strict UUID operation IDs.
- Tokens and client credentials never enter normal API responses or logs. Unhandled errors return a generic message.
- External images and staged uploads use HTTPS host allowlists, redirect validation, size limits, and timeouts.

Findings:

- **High:** authorization is a shared local secret, not per-user identity with roles, expiry, revocation history, or an independent approval record. Suitable only for the current local test boundary.
- **High:** locks are in process memory. Multiple API processes or hosts could mutate one product concurrently.
- **Medium:** Shopify user-error text is returned to the browser. It does not include locally stored credentials, but production should use stable public error codes and retain detailed vendor text only in a protected audit log.
- **Medium:** local checkpoint files are not cryptographically authenticated. A local user with write access can alter history.
- **Low:** the API is bound to `127.0.0.1` and uses HTTP. This is appropriate for the local test model but not a remote multi-user deployment.

## 7. Data integrity and rollback findings

Strong controls include byte-preserved sources, immutable original media/variant snapshots, intent-before-mutation checkpoints, result checkpoints, live reconciliation, atomic same-directory rename, malformed-checkpoint fallback, original-order verification, and separate product-restoration versus file-cleanup state.

Remaining gaps:

- **Mitigated for the supported local Windows deployment (Task 020):** the executable API now atomically owns the canonical data directory through a process-lifetime Windows named-pipe handle before checkpoint recovery or other mutable initialization. The existing per-product lock still serializes operations within that owner. This is not a distributed lock and does not approve multiple machines, network-share deployments, or noncanonical filesystem aliases.
- **Medium:** atomic rename prevents partial JSON visibility but no explicit file/directory `fsync` guarantees power-loss durability.
- **Medium:** checkpoint validation is structural and shallow; there is no hash chain or signature protecting historical integrity.
- **Medium:** rollback cannot locate a file created during the `fileCreate` response/checkpoint crash window because no media ID is known. It correctly stops for manual reconciliation.
- **Medium:** uncertain `fileDelete` cannot be resolved automatically without a file-existence/ownership reconciliation source. It now stops permanently rather than risking duplicate deletion.

## 8. Risk register

| Severity | Risk | Current mitigation | Required production mitigation |
|---|---|---|---|
| High | Publishing a real product without production governance | New publication restricted to one exact disposable draft product; flag off | Configurable product/store allowlist, per-operation approval, dry run, separate production credentials |
| High | Concurrent mutations from multiple API processes | In-process product lock | Database-backed lease/advisory lock and idempotency key |
| High | Shared authorization secret lacks user accountability | Origin, minimum length, timing-safe comparison, no browser persistence | Authenticated users, RBAC, short-lived sessions, two-person approval, immutable actor audit |
| High | Global generated-file ownership cannot be proven | Files retained; structured outcome; no automatic delete | External ownership/reference registry or Shopify-supported complete inverse reference API |
| Medium | Local checkpoint tampering or power-loss durability | Append-only files, atomic rename, fallback | Transactional durable store, fsync policy, hash-chained signed audit records, backups |
| Medium | Ambiguous non-idempotent response | Intent checkpoints; uncertain create/delete terminal conflicts | Provider idempotency support or deterministic external reconciliation |
| Medium | Rate-limit bursts and long jobs | One retry, bounded polls, timeouts | Cost-aware queue, jittered backoff, durable job runner, observability |
| Medium | Vendor error detail exposed to authorized UI | No token/credential logging; generic unknown errors | Stable public codes and protected structured audit logging |
| Low | Large catalog association limits | Bounded queries; nested overflow now rejected | Complete separate pagination or bulk read path |

## 9. Required work before production enablement

1. Keep the current test-product restriction and feature flag off.
2. Design a production allowlist keyed by shop and product, separate production credentials, explicit per-operation approval, actor identity, and preferably two-person approval.
3. Replace local JSON coordination with a transactional database, uniqueness constraints, cross-process product leases, and durable job execution.
4. Add tamper-evident audit records and operational backups.
5. Establish an authoritative generated-file ownership registry before enabling global deletion; otherwise permanently retain files and provide a manual Shopify-admin procedure.
6. Add a cost-aware Shopify request queue, exponential backoff with jitter, metrics, alerts, and operator runbooks.
7. Exercise a disposable development store with separately approved end-to-end tests for every mutation boundary, API version, rollback, recovery, and finalization.
8. Add stable external error codes and security review the deployment topology, authentication, TLS, secrets, and log retention.

## 10. GO / NO-GO

**NO-GO for production products.** The system is suitable for continued controlled testing against the single designated disposable draft product when the feature flag is deliberately enabled and the existing live-test runbook is followed. The audit found no basis to enable general production publishing, automatic global file deletion, or multi-user/multi-process deployment.
