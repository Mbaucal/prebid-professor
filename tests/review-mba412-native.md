# Independent account / SChain QA

The native fixture uses exact upstream Prebid 11.11.0, 11.34.0 and 11.45.0 commits and locked dependencies, unchanged Adform adapter code, the legacy SChain module and canonical contextual RTD modules. All browser network requests are intercepted. Account IDs, domains and category IDs are synthetic; no paid ad traffic is sent. A passing result proves native Prebid and adapter serialization, not SSP acceptance or revenue.

```sh
node tests/review-mba412-native-build.mjs
CHROMIUM_PATH=/usr/bin/chromium python tests/review-mba412-native-wire.py
node tests/review-mba412-composition.mjs
node tests/review-mba412-wrapper-prepare.mjs
CHROMIUM_PATH=/usr/bin/chromium python tests/review-mba412-wrapper-wire.py
```

The first two scripts accept `--version 11.11.0`, `11.34.0`, or `11.45.0`. `ACCOUNTS_PREBID_ROOT` selects a build cache. `ACCOUNTS_RUNTIME_ROOT` selects an isolated implementation checkout; by default the current repository is tested. The normal repository preparation must complete before the composition regression run.

The browser suite covers site-chain inheritance, a separate complete chain, explicit no-upstream chain, distinct Adform placement IDs, existing bidder/global contextual data, repeated configuration, concurrent and repeated auctions, current and legacy SChain paths/configs, late external bidder writes, native activity denial, request-local and bid-local conflicts, conflicting/private alias registries and replaced configuration guards. It checks both `bidRequested` and native Adform HTTP payloads. Browser startup failure is recorded as blocked and returns a failure exit code; a successful build alone never counts as a passed native test.

The composition script replays the accepted category-map and pending-CMP/TakeOver behavioral tests against the new 3.22.1 compiler, retaining the old compiler as the regression control. It does not alter frozen runtime sources or original fixtures.

The full wrapper suite generates both `ads.js` and `ads.min.js` from three saved Adform accounts, distinct SChains, exact-account contextual routes, GAM PPS, and bidder GEO rules. It executes both programs on all three pinned Prebid versions with the native Adform adapter, checking the actual serialized request bodies and consent-gated synthetic GAM dispatch. The agency account receives neither the site chain nor the other accounts' contextual route.

A second-adapter case uses three PubMatic accounts and one managed deal scoped to `pm_ag` / `m.box_1`. It checks the exact `params.deals` input and serialized `imp.pmp.deals`, so the deal cannot leak into the other account or the Billboard position.
