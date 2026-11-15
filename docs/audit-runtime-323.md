# Bid caching in 3.23.0

3.23.0 is 3.21.2 plus Prebid bid caching, for every site. It is built on
3.21.2, not on 3.22.0: it has no bidder rules, and 3.22.0 stays selectable. On TEST, a site with
bidder rules on cannot select 3.23.0, and Script setup and Generate say that no script has both. Until now bid caching
existed only in the Tanjug named scripts. 3.21.2, every older runtime, their
registry records and saved packages are unchanged. A site uses 3.23.0 only
after someone selects it in Script setup and saves; no site switches on its
own. The exact `codeSha256` and `sourceCommit` are in
`worker/runtime/runtime-releases.json`.

## Release channel

The record is `stable`. Every numbered feature release since 3.16.0 (3.16.x,
3.17.0, 3.18.0, 3.19.x, 3.20.x, 3.21.x, 3.22.0) was registered as `stable`; only the
3.16.0 revenue previews and releases before 3.16.0 used `preview`. As the
newest stable record, 3.23.0 becomes the current recommendation that Script
setup offers for a new setup, as 3.21.2 did before it. That is safe because a
3.23.0 package without saved bid cache settings is the 3.21.2 program with a
new version label (see "Generated program"). Saved pins keep generating their
own version.

## Settings and Generate

The admin saves `config.prebidBidCache`: `{enabled, maxBidAgeSeconds, positionOverrides}`,
with a maximum bid age from 1 to 300 seconds and an optional `true` or `false`
per position. `worker/runtime-323/snapshot.mjs` reads it at Generate (its own
reading, inside the 3.23.0 closure). Settings that are not valid stop Generate
with a message to save them again; Generate never guesses them.

The 3.23.0 input gets two fields:

- `bidCache` is `null` when Prebid is off, or when the site default is off and
  no position override is on. Otherwise it is
  `{defaultEnabled, maxAgeSeconds, positions}`, where `positions` holds every
  eligible position with its resolved choice: its override, else the site
  default.
- `bidCacheExclusions` lists saved overrides that name a position that is not
  eligible in this package. Each one is recorded as a warning in the package
  manifest and README and is never applied; Config → Demand → Prebid (Bid
  caching in the TEST workspace) lists it as Not applied. The setting stays saved.

