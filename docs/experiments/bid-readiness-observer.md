# Passive bid readiness — Tanjug observed A/A 1.0.0

Marko approved developing diagnostics while the existing Tanjug A/A test runs.
This adds a separate `tanjug-aa-observed-1.0.0` delivery release, with the full
19-position source and byte-identical A/B arms. It does not activate cache reuse,
change refresh intervals, deploy to a site, or rewrite the shipped A/A 1.0.0 ZIP.
The build rejects any change to that ZIP's recorded SHA-256.

`AdVariant.inspect()` includes the new table; `AdBidReadiness.inspect()` and
`snapshot()` expose it separately. The existing Debug command now recognizes
both static A/A delivery and the readiness report, with allowlisted output.

The observer subscribes before owned slots start auctions. It retains bounded
page-local auction context and bid IDs internally, and reads live bid objects
through `getBidResponseByAdId`. Snapshot output contains no bid IDs, creatives,
consent strings, user IDs or ad markup. Nothing is sent to a server or storage.

Each position reports received offers, candidates passing local screening,
remaining lifetime and rejection reasons, submitted offers, bidWon, Prebid render
success/failure and separate GAM request/filled/empty events. A candidate is NOT
a guaranteed next ad or confirmation of native targeting eligibility. The report
explicitly carries `nativeSelectionVerified:false` and `guaranteedAds:null`.
With `cacheEnabled:false`, candidate counts do not enable cached reuse.

Screening requires an observed completed auction, the same live slot, sizes and
consent epoch, an accepted banner response, compatible currency/floor, render
data, and unused status. The original bidder TTL (including its per-bid or global
Prebid buffer) and an additional 60-second maximum age both apply. An explicit
two-second delivery budget excludes offers too close to expiry; it is a diagnostic
assumption, not an optimized refresh setting or an extension of SSP TTL.

Targeting is conservatively treated as consumption, including primary and
bidder-suffixed deal IDs. This covers native setTargeting events, preset targeting,
and the base wrapper's manual copying of keys into GPT. slotRequested also reads
the actual owned slot targeting. Removing keys later cannot resurrect a tracked
submitted offer. Render failures cannot resurrect it either. Repeated snapshots
do not inflate submitted counts.

The observer never invokes `requestBids`, `setConfig`, targeting selection,
refresh, creative rendering, or bid status mutation. In the reviewed native
11.34.0 core, `getHighestCpmBids` goes through a path that writes
`latestTargetedAuctionId`; the observer deliberately does not call it. Native
selection and final GAM competition remain a later delivery step. Custom cache
filters/targeting exclusions are not executed by the observer and are reported
as unverified. The existing TCF observer supplies context continuity, not a new
consent decision. Changes of context invalidate previous candidates.

No historical bid reconstruction is attempted after late installation. Limits
are 128 auction contexts and 2,048 bid records. At bid capacity, diagnostics stop
certifying candidates and report the limit; ad delivery continues normally.
An observer initialization failure is reported without blocking the ad runtime.

Build with TZ=UTC after the original full A/A build:

```sh
node scripts/prepare-tanjug-readiness.mjs
node --test tests/runtime/bid-readiness.test.mjs tests/runtime/readiness-package.test.mjs tests/runtime/experiment-inspect.test.mjs tests/runtime/static-aa.test.mjs
```

The `Tanjug passive bid readiness` workflow verifies the emitted full package in
Chromium with the exact native Prebid dependency, synthetic adapters, GPT and CMP.
Every external request is intercepted. It checks losing bids versus targeted
winners and compares native bid/config/request state before and after inspecting.
The same delivery cases cover desktop/mobile, lazy requests, duplicates,
dependency errors and SRI errors. Artifact evidence includes the generated ZIP
and browser report; it does not establish live revenue or actual SSP acceptance.

Future work in MBA-63: shared native-compatible ready-bid selection/reservation,
reliable direct/unknown campaign classification, explicit standard/ready-bid
interval controls, and a separate adaptive-refresh experiment. None of those is
silently activated by this diagnostic release. Finish the running A/A report
review before choosing a new package for the next live observation.

Sources:
- https://docs.prebid.org/dev-docs/faq.html#does-prebidjs-cache-bids
- https://docs.prebid.org/dev-docs/publisher-api-reference/getEvents.html
- https://docs.prebid.org/dev-docs/publisher-api-reference/setConfig.html#set-ttl-buffer
