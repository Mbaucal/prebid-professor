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
features; it is not a final build selection. Confirm partner settings before use.

## Remaining pilot work

The homepage HTML contains no identifiable CMP loader; the wrapper expects
`__tcfapi`. This does not prove a CMP is absent after scripts run. Ask Marko which
CMP Tanjug uses before preparing the actual consent/ad-display test. Do not copy
the old wrapper's permissive fallback as an approved consent policy.

The captured wrapper has no TakeOver configuration. The existing Tessera TEST
TakeOver settings must be retained; a Tanjug GAM path/unit and fallback remain
to be established before a real TakeOver request.

The homepage contains two `id="Billboard"` placeholders for separate desktop and
mobile wrappers. A new test page should have one responsive ID, avoiding that
ambiguity without editing the publisher homepage.

Keep the accepted `builtin-draft-401614f1…` package and all saved TEST settings.
Do not replace them with this JSON automatically. Prepare a separately reviewed
configuration and private staging handoff. `tanjug.pages.dev` is the observed
existing asset origin, not an approved staging destination or verified account.
No destination token, account ID, Pages preview branch or test URL was supplied.

New checks only: the 14-size map survives transactional TEST save/read unchanged;
32 entries remain valid and 33 are rejected without a write. The complete
19-position/six-map extracted draft passes the pure editor normalizer. Previous
user acceptance checks and uploaded ZIP checks were not repeated.