Eligible positions come from the shared contract
`shared/bid-cache/eligibility.mjs` (`bidCacheEligibleCodes`): enabled ATF and
BTF banner units. The TakeOver position, its Interstitial fallback, Outstream
positions, Draft units, disabled units and removed units are never eligible.
If bid caching is on, or only a saved position override asks for it, but no
position in the package can use it, the package warns ("Bid caching is on in
Demand → Prebid, but..." or "A saved position override asks for bid caching,
but...") and is the 3.21.2 program.

Older generators refuse saved bid cache settings that would reuse bids (the
site default on, or a position override on) with "Bid caching needs script
version 3.23.0. Select 3.23.0 in Script setup and save; your bid cache settings
are kept. To keep this script version instead, turn bid caching off in Config
→ Demand → Prebid, remove unused overrides there, and set positions that are On
to Use site setting under Config → Ad units → Bid cache." Overrides that are
all Off need no capability: without bid caching every position already uses
its current auction only. `requireSupportedCacheGenerator` now receives the
catalog descriptor in `worker/test-workspace/runtime-catalog.mjs` and
`worker/site-runtime/releases.mjs`, so only a runtime with the `bid-cache`
capability lets them through. On this line the catalog applies its guards per
descriptor, and `buildArtifactCandidate` calls
`requireSupportedCacheGenerator(config, descriptor)` for every engine and
route before it dispatches, so no engine skips the check. The legacy generate
and preview bundle routes in `worker/app-builtin-runtime-preview.ts` keep
refusing such settings. Generate shows that message above Script setup, so the
reason and both ways out are visible where Generate is blocked. The TEST site
workspace shows the same reason with its own pages named instead of Config
("… open Bid caching, turn off Reuse valid, unused bids, remove unused
overrides there, and set positions that are On to Use site setting under Bid
cache by position."); see `docs/per-position-bid-cache.md`.

The package records the decision in `config.json` (`bidCache`,
`bidCacheExclusions`), describes it in a "Bid caching in 3.23.0" README section,
and `implementation.html` has one comment saying whether bid caching is on and
for how many positions.

## Generated program

`compileRuntime323` (`worker/runtime-323/compiler.mjs`) compiles the 3.21.2
program and then, only when at least one position is on, applies seven text
patches (`worker/runtime-323/bid-cache-compiler.mjs`). Each anchor must occur
exactly once or Generate fails:

1. Before the readiness layer is created: the settings literal, the policy
   function and its instance, and four readiness hooks.
2. After the 3.21.2 Prebid `setConfig`: install the policy.
3. Readiness consent change: drop every earlier bid.
4. Completed auction (current consent epoch, the auction Tessera started):
   record its bids.
5. and 6. The two places where readiness reads Prebid targeting (when the
   auction completes and again just before the GAM request): check cached
   bids and add accepted ones to the readiness allow-list.
7. After the targeting is set on the slot for its GAM request: mark every bid
   in it as used.

The result is parsed as ES2015. Without an active cache the output is the
3.21.2 program unchanged apart from the version and identity strings.
`tests/runtime/runtime323-package-qa.test.mjs` proves this for ads.js and
ads.min.js with Prebid on and off, TakeOver interval 0 and 30, GAM-only, and
contextual signals on.

## Browser policy

`worker/runtime-323/browser-bid-cache.mjs` (`createTesseraBidCache`, ES5) is
copied into ads.js by `scripts/prepare-runtime323.mjs` after the source hash
check.

**Install and feature detection.** After the 3.21.2 `setConfig` (send-all-bids,
`alwaysIncludeDeals`, `useBidCache:false`), the policy checks for `setConfig`,
`getConfig`, `onEvent` and `getAdserverTargetingForAdUnitCode`. It refuses to
replace a `bidCacheFilterFunction` that another script already set. It then
sets `useBidCache:true` and its `bidCacheFilterFunction`; Prebid's targeting
controls stay exactly as 3.21.2 sets them. The `getConfig` read-back that
follows is a sanity check only: Prebid's `setConfig` stores any setting it is
given, so it cannot show whether this Prebid honors the filter. The real
detection is the targeting check below (`filter-not-honored`). If an API is
missing or the read-back differs, the page uses fresh bids only: the policy
sets `useBidCache:false` and nothing else changes. The Prebid version is not
pinned; 11.34.0 (vendored) and an upstream 11.11.0 build with the same modules
are verified in Chromium.

**Which earlier bid may compete.** Prebid calls the filter only for bids of
earlier auctions; bids of a position's latest auction are always used. An
earlier bid is accepted only when all of these hold, checked in this order
(the rejection reason in brackets):

- the position is on (`position-off`); TakeOver, its Interstitial fallback,
  Outstream and every position not in the package settings are refused here;
- the bid came from an auction that Tessera completed for that position
  (`untracked`);
- Prebid's latest auction for the position is the one Tessera completed last,
  and the bid is not from it (`context`);
- consent: consent is ready, the bid's auction and the current auction are in
  the current readiness consent epoch, and both auctions sent bidders the same
  consent data (`consent`);
- a Banner bid with a CPM above 0 and a whole-number size (`format`); video and
  native bids are refused here;
- never sent to GAM before, never won, not rendered, and not marked
  `targetingSet` by Prebid (`used`);
- the same bidder has no fresh deal bid (non-empty `dealId`, any CPM) in the
  position's current auction (`deal`). Prebid keeps one bid per bidder and
  position before it builds `hb_adid_<bidder>` and `hb_deal_<bidder>`, so an
  earlier open-market bid with a higher CPM would otherwise push the bidder's
  fresh deal out of the deal keys; 3.23.0 keeps the deal, as 3.21.2 does;
- its size is one the position requests at the current screen size (`size`);
- younger than both the maximum bid age and the bidder TTL minus one second
  (`expired`).

**Consent.** For each auction the policy keeps a fingerprint of the consent
data in Prebid's `bidRequested` events: `gdprConsent` (`gdprApplies`,
`consentString`, `addtlConsent`), `uspConsent` and `gppConsent` (`gppString`,
`applicableSections`). If the bidder requests of one auction disagree, none of
its bids is reused. A bid is reused only when its auction's fingerprint equals
the current auction's. This compares exactly what Prebid sent to bidders for
each auction and needs no extra CMP calls, so it covers only the consent data
Prebid actually collects. With the configuration Tessera generates that is:

- TCF: always. The readiness consent epoch is TCF too; a readiness consent
  change (new TCF decision) drops every earlier bid, and no auction runs before
  consent is ready.
- US privacy: only when the site's Prebid.js includes `consentManagementUsp`.
  The vendored Tanjug 11.34.0 build does not, so `uspConsent` is never sent and
  a US privacy change does not stop reuse there.
- GPP: never. Tessera sets `consentManagement.gpp.enabled:false`, so
  `gppConsent` is never sent and a GPP change does not stop reuse.

The Tanjug named scripts (`worker/runtime-cache/consent-epoch.mjs`) reuse no
bids at all while a `__gpp` or `__uspapi` function is on the page; 3.23.0 does
not carry that rule over (see Known limits). Fingerprints stay inside the policy closure and are never shown.

**Readiness allow-list.** 3.21.2 readiness sends a position's Prebid targeting
only if every `hb_adid` and `hb_adid_<bidder>` in it is a bid of the current
auction that has not expired; otherwise the request carries no Prebid
targeting. 3.23.0 adds a cached bid that passes the policy to that allow-list
with its own expiry. The check just before the GAM request reads Prebid's
targeting again, so an earlier bid that expired in between is no longer
selected.

**Filter honored.** If Prebid's targeting holds a cached bid that the filter
refused or never saw, Prebid did not apply the filter: the page switches to
fresh bids only (`filter-not-honored`) and reads the targeting again. This,
not the install read-back, is how a Prebid without working bid cache support
is detected. If the
targeting still changes after three reads, the reason is `filter-unstable`;
an exception gives `cache-error`. In every case ads keep serving with fresh
bids.

**Used bids.** Right after Tessera sets the targeting on the slot for its GAM
request, every `hb_adid` and `hb_adid_<bidder>` in it is marked as sent and is
never reused. Prebid `bidWon` also marks a bid. Send-all-bids and deal keys
work as before: Prebid builds them from the bid pool with each bidder's best
bid, so a cached bid can appear as a bidder or deal key and is then used too,
but never in place of a fresh deal of the same bidder (`deal` above). A
bidder's lower bids that were never targeted stay unsent and can compete in a
later auction.

**Every refresh is a new auction.** The policy never skips or replaces an
auction; a cached bid only competes with the fresh bids of that position's new
auction. Prebid's `targetingControls` are not changed: in 11.34
`presetGPTTargeting` only clears `hb_` keys on the slot at `auctionInit` (it
never sets pool targeting), older versions such as 11.11.0 do not have it, and
Tessera's delivery clears every Prebid key on the slot before it sets the new
targeting anyway.

**Latest auction without `auctionInit`.** Prebid emits no `auctionInit` for an
auction with no bid requests, but that auction still becomes the position's
latest. The filter therefore applies every check to every bid Prebid asks
about, including bids of the auction Tessera started last; such a bid is
refused (`context`) and the position uses its fresh bids, as in 3.21.2.

**Memory, no storage.** The policy keeps at most 64 auctions with their bids,
128 auction consent fingerprints and 4096 filter decisions, in page memory
only. Nothing is written to cookies or storage.

**Diagnostics.** `window.__tesseraBidCache.snapshot()` (set only if the name is
free) returns the version, status (`active`, `fresh-only` or
`waiting-prebid`), the fallback reason, the Prebid version, the settings and
positions, whether consent is ready, how many auctions and bids are tracked,
counters (auctions, cached and fresh wins, requests without bids, and
rejections by reason: Prebid asks the filter again on every targeting read, so
each bid is counted once per reason, not once per call) and the last selection (position, cached or fresh winner, number
of cached bids, winner age). It holds no bid contents, ad IDs or consent
strings.

## Source and generation

- `worker/runtime-323/`: `snapshot.mjs`, `settings-guard.mjs`,
  `browser-bid-cache.mjs`, `bid-cache-compiler.mjs`, `compiler.mjs`,
  `readme.mjs`, `artifact-candidate.mjs`.
- `scripts/prepare-runtime323.mjs`: the source closure (the 3.21.2 closure plus
  `shared/bid-cache/eligibility.mjs`, the seven files above and the manifest
  itself), `codeSha256`, `assertRuntimeReleaseSource`, and the generated
  `.generated/runtime-323-browser-source.mjs` and `-manifest.mjs`.
  `scripts/prepare-builtin-runtime.mjs` runs it after 3.21.2.
- `worker/test-workspace/runtime-catalog.mjs` registers the 3.23.0 descriptor
  (manifest, candidate and input from `worker/runtime-323/`), selects its own
  revenue guard (`worker/runtime-323/settings-guard.mjs`) by id, and accepts it
  for TakeOver builds and saved pins.
- Admin allow-lists that name runtime versions (draft store deals plan, deal,
  Outstream and refresh settings, selected Outstream settings, the site
  package and deals-plan lists in `worker/site-runtime/releases.mjs`) include
  3.23.0.

## Tests

- `tests/runtime/runtime323-package-qa.test.mjs`: identity with 3.21.2 when the
  cache is off, the exact emitted policy, every anchor (missing and repeated),
  settings, warnings and exclusions (including the README and warning text
  when only a saved override asks for caching), the capability gate, stored
  drafts, the Outstream context and the TEST workspace flow.
- `tests/runtime/bid-cache323.test.mjs` with `bid-cache323-page.mjs` and
  `bid-cache323-site.mjs`: the whole generated ads.min.js of a synthetic,
  non-Tanjug site in `node:vm`, with a GPT recorder, a TCF CMP and a Prebid fake
  that follows Prebid 11.34 bid cache rules: one bid per bidder by CPM, then
  the faster response (`timeToRespond`); only CPM above 0, or deals with
  `alwaysIncludeDeals`, in the targeting; consent data collected only by the
  consent modules the build has. Covers: fresh-only identical to 3.21.2; a
  higher unsent earlier bid wins a refresh and a higher fresh bid wins later;
  maximum age 1 and 300 seconds and TTL expiry; override off with the default
  on, and default off with an override on; a TCF change drops every earlier
  bid, while GPP and US privacy changes stop reuse only when Prebid sends that
  data; no auction before consent; a sent bid (also as `hb_adid_<bidder>` or
  deal key) is never sent again; a fresh deal keeps `hb_deal_<bidder>` against
  the same bidder's higher earlier bid; a size change; the TakeOver,
  Interstitial and Outstream GAM requests equal 3.21.2's for the same bids and
  the filter refuses earlier bids of those positions; three kinds of missing
  Prebid support and a filter set by another script fall back without errors;
  `targetingControls` untouched; policy boundaries with a manual clock,
  including an auction without `auctionInit`, a zero-CPM deal and diagnostics
  that count each refused bid once per reason.
- `tests/runtime/bid-cache-eligibility.test.mjs`, `runtime-lineage.test.mjs`
  and `runtime-allow-list-parity.test.mjs`: only 3.23.0 has the capability;
  3.23.0 contains the 3.21.2 closure and capabilities plus `bid-cache`; admin
  allow-lists agree.
- Chromium (`scripts/prepare-bidcache323-browser.mjs`,
  `scripts/verify-bidcache323-browser.py`, in `site-editor-checks.yml`): three
  3.23.0 packages generated through the TEST workspace Generate path with one
  Prebid.js file as the site's build, run with that real Prebid, synthetic
  pubmatic and openx adapters, a TCF stub and the GPT mock, at 1280 and 390 px.
  Every other request is aborted, including the country lookup. Four auctions
  per position: site default on sends 10, the unsent earlier 4 against fresh 1,
  fresh 2, then fresh 12; saved off sends 10, 1, 2, 12 with no cache settings in
  Prebid; with Billboard overridden off, Billboard sends 10, 1, 2, 12 and P1
  10, 4, 2, 12; with an openx deal D-9 at 3 against openx's unsent earlier 5,
  the refresh sends the deal with `hb_deal_openx`, as 3.21.2 does. Each request
  has its own new auction, openx's fresh 0.5 is sent as `hb_adid_openx` every
  time, bidders receive the CMP string, `targetingControls` stay as 3.21.2 sets
  them, no ad ID is sent twice, rejection counts never exceed the number of
  bids, and the diagnostics contain no ad ID or consent string. The default
  run uses the vendored Prebid.js 11.34.0. The `bid-cache-prebid` job builds
  pinned upstream Prebid.js 11.11.0 with the vendored module list
  (`scripts/build-bidcache-prebid.mjs`) and runs the same check on it.
- `scripts/verify-bid-cache-settings-ui.py` (real React panels, compiled
  production Worker, local D1; TEST fixture
  `scripts/bid-cache-settings-browser-fixture.mjs`): the Demand → Prebid and
  per-position settings, and Generate on a site with 3.21.2 selected and bid
  caching saved, which shows the reason and both ways out at 1280 and 390 px
  and unblocks after either one.
- TEST workspace: `tests/runtime/bid-cache-test-workspace.test.mjs` (the TEST
  site saves bid caching through the TEST Worker, generates a 3.23.0 package
  with it, and is blocked with 3.21.2) and `scripts/verify-test-bid-cache-ui.py`
  (the Bid caching view, blocked Generate and a downloaded 3.23.0 package at
  1280 and 390 px).
- The sealed TEST Worker on local workerd
  (`scripts/verify-workerd-generation-parity.mjs`) generates every catalog
  runtime, 3.23.0 included, byte-identical to the direct compile. For each
  Prebid configuration (no TakeOver, TakeOver intervals 0 and 5) it also
  generates 3.23.0 with bid caching saved through the TEST site route (on, on
  with a position Off, off with a position On), as a bundle and as a saved
  package, byte-identical to the direct compile, with `config.json` bidCache
  equal to the saved settings and without the TakeOver position.
  `scripts/verify-generation-parity-browser.py` runs those programs too.

## Known limits

- A bid reused here is still a bid from an earlier auction. The bidder or the
  ad server can refuse it; check win rates and discrepancies after rollout.
- If a GAM request is held back after its targeting was set on the slot, the
  bids in it are already counted as sent and are not reused. This only loses
  reuse, never sends a bid twice.
- The `untracked` rejection count includes bids of auctions that Tessera did
  not complete (timed out or interrupted by a consent change); those bids are
  never reused.
- GPP and US privacy: 3.23.0 compares only the consent data Prebid sent (see
  Consent). With GPP off in Prebid, and US privacy only in builds with
  `consentManagementUsp`, a GPP or US privacy change on the page does not stop
  reuse. The Tanjug rule (no reuse while `__gpp` or `__uspapi` is present) is
  not carried over; whether to add it, or to read those APIs into the
  fingerprint, is an owner decision, and either needs a new runtime version
  once 3.23.0 is registered.
- A zero-CPM deal in Prebid's targeting makes 3.21.2 readiness drop all Prebid
  targeting for that request, because its allow-list accepts only bids with a
  CPM above 0. 3.23.0 inherits this unchanged from the frozen 3.21.2 readiness
  layer; the bid cache policy only keeps such a deal's bidder from reusing
  earlier bids.

## Not verified offline

The GPT used in tests is a recorder and the bidders are synthetic. Real GAM
line item matching of reused bids, rendering of a reused creative through
real GPT and Prebid Universal Creative, and real bidder acceptance need a
hosted check on TEST inventory before promotion.
