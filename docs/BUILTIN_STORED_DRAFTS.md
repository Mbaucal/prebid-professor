# Stored built-in draft packages — MBA-44 / MBA-48

## Scope of this step

`draft-release-store.mjs` is a storage adapter for the real server-generated candidate package. It reuses the existing `releases` table and artifact layout rather than adding another generator or replacing legacy releases. It saves/reopens one exact JS/CSS/config/Prebid package. This is **not yet a connected Save/Publish feature**: no HTTP route imports this adapter, no UI button activates it, and no new binding is added to Wrangler. The current candidate ZIP still works independently.

The explicit store argument is a caller contract, **not proof of Cloudflare resource isolation**. Do not wire it to the current shared DB/BUILDS. MBA-19 must verify actual resource IDs before hosted writes.

## What is preserved

The generated manifest is parsed from its exact bytes. The adapter copies input byte arrays before the first await, validates the exact file inventory, checks every SHA-256/size, and cross-checks config, site, runtime pin and Prebid pin. It does not trust a mutable `candidate.manifest` property or the bucket's custom metadata.

A content-addressed `builtin-draft-<package-sha256>` identity includes the site and all exact files, including manifest.json. It preserves the exact runtime version/schema/source hash, config hash, optional Prebid artifact/version/modules and per-file hashes. GPT-only has nine files, no Prebid key and no placeholder Prebid pin. Repeating the same package saves no new release; different bytes produce a new package. The first successful reservation retains actor/note provenance.

This does not deduplicate semantically equal packages with different build timestamps. A retry must supply the **same server-generated candidate**, not regenerate it with a new timestamp. The later HTTP layer needs a reviewed candidate receipt/idempotency key and must enforce authentication, authorization, payload limits, configuration drift and resource policy before calling this adapter. Browsers must not be allowed to upload arbitrary artifacts into it.

## Save ordering and recovery

1. Start a D1 `first-primary` session and verify the selected site in the supplied test store.
2. Reserve a durable intent in `builtin_draft_uploads` before writing any R2 object.
3. Create each exact object conditionally (`If-None-Match: *`) under that draft's immutable release prefix. Verify actual bytes after creation, including a concurrent-create result.
4. Register the existing `releases` row, a metadata-only audit entry and the intent's `stored` state in one D1 batch transaction. Database assertions refuse any conflicting release metadata.
5. Reads validate registration, inventory and all bytes. Historical reads never regenerate using the currently recommended runtime.

R2 and D1 are **not one shared transaction**. An interrupted save retains its tracked `uploading` intent and any already created files; it does not advertise a ready release. A retry verifies and resumes the same package. No automatic delete is performed on a thrown/uncertain response: the SQL commit may have succeeded even if its response was lost. A saved package with missing/corrupt bytes fails instead of being silently overwritten or regenerated.

There is deliberately no destructive cleanup API in this step. Abandoned intents, quotas/retention and safe site deletion need an explicit reviewed reconciliation policy before hosted activation. The extension's publisher foreign key is restrictive so its tracking metadata cannot silently disappear; generic site deletion must be assessed along with any object-first legacy cleanup path.

## Publication/deletion boundary

Stored packages are always draft/review candidates with `completeRelease:false` and `publishable:false`. Storage integrity is not staging or ad-delivery approval.

Legacy internal staging/production/rollback, cross-account deployment dispatch and generic release deletion now explicitly reject the reserved built-in draft ID/version prefix before file operations or external dispatch. Existing legacy release identifiers continue through their prior paths. These guard changes are on PR #26 only, not main.

Do not serve or install `implementation.html` merely because the package was saved; that integration example may call real Google ads. Local verification uses the repository's mock ad library and blocked external requests instead.

## Schema

`worker/runtime/sql/builtin-draft-storage.sql` is an additive extension to Tessera's existing schema. It has no publisher seeds and is deliberately **outside the automatically applied migrations directory**. Tests initialize SQLite from the DDL-only portion of the existing initial schema and seed only synthetic `.invalid` sites. No production migration was applied.

## Verification commands

```sh
npm ci --ignore-scripts
node scripts/prepare-builtin-runtime.mjs
node --experimental-strip-types --test tests/runtime/draft-release-store.test.mjs
node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs --test tests/runtime/stored-draft-legacy-guards.test.mjs
node --experimental-strip-types scripts/verify-artifact-candidate.mjs .generated/artifact-candidate-verification
node --experimental-strip-types scripts/verify-stored-draft.mjs .generated/artifact-candidate-verification .generated/stored-draft-verification
python scripts/verify-runtime-browser.py .generated/stored-draft-verification/reopened/readable
python scripts/verify-runtime-browser.py .generated/stored-draft-verification/reopened/minified
python scripts/verify-artifact-layout.py .generated/stored-draft-verification/reopened
```

Tests use actual SQLite (Node's `node:sqlite`) and a small D1-session adapter. R2 is a fault-injectable test double, not real Cloudflare R2. The restart probe persists SQLite and the simulated object's exact bytes to local disk, closes the store, launches a new Node process and reopens it. Browser fixtures then come from **the re-read stored files**, not a fresh regeneration.

Covered: idempotency/concurrent save, note/actor provenance, GPT-only, site isolation, mutation of caller bytes, manifest/pin mismatches, partial R2 writes, lost reservation/SQL-success responses, transaction rollback on audit failure, corrupted/missing bytes, read-only historical reopening, storage path validation, unchanged current site/config/channel, and actual legacy publish/rollback/delete/dispatch refusal.

## Remaining before user acceptance

No newly hosted UI/deployment or real D1/R2 behavior is proven here. Remaining: verified isolated bindings, authenticated reviewed-candidate save/list/download endpoints and UI, safe cleanup/resource budgeting, full configured-overlay support, live approved staging, explicit promotion/whole-release rollback and cross-account Cloudflare publication. The user should not repeat old ads.txt tests for this internal layer.

## Platform contracts consulted

- D1 batches are SQL transactions; errors roll back the batch: https://developers.cloudflare.com/d1/worker-api/d1-database/
- R2 conditional writes return null on an unmet precondition: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/

These API contracts inform the adapter. Passing its local tests is not evidence of a hosted Cloudflare integration test.
