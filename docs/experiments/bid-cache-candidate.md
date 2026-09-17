# Standard bid-cache policy candidate

Development module only: `worker/runtime-cache/policy.mjs`. Not imported by an
existing compiler, catalog, loader or live publisher route. No new runtime release
is registered yet. Integration must produce a separately pinned new version;
the existing five releases and their source closures remain unchanged.

## Baseline and intended difference

The current reference/3.10–3.12 compiler chain emits `useBidCache: false` and
`enableSendAllBids: false`, with `targetingControls.alwaysIncludeDeals: true`.
Normal and TakeOver paths currently copy `getAdserverTargetingForAdUnitCode` output
into GPT manually. Refresh removes/recreates ad-unit definitions before requesting
bids. This describes repository-generated candidates, not a claim about a live
Tanjug page whose current configuration has not been inspected in this step.

The reviewed dependency is the exact repository file
`vendor/prebid/tanjug-11.34.0/prebid.js`, version 11.34.0, SHA-256:

`384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b`

The policy provides explicit `fresh-only` and `auction-with-cache` modes. The latter
means **new auction + valid cached bids**, not cache-first. Prebid still calls the
bidders and selects among eligible offers. This follows the [documented limited
cache behavior](https://docs.prebid.org/dev-docs/faq.html#does-prebidjs-cache-bids).
The fixture uses the same removeAdUnit/requestBids pattern to test whether that
pattern retains usable auction history in this exact build.

## Safety and ownership

* Use native `setTargetingForGPTAsync`, which records primary targeting status,
  rather than only copying keys. Do not mark an offer rendered before rendering.
* Track every submitted `hb_adid` and bidder-suffixed ad ID, including secondary
  deal offers, so cached offers already sent to GAM cannot be reused. Do not change
  deals or send-all settings to make the experiment work.
* Match GPT slots by exact owned object identity. Preserve publisher/GAM experiment
  keys; clear only `hb_` keys before a new submission. One targeting submission is
  allowed per ad-unit/auction. The policy does not refresh GPT or schedule auctions.
* A caller-supplied page-local, monotonically increasing eligibility epoch (never
  reused within the page) and live slot/size context are
  captured at auctionInit. Changed epoch, replaced slot or size set invalidates
  older offers. A change during the current auction blocks submission too. Missing
  context/history, unsupported formats and malformed lifetimes fail closed.
* The cached-bid filter only allows banner bids inside bidder TTL and the chosen
  maximum age (default 30 seconds, allowed 1–300). Native Prebid TTL-buffer/status
  checks still apply. `minBidCacheTTL`, bidder TTL and floor/consent settings are
  not modified. The [Prebid configuration reference](https://docs.prebid.org/dev-docs/publisher-api-reference/setConfig.html#bid-cache-filter-function)
  distinguishes cached-offer filtering from retention in memory.
* Data is page memory only: up to 128 tracked auctions and 4,096 submitted bid IDs.
  At submitted-ID capacity, cached reuse is blocked for the rest of the page;
  fresh auctions remain possible. No cookies, storage, server collection or
  cross-page reuse is introduced. Stop unregisters listeners and disables owned
  caching settings without overwriting a later owner's configuration.

Snapshot counters distinguish filter evaluations from actual primary targeting
selections. Repeated Prebid reads may evaluate a bid multiple times; these are
not unique cache hits. A selection records fresh/cache origin and bid age, not an
impression, render or realized revenue. Snapshots expose no ad IDs, creatives,
consent values or user identifiers. Errors expose only a fixed failure-stage
label, not arbitrary exception messages or bid data.

## Verification and remaining integration

Unit checks exercise context/size/TTL guards, bounded tracking, primary targeting,
duplicate submission, changed settings and teardown. CI loads the exact pinned
Prebid bundle in Chromium and registers two synthetic adapters. Every adapter
request is intercepted and fulfilled by the test; all other traffic is blocked.
GPT is a local mock. No real bid or ad-server request is made.

Native-core cases cover an unused older bid beating new bids, a better new bid
winning, fresh-only control, targeted/used offers, TTL and additional age limit,
changed eligibility/size, another ad unit, secondary deal targeting, empty bids,
duplicate calls and context changes before targeting.

Verified on 2026-09-17 at code commit
`eeb67dffa4aa96ccb1edffebe235b31a12d538ec`: six policy unit tests and all
12 native-core Chromium checks passed. All six existing CI workflows also passed.
The [workspace run](https://github.com/Mbaucal/prebid-professor/actions/runs/35279131010)
contains `cache-evidence/browser.json` in its synthetic evidence artifact.
The first fixture run exposed a missing GPT `updateTargetingFromMap` mock; the
mock now implements native map updates including null-key removal. Existing
runtime history verification preserved all five recorded versions.

Before registering/selecting a new script version:

1. Connect the policy to a new compiler and snapshot option only. Bind the actual
   Prebid file checksum, not merely the version string. Keep current catalogs and
   defaults unchanged until explicit private TEST integration.
2. Supply and verify epoch changes from the real consent/eligibility lifecycle.
   The present tests simulate that signal; they do not establish CMP integration.
3. Replace all manual targeting paths in the new version, including initial ATF,
   refresh, per-unit lazy and TakeOver, with exact owned-slot mapping. Validate
   delayed render, TTL at use time, resize and failsafe timing without duplicate
   auctions or displays. Review native automatic `presetGPTTargeting` as well:
   no ad request may use a preset before the policy's final eligibility check.
   Do not alter refresh timing, floors, partners or consent.
4. Verify compiled/minified packages and pinned provenance; preserve old packages
   byte-for-byte. Only then add an explicitly selectable private TEST candidate.
5. Run instrumented A/A and the measured pilot gates from MBA-58 before making
   revenue claims. Cache-first remains a separate future experiment (MBA-60).

This step proves isolated policy/native-core behavior, not a complete caching
runtime, live publisher compatibility, CMP correctness or higher earnings.
