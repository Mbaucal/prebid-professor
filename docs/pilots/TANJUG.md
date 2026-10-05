# Tanjug.rs — first TEST pilot

Marko selected tanjug.rs on 14 September 2026. MBA-22 / MBA-46 track this pilot.
This selection does not authorize replacing tanjug.rs or tanjug.pages.dev.

## Captured starting configuration

The public homepage references [ads.js](https://tanjug.pages.dev/ads.js) and
[prebid.js](https://tanjug.pages.dev/prebid.js). Both were downloaded as text;
no publisher JavaScript was executed and no ad requests were made.
`tanjug-observed.json` retains source checksums, extracted data and the minimal
Billboard/Sticky proposal. It is reference data, not an applied configuration.

- GAM: `/22852026051/Tanjug.rs-Display/`.
- Bidders: Criteo, OpenX, Teads and PubMatic, with their actual Tanjug parameters.
- 19 configured positions and six maps; bottom sticky ID `Sticky`.
- The existing public Prebid header declares 10.10.0. This is distinct from
  Marko's already accepted synthetic TEST package using 11.34.0.
- The InText mobile map has 14 sizes, including `fluid` and `1x1`. TEST now
  accepts up to 32 sizes per breakpoint and preserves their order and values.
  It retains strict dimensions/duplicate validation and the bounded request body.

The captured wrapper configures currency conversion, floors and supply chain;
its Prebid header does not declare `currency`, `priceFloors` or `schain`.
This is a static declaration mismatch, not a measured auction failure.
The observed full configuration also names five User IDs, but Lotame has no
clientId in that source. The provisional module list includes those observed
features; it is now used by the separately pinned TEST v1 below. Actual partner delivery remains a staging check.

## Approved Tanjug TEST v1 (14 September 2026)

Marko explicitly authorized reuse of the complete source configuration and
bidder IDs, adapting the remaining settings, with **TakeOver OFF**. No TakeOver
GAM unit or fallback is needed for this pilot.

`worker/pilots/tanjug-v1.json` freezes a separate `tanjug-test` snapshot and the
package changelog. It does not replace the saved `test-site` configuration.
`scripts/prepare-tanjug-pilot.mjs` generates the ten-file candidate using the
existing pinned Tessera runtime 3.9.1-tessera.preview.2. The engine did not change.
Builds run offline from pinned vendor bytes and fail on changed runtime/Prebid
pins; a future package upgrade must explicitly record a new version.

The original 11.34.0 Prebid build was returned by the official
`https://js-download.prebid.org/download` endpoint with the saved
`vendor/prebid/tanjug-11.34.0/prebid-config.json` request. All 15 required module
declarations and the original 299591 bytes are verified before packaging.
SHA-256: `384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b`.
No header edits or publisher JS execution are involved in preparing the package.

All 19 positions, six maps, bidder parameters, EUR floors, supply chain and
source User ID settings are preserved. Refresh retains 30-second start, 50%
growth, 120-second cap and 20-refresh limit; mobile visibility adapts from 40%
to the built-in runtime's 50%. The source Lotame entry remains without a made-up
client ID. New HTML has one responsive Billboard ID, not the homepage's two.

Authenticated TEST `/pilot/tanjug` offers the frozen ZIP, prebid-config.json,
version history and a **mock-banner preview, not a live auction test**. The
preview runs the exact new minified wrapper with local mock GPT/Prebid/CMP in
an opaque sandbox. Its CSP blocks external requests, storage and parent access;
the real Prebid file is not executed on the admin origin. These read-only routes
never touch D1/R2 or the accepted `builtin-draft-401614f1…` package.

The ZIP's `implementation.html` is a real integration example and can request
ads. Use it only on authorized isolated staging with the site's existing CMP
loaded first. The actual CMP, real bid/Google delivery and publisher layout
integration remain live-staging checks; generating the candidate does not claim
those checks passed. Tanjug production and tanjug.pages.dev remain unchanged.

New verification: full source-to-output data equality, exact original Prebid
and candidate hashes, authenticated immutable download, no saved-storage access,
query/method/host boundaries, opaque preview sandbox, desktop/mobile rendering,
lazy positions, four-bidder requests and sticky close with all network mocked.
Previously accepted user checks are not requested again.
