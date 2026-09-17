# Standard bid-cache runtime candidate — 3.13.0

The standalone policy is now integrated into a separate compiler and complete
candidate package under `worker/runtime-cache/`. Version **3.13.0** is recorded
with its own exact source closure; all five older releases remain unchanged.
It is **explicitly selectable in the private TEST catalog only**, not in the main
catalog, not deployed and not live on Tanjug. The default remains 3.10.0.
No site is migrated, no experiment is started, and no GAM/CMP account is changed.

Source commit: `b21431bcd9d6ddaee2cedb16cec080e2447d09de`.
Runtime source SHA-256:
`df61a0f1dfd4c12e64e5968078ffa0b7f0934afc89ef2389b21867acb4a88fb5`.

The new snapshot requires an explicit `runtimeControls.bidCache` value, e.g.
`{"mode":"auction-with-cache","maxAgeSeconds":30}`. It writes the normalized
policy into package `config.json`; `fresh-only` uses the same new lifecycle with
reuse disabled. No rule is inferred from another saved version. The chosen age
must be intentional: a 30-second cap cannot reuse offers older than 30 seconds
at a normal 30-second-or-longer refresh interval. It never extends bidder TTL.

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

## New compiler and lifecycle

The new compiler routes all five auction paths and eleven refresh call sites
through its private lifecycle (four auction paths when TakeOver is absent).
AST checks reject an unreviewed path instead of partially applying the policy.
Existing compiler modules are called without modification. Both ordinary and
configured lazy prefetch leave GPT bid targeting empty until the final refresh;
native automatic `presetGPTTargeting` is explicitly disabled in this version.
Native targeting then rechecks TTL, status, slot, sizes and context at use time.
PUC version and experiment/publisher keys are retained.

