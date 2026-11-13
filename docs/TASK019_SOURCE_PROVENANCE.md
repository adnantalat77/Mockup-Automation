# Task 019: Shopify Garment Source Provenance

## Trust boundary

A preserved local garment proves only that the same bytes remain locally available. Product GID, color name, transparency, asset age, and continued existence of a Shopify MediaImage do not prove those bytes are the product's current artwork. Preview generation and publication authorization therefore have separate trust requirements.

Local historical sources may be composited for inspection. Publication requires a fresh comparison with exactly one current, reliably color-associated Shopify source during the final locked publishing preflight.

## Provenance schema

New transparent garment assets and their batch items store schema version 1 with:

- exact Shopify Product GID and color;
- original MediaImage GID;
- CDN origin and path with query parameters removed;
- SHA-256 of downloaded source bytes;
- local garment asset UUID;
- acquisition and validation timestamps;
- decoded dimensions; and
- meaningful-transparency result.

No access token, credential, or signed URL query is persisted. Backgrounds, previews, and all new assets also record their byte SHA-256. Each generated item binds the source, background, and preview asset IDs and hashes in generation evidence.

Historical asset and batch JSON remains readable because new fields are optional in shared persistence types. Missing fields are never synthesized for old records.

## Freshness states

- `verified_current`: the source was downloaded from the one current reliable Shopify color association and validated. Publication still rechecks it.
- `historical_unverified`: local bytes match their acquisition hash, but no independently verifiable current product source is available.
- `source_changed`: the current Shopify bytes differ from preserved provenance. A newly acquired source is stored separately; historical bytes are not overwritten.
- `source_unavailable`: the current source cannot be downloaded or validated.
- `provenance_missing`: the cached asset predates or lacks complete schema-versioned provenance.

The batch comparison field records `matches_preserved`, `source_changed`, or `not_comparable`. When a changed current source is successfully acquired, the new asset is `verified_current` and the comparison records that it changed from historical bytes.

## Source acquisition

Shopify discovery must expose exactly one transparent image with a reliable single-color association and a MediaImage GID. Every variant of that color must reference the image or MediaImage alias. The downloaded bytes must decode as PNG and contain meaningful transparency. The application hashes the actual bytes, stores a new immutable garment asset, and records provenance on both asset and batch metadata.

A newly verified source never overwrites an older asset. Filename, dimensions, image metadata, and color labels are not used as artwork identity.

## Detached sources

After gallery replacement, the original source may disappear from current product media associations. The application may reuse the preserved asset to generate a local preview, but marks it `historical_unverified`. It cannot become publishable solely because its local hash and transparency still match acquisition records.

The current application has no independent supplier-artwork registry. The safe recovery workflow is to reattach or otherwise expose one trustworthy current Shopify source with reliable variant associations, then generate a new batch so the application can acquire and verify it. Operator acknowledgment alone cannot create freshness evidence.

## Final publication preflight

Immediately before checkpoint zero and any Shopify mutation, under the existing product lock, the server rechecks every color:

1. Complete schema-versioned provenance matches product, color, MediaImage, and local asset.
2. Garment bytes match asset and provenance SHA-256 and remain meaningfully transparent.
3. Background and preview bytes match generation evidence.
4. Shopify still exposes exactly one reliable current source for that color.
5. All current variants retain the expected color/source association.
6. The current source downloads as a meaningful transparent PNG.
7. Its SHA-256 matches the provenance used to generate the preview.

Missing, detached, ambiguous, opaque, unavailable, remapped, or changed sources block publication with a color-specific error. `publish()` runs this preflight again; an earlier readiness response or persisted `verified_current` flag is insufficient. Restarted batches receive no exception.

New publication operations snapshot provenance and generation evidence. Partial-operation recovery reruns freshness validation inside the product lock and requires the current batch preview, variant mapping, provenance, and generation evidence to equal the immutable operation. Historical operations without the Task 019 source-validation version retain their established recovery semantics. Preview bytes are hashed again immediately before staged upload to close the local preflight-to-use window.

## Historical recovery compatibility

Task 018 publication checkpoints and finalized rollback records are not rewritten. Recovery, rollback, abandonment, and retained-file finalization continue to use their immutable snapshots. Provenance requirements apply only when a batch attempts a new publication.

## Known limitations

Shopify associations prove what is currently attached to the product, not what an external print-on-demand supplier considers canonical. After complete-gallery replacement, repeat background replacement is blocked until a trustworthy current garment source is restored or independently exposed. This is a HIGH production-workflow limitation for the fixed Task 024 release plan and must be resolved within Tasks 020–023. A future supplier integration would need its own authenticated identity, artwork revision, and byte-verification contract; this implementation does not invent one.
