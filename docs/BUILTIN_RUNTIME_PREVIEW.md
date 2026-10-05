# Built-in source preview — MBA-44 / MBA-45 / MBA-48

This implementation adds a real vertical preview slice: bundled approved builder → exact runtime selection → saved site configuration read → Generate preview → inspect/copy/download. No template upload is required for this flow.

## Explicit boundary

This is **not** the completed production Generate/release pipeline. The existing top-level Generate and uploaded profiles remain unchanged. Source preview does not save a profile/pin to the selected site, write D1/R2, create a release, include/validate a Prebid.js build, call a publisher CMS or publish ads. This matters because environment data isolation is not yet established (MBA-19). Do not install the preview download on production.

The new card is mounted directly in the existing Generator Profiles workspace. Legacy uploads are collapsed and still available for old releases. The new panel uses the actual publisherId prop, not DOM or domain matching, and discards responses after site switches.

## Bundle

`npm run build` and `npm run dev` first verify/unpack the vendored source archive into a readable, statically imported module. No dynamic evaluation or remote template loading is used by the Worker. Exact original/module checksums and reproduction are in `vendor/reference391/README.md`.

An engine source-closure hash covers the builder, reference bridge, consent patch, existing compiler, version-pin module and preview adapter. The UI must acknowledge Preview and send that exact version/hash. The generated ads.js has a separate content checksum. A preview is not promoted to Stable.

## Review consistency

A single SELECT-only D1 batch reads the site configuration, ad units, bidders, overrides, size maps and rules. GET returns a review checksum. POST takes a fresh snapshot and refuses changed configuration or changed runtime source identity. No snapshot fields or source code can be supplied by the browser. TakeOver form overrides are deliberately transient and shown as such.

## Supported inspection

Banner ATF/BTF units, size maps, bidder overrides, advanced refresh schedules, explicit disabled sticky/floors/ID5 and GPT-only mode use the existing tested bridge. Configured SChain is passed to the reference builder. TakeOver remains a separate GPT-only module. GEO is not part of this work.

Top sticky, Close portal, contextual-test consent, per-slot lazy overlays and conditional mapping overlays fail explicitly rather than being silently discarded. Final CSS, output cleanup, module validation and other production release processing remain outside this source preview; the output is marked `completeRelease: false` and `requiresReleasePostprocessing: true`.

## Verification

`npm run test:builtin` requires no network/dependencies after checkout and tests exact bundle integrity, real compiler generation and syntax, TakeOver/default controls, invalid configurations, explicit preview/version pinning, stale review protection and a D1 fake that allows SELECT only and throws on R2 access. These are not real GAM delivery or Cloudflare cross-account deployment tests.

## Next integration gate

Complete supported settings/release overlays and final artifacts; pin runtime selection inside an isolated environment; validate actual Prebid modules; user staging delivery test; then cross-account Pages publication and full-release rollback (MBA-46). No automatic migration or main merge is authorized by the source-preview step.
