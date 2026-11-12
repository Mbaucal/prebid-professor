# Bidder eligibility rules — 3.22.0

The generic Demand → Bidder rules editor controls which configured Prebid partners may participate for a position, country and viewport layout. It is available for any site and defaults off. It does not activate bidders, publish packages or change consent handling.

## Policy

- Bidder and alias codes match exactly. Position codes keep their original spelling, including punctuation and Unicode.
- An enabled rule for selected positions replaces that bidder's All positions rule for those positions. Other positions use the All positions rule, if present. Without a matching rule, ordinary bidder configuration applies.
- Country and viewport layout must both match. Country modes are All, Only these countries and All except these countries. Country codes use ISO alpha-2 plus XK.
- For a country-specific policy, choose Allow or Skip when detection is pending or unavailable. Rules do not wait for GEO, block the page or start an additional auction. The next natural auction reads the latest available country.
- Layout means viewport width: Mobile below 768px, Tablet 768–1023px, Desktop from 1024px. It is not a physical device classification. An unknown width matches only a rule permitting all three layouts.
- Overlapping enabled position rules and multiple enabled All positions rules for one bidder are rejected with an actionable message. Removed bidders and positions remain visible for correction.

The editor's decision preview uses the same evaluator as the generated runtime. It previews current edits without sending an ad request; consent, slot eligibility and auction checks still apply.

## Applying a change

Save the rules, explicitly select and save script 3.22.0 or later, then Generate a new package. Existing selected versions, stored packages and live URLs are not changed by saving these settings. Earlier engines reject enabled bidder rules instead of silently ignoring them. GAM-only packages retain the settings with filtering inactive.

The runtime filters the final explicit Prebid ad-unit array after responsive Outstream resolves its units. A position with no eligible bidders still follows the existing consent-gated GAM path. SChain, bidder parameters, deals, contextual signals and original configured arrays are preserved.

The wrapper retains inherited cache enablement. When another integration enables native bid caching, an additive `bidCacheFilterFunction` composes its existing filter and excludes denied cached bidders before native targeting selection. That extra policy applies only while the latest native auction for the position belongs to this wrapper, using its captured country/layout. Foreign auctions clear ownership. The inherited current-auction and expiry checks remain authoritative. If the public cache hook is unavailable, diagnostics say so; safe fallback may omit a fresh bid when native targeting selects stale data.

## Inspecting a generated page

```js
console.log(window.__AD_BIDDER_RULES?.snapshot());
console.table([window.__AD_BIDDER_RULES?.simulate({
  bidder: 'openx', code: 'P1', country: 'RS', width: 1280
})]);
```

These commands are read-only and do not request ads. The snapshot retains at most 200 decisions, counts dropped records, and identifies the auction, bidder, position, country, width and reason. Cache context retention is bounded to 128 recent auctions. The evidence proves local eligibility/filtering, not SSP receipt, fill or revenue.

## Verification

Shared/API, actual HTTP boundaries, version selection, generated package and runtime tests live in `tests/runtime/bidder-rules-*.test.mjs`. The suite covers stale writes, exact identifiers, unknown GEO, layout boundaries, responsive formats, all-denied GAM fallback, consent, cache composition and concurrent auctions.

`scripts/verify-bidder-rules-ui.py` exercises native React plus the authenticated Worker on desktop and narrow screens, including loading, save failure, stale edits, reload and orphaned references. `tests/bidder-rules-native/` executes readable and minified generated scripts with pinned native Prebid 11.11.0 and 11.34.0, synthetic adapters/GPT/CMP and intercepted HTTP. The existing contextual lab separately checks unchanged SSP adapter serialization. Browser checks must pass in CI; source preparation alone is not browser evidence.
