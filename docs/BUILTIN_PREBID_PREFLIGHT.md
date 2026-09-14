# Built-in Prebid artifact check — MBA-44 / MBA-48

This is an incremental, read-only step toward the full built-in release pipeline. It does not make source preview a production release.

## Operator flow

In **Generator Profiles**, use **Check Prebid file** below the Built-in runtime card. It first reads the current saved configuration and then checks the current uploaded Prebid artifact. Nothing is fetched from R2 until this explicit check. Source preview remains available separately. GPT-only mode does not need or read a Prebid artifact.

A successful result means **stored bytes and module declarations checked**, not live auction compatibility or permission to publish. Missing modules, ambiguous current builds, unreadable files, changed checksums or mismatched metadata appear as actionable errors. Unknown bidder aliases/User ID mappings are not guessed into a passing result.

## Server behavior

The authenticated GET `/api/publishers/:id/builtin-runtime-prebid-check` requires the reviewed configuration checksum and runtime hash. The server reads saved configuration and current-build metadata in a single SELECT-only snapshot, derives requirements from the actual preview adapter, and reads only that site's uploaded build in R2. It verifies:

- exactly one current build for the selected site;
- site/build-scoped storage key, nonempty file, maximum 20 MB;
- full SHA-256 against upload metadata;
- Prebid version and Modules comment declarations against D1 metadata;
- bidder/User ID/CMP and enabled currency/floors module requirements.

A second read rejects a report if configuration or selected-build metadata changed while the artifact was being inspected. The future complete-release builder must rerun this validation and pin the exact artifact bytes/hash; a historical check is not a publish authorization.

There is no eval, ad auction, external fetch, migration, D1/R2 write, stored validation flag, email, CMS call, runtime selection or publication. The file's header declares modules; it cannot prove executable module registration or live bidder compatibility. That requires the isolated browser and approved staging tests.

## Tests

`node --test tests/runtime/prebid-artifact-check.test.mjs tests/runtime/prebid-preflight-service.test.mjs`

After `npm run test:builtin` prepares the approved bundle, also run `node --experimental-strip-types --test tests/runtime/builtin-prebid-integration.test.mjs`.

Synthetic unit/service fixtures cover SHA/size/header mismatches, missing mappings, no execution/network, no writes, site isolation, stale review/build/runtime and explicit GPT-only behavior. Integration tests use the actual snapshot reader and generator adapter with fake D1/R2. Existing bundled compiler tests remain separate. These tests do not use real publisher credentials or a live GAM/Prebid auction.
