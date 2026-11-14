# MBA-105 Deals candidate — 11 October 2026

This is an opt-in candidate, not a deployed feature or a live GAM/SSP acceptance. The main dashboard's existing Config → Demand → Bidders flow now includes Deals beside partner configuration. Saving contracts changes future site configuration through the existing optimistic snapshot transaction. It does not modify old ZIPs, select a new script automatically, create an SSP deal, or write to GAM.

The serving integration is the separately owned `tessera-revenue-preview-1` (`3.16.0-revenue.preview.1`) candidate. Its compiler layers the unchanged 3.14 readiness engine with native Send All Bids configuration reused from PR104's approach. This work does not promote 3.15, GPID or identity functionality. PM owns the combined registry, source manifest, routing and CI. This branch alone does not register a runtime.

## Supported contract

- Deal IDs remain strings, including leading zeroes. Names, site/position scope, UTC start and exclusive end, enabled state and commercial mode are saved.
- An active contract requires an enabled known bidder. Unverified aliases are explicitly rejected. Distinct native targeting keys are checked against the 20-character limit.
- Overlapping enabled contracts for the same bidder and position are rejected. Multiple bidders, disjoint positions and adjacent date windows are supported.
- Only PubMatic's documented `params.deals` array is added, at each auction after ordinary bidder overrides. Other supported partners are response-only: no generic `params.dealId` is invented. Manual PubMatic filters conflict with enabled managed contracts and must be moved explicitly; this is checked both on save and build. Disabled metadata does not delete unrelated manual filters.
- The browser helper receives a freshly constructed original ad unit on every auction. It does not retain or reuse a previously decorated object across an expiry boundary. The integration proof exercises a fresh auction after the contract expires.
- The GAM plan is read-only and site/network scoped, with exact bidder-specific deal key and creative ad-ID macro, dates, saved inventory and responsive sizes. Price competition and agreed priority are explicit choices. A key alone never sets priority. The plan does not assign guaranteed line-item types.

Native Prebid 11.34's checked-in targeting module groups responses by ad unit and bidder, selecting one response per bidder before emitting bidder-specific keys. `alwaysIncludeDeals` is not proof that every response survives this reduction. A lower deal bid against a higher open-market bid **from the same bidder** is not independently targetable under this candidate. The UI explains this limitation. We do not relabel an open-market response as a deal.

## Evidence

Commands used on Linux x64 / local Node 24.19.0:

```sh
node scripts/builtin-toolchain.mjs bootstrap
node scripts/isolated-toolchain.mjs prepare
node scripts/prepare-test-workspace.mjs
TZ=UTC node --experimental-strip-types --test tests/runtime/deals.test.mjs tests/runtime/deal-settings.test.mjs
npm run typecheck
npm run build
CHROMIUM_PATH=/tmp/rei-chromium /tmp/tessera-browser/bin/python scripts/verify-deals-ui.py
CHROMIUM_PATH=/tmp/rei-chromium /tmp/tessera-browser/bin/python scripts/verify-deals-native.py
```

- **10 Node/SQLite checks:** actual save/reopen, idempotence, stale revision, concurrent configuration mutation, manual-filter conflict, missing-site 404, request limits, literal IDs, date boundaries, scope conflicts, GAM plan inventory, native-key collisions, GAM-only omission and self-contained browser helper.
- **10 actual React checks at 1440/390:** synthetic API save/reload, leading-zero preservation, error/retry retaining the form, saved GAM size/adId plan and held old-site save failure after switching sites. Existing controls/styles are reused; screenshots inspected for clipping and horizontal overflow.
- **6 generated-runtime Chromium cases:** readable/minified Prebid candidate and GAM-only at 1440/390. Native locked Prebid 11.34 receives synthetic IX open market EUR1.20 and PubMatic deal EUR0.95. Both are present in captured GAM targeting with distinct real ad IDs. The simulated GAM choice selects the contracted bidder-specific ad ID; native `renderAd` actually renders that PubMatic creative in its native nested iframe, not the open-market creative. Completed no-bid refresh removes stale deal/adId keys. A later fresh auction beyond the contract end has no managed outgoing filter. Pending CMP change blocks subsequent GAM requests. GAM-only makes no Prebid bids or deal targeting.
- Root locked installation, three strict targets and production build pass; the existing 63 historical output verification remains unchanged. Full combined version registration and final CI are PM integration gates.

Generated runtime inputs for the native proof came from the PM integration's `dealsRuntimeFixture`, copied without modification:

| File | SHA-256 |
| --- | --- |
| prebid.js | 46edca6fa9ad809a6fb978fd27d8df9c019dca032d0d58bd03ad030e405e4294 |
| prebid.min.js | 19a308765a16948322a7830fb9ba85fac81366413a0e41899e9d4c69b7c1cf73 |
| gam.js | 4fbdca2e30cb0f777344af6c6443a31ac7bd752fa6076a27c1d9f4cb081a0456 |

Local reports/screenshots: `.generated/deals-ui-evidence/{results.json,deals-1440.png,deals-390.png,deals-form-1440.png,deals-form-390.png}` and `.generated/revenue-evidence/{deals-native-results.json,deals-selected-prebid.js-1440.png,deals-selected-prebid.js-390.png}`.

The browser harness intercepts every network request. Synthetic SSP responses and currency data are fulfilled locally; all unexpected destinations are blocked and fail the test. These are synthetic adapters attached to real Prebid core, not a proof of real PubMatic adapter wire serialization or server acceptance. The ad-server decision is simulated, not a live GAM line-item auction. Real partner activation, native SSP adapter wire checks, actual configured GAM line items, hosted TEST and publisher deployment remain distinct gates. No live ad traffic, external account writes, workflow dispatch or deployment was performed.

## Primary references inspected

- [Prebid deals](https://docs.prebid.org/adops/deals.html): bidder-specific deal keys, separate dates and ad-server priority.
- [Ad-server key values](https://docs.prebid.org/features/adServerKvps.html): Send All Bids and `alwaysIncludeDeals`; render IDs belong to real bids.
- [PubMatic bidder parameters](https://docs.prebid.org/dev-docs/bidders/pubmatic.html): per-slot `deals`, array of strings longer than three characters.
- Checked-in `vendor/prebid/tanjug-11.34.0/prebid.js`: native targeting reduction and `renderAd` behavior exercised locally. Current documentation is not assumed to change the locked 11.34 implementation.