An observer uses the standard TCF `addEventListener` interface to advance a
page-local eligibility epoch when CMP state changes. It does not interpret a
country as consent, supply/override `gdprApplies`, open the CMP, or export TC data.
Prebid's existing TCF enforcement and the wrapper's existing privacy settings
remain authoritative. Missing/error/unknown TCF and detected unsupported GPP/USP
contexts disable **cached reuse**, not the native fresh-auction consent logic.
See the [TCF API specification](https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/IAB%20Tech%20Lab%20-%20CMP%20API%20v2.md#addeventlistener).

The auction epoch is captured on native auctionInit, after CMP gating rather
than merely when requestBids is queued. Resize, pagehide/pageshow and API
replacement invalidate earlier context. A changed context blocks a prepared
submission; it does not start an extra replacement auction. A later ordinary
eligible request may proceed. The TakeOver queue follows existing bidder/CMP/
floor configuration, including when there are no initial ATF positions.

Failsafe submission carries no bid targeting. Late callbacks and even late
auctionInit after a cancelled request cannot re-enter the policy. Auction IDs
are random page-local request identifiers, not stored user identifiers. Foreign
or unowned auctions cannot supply targeting. Existing refresh intervals, bidder
parameters, deal/floor rules and viewability gates are not rewritten.

Snapshot counters distinguish filter evaluations from actual primary targeting
selections. Repeated Prebid reads may evaluate a bid multiple times; these are
not unique cache hits. A selection records fresh/cache origin and bid age, not an
impression, render or realized revenue. Snapshots expose no ad IDs, creatives,
consent values or user identifiers. Errors expose only a fixed failure-stage
label, not arbitrary exception messages or bid data.

The existing A/B console inspector now adds `cacheDiagnostics`: mode, age limit,
eligibility readiness/epoch, bounded decision counters and last selection age.
`submissionAttempts` counts delegation to the existing GPT/viewability pipeline;
it is not proof that a request passed that gate. The independent GPT observer
continues to count actual slotRequested/render events. Consumed targeting is
conservatively excluded even if a downstream gate suppresses the request.

## Verification and remaining pilot gates

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
The first policy fixture run exposed a missing GPT `updateTargetingFromMap` mock; the
mock now implements native map updates including null-key removal. Existing
runtime history verification preserved all five recorded versions.

Compiler/lifecycle verification at `1762ea73b4b0edf63456b3226707d87a54b403c3`
passed all six CI workflows. [Workspace run](https://github.com/Mbaucal/prebid-professor/actions/runs/35281761218)
passed 12 new compiled Chromium checks, in addition to the 12 native-policy
checks: readable/minified first/TakeOver/lazy requests, cache-disabled control,
both lazy TTL-expiry paths, TCF change, resize, native dwell refresh with both
bidders called again, missing CMP (fresh only), and a delayed callback beyond the
lazy failsafe. Real Prebid runs against simulated GPT, CMP, adapter and currency
responses. All other URLs are blocked; no real ad or dependency request escapes.
Source commit `b21431b` only removes extra EOF blank lines before pinning.

Package tests verify complete file/manifest hashes, deterministic generation,
unchanged previous-generator files, saved policy, and rejection of modified
Prebid bytes even when their declared version and report checksum are updated.
The package browser suite consumes the exact emitted ads.js/ads.min.js files,
not a separately patched mock runtime.

Registration/package commit `3e40b5ebd93eb4dcf44027ec304f51bbf2db1c67`
passed all six CI workflows. [Exact-package workspace run](https://github.com/Mbaucal/prebid-professor/actions/runs/35282795656)
passed all 12 lifecycle browser checks against `.generated/cache-package-evidence`,
including the minified script, plus the 12 standalone native-policy checks.
The six-record provenance guard, 31 focused local tests, 22 previous-package/
experiment regressions and production build also passed. No live deployment or
external ad traffic was involved. This final evidence note does not change code.

## Private TEST selection and package integration

Both TEST editors now require explicit auction mode, whole-number maximum age
(1–300 seconds), and approval when selecting 3.13.0. The initial mode is blank;
the form suggests 60 seconds but saves nothing until confirmed. Changing either
rule clears approval. A limit of 30 seconds or less shows an explanation of why
offers past that age cannot compete at a 30-second-or-longer refresh. This does
not change any refresh interval or extend bidder TTL.

The private catalog validates the cache snapshot and exact reviewed Prebid hash
both at selection and generation. Wrong bytes with the same declared version do
not qualify. Main catalog and default selection are unchanged. Shared service/UI
hooks expose cache controls only through the private adapter; main writes reject
these extra fields. Older versions retain their behavior and may retain an unused
cache setting in the site draft, but old packages are not rewritten and their
compilers do not apply it.

Mode, age and runtime pin commit together under the original snapshot revision.
Stale tabs, concurrent edits, uncertain acknowledgements and stale generation
receipts use the existing atomic protections. Changing a cache rule creates a
different package; older ZIP bytes and active experiment selections are preserved.
The selected mode and age are included in package config.json.

HTTP tests exercise both editor endpoints, original ZIP preservation, distinct
packages, A/A source selection, invalid/missing options, wrong Prebid bytes,
old-version return, parallel/stale saves, lost acknowledgements and stale receipts.
Browser checks cover both forms, a cross-editor stale tab, candidate download,
mobile width and zero ad execution in administration screens. Loader tests take
an actual HTTP-generated, stored and re-read 3.13.0 package, deliver the same bytes
to A and B with dependency SRI, and run native Prebid against simulated bid/GPT/TCF
and currency responses. These are ephemeral local/CI checks, not hosted activation.

## Remaining pilot gates

1. Review an explicit Tanjug TEST configuration and age limit for its actual
   refresh schedule. Keep main defaults unchanged; do not silently activate live
   delivery. Any hosted setup/deployment remains separately authorized.
2. Verify real Google Funding Choices callbacks and actual GPT/Prebid integration
   on an explicitly authorized isolated pilot. Tests use the actual TCF listener
   code with simulated callbacks, not Google's live CMP or a compliance audit.
   Do not infer geo policy, consent correctness or compatibility with other
   Prebid builds from these fixtures. Validate sticky and long-session recovery,
   returning pages, CMP reopening and actual downstream viewability gates there.
3. Run instrumented A/A and the measured pilot gates from MBA-58 before making
   revenue claims. Cache-first remains a separate future experiment (MBA-60).

This is a separately versioned development candidate, not live publisher
activation, verified Google CMP compatibility, an operational revenue experiment
or evidence of higher earnings.
