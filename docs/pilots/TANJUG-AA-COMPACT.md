# Tanjug A/A 1.0.1 — compact public delivery

Marko confirmed that the A/A delivery and GAM labels work. The scripts are
identical, so this completes the delivery/label acceptance step, not a comparison
of cache policies or revenue superiority. No further manual A/A acceptance gate
is required before continuing development.

This is a new delivery version of the same full 19-position setup. The loader
and both owned runtime files are minified, without comments or public source
maps. `AdVariant.inspect()` remains available. The exact already-minified native
Prebid 11.34.0 file, including its license notices, is retained unchanged.
The only arm code change is the new release identity in the entry guard.
Allocation, Variant key, auctions, refresh, CMP and cache settings are unchanged.

The public ZIP contains only executable assets, styles, Pages headers and the
404 page. Human instructions and build/source manifests are separate private
companions, not uploaded files. Minification is not secrecy: browser-visible
configuration, public APIs and executable behavior remain inspectable.

## Reproducible package

Run the original Tanjug A/A build, then:

```sh
TZ=UTC node scripts/prepare-tanjug-compact.mjs
node --test tests/runtime/compact-aa.test.mjs tests/runtime/static-aa.test.mjs
TANJUG_PACKAGE_DIR=.generated/tanjug-compact/deploy python scripts/verify-tanjug-aa.py
```

The new ZIP is `.generated/tanjug-compact/tanjug-aa-1.0.1.zip`.
`scripts/static-aa-package.mjs` verifies the allowed public paths, exact inventory,
hashes, SRI and dependency copies. The deploy directory is extracted from that
same verified ZIP; a future Publish path must consume these saved bytes rather
than regenerate an independently different package. Rebuilding over existing
different files fails, as does materializing unexpected files from a ZIP.

The original A/A 1.0.0 ZIP must retain SHA-256
`bb66d583573099f46795e9e3cd9f700a5fad1581cafa7a62212b041882319993`.
No archived runtime source, original loader or previous package is changed.

## Delivery and remaining UI integration

Upload the complete new ZIP to the same Pages project, keeping `/ads.js` and
`/prebid.js` at the root and the versioned release folder intact. Existing HTML
and GAM values stay the same. Exact rollback uses the previous complete Pages
deployment. No deployment is performed by this build or its tests.

Main Tessera Publish/Download integration is still pending. The shared verified
asset set is preparation for that integration, not an active application route.
Main release storage, authenticated source selection, nested-asset deployment
and UI controls still need to be connected and tested before those buttons can
publish this format. New cache/adaptive-refresh behavior is a separate release.
