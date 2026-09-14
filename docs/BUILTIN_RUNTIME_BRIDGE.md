# Built-in runtime: compiler bridge (development)

Tracking: MBA-44 / MBA-45 / MBA-48. GEO (MBA-25) is explicitly deferred to Backlog, after the first pilot. This code adds no geo request or geo wait.

## Implemented slice

`worker/runtime/reference-bridge.mjs` maps a trusted, normalized Tessera configuration snapshot to the approved v3.9.1 builder, then passes its in-memory output through the existing advanced-refresh compiler. The caller cannot provide a template field. Builder/compiler functions must come from trusted static imports, not an HTTP payload.

The bridge preserves bidder global/device/slot/ad-unit overrides, size maps, User IDs, explicit TakeOver settings and selected advanced refresh schedules. It returns `requiresReleasePostprocessing: true`: this is not an alternative publishing route or a complete release. Existing release overlays, validation and artifact generation still need to run.

`runtime-compiler.ts` had a compatibility bug: it matched only `Math.min(8000, 1500)` in the wrapper consent timer. Reference output using another configured CMP value failed compilation. The new scoped helper recognizes exactly the named wrapper fallback inside the unique resolver; it refuses unknown/ambiguous structures and leaves unrelated timers unchanged. This is a compiler compatibility correction, not a new consent policy.

## Explicit differences from the reference

- Disabled bottom sticky no longer requires a phantom host ID in the compiled output.
- An absent ID5 module does not inherit reference partner 1355. A configured partner is explicit.
- Disabling floors clears floor values and disables the Prebid floors block.
- GPT-only / empty-bidder lazy slots bypass the reference prefetch path that would otherwise mark a slot prefetched without ever producing bids.
- Repeated loading of the built-in script does not initialize a second runtime on the same page. Upgrades require a fresh page load.
- TakeOver function bodies remain byte-identical to the reference for the tested configurations. No Prebid or refresh is introduced into TakeOver.
- Top sticky is explicitly rejected for this candidate because its reference timer functions are no-ops. Do not advertise that capability yet.

## Verification on 2026-09-11

| Layer | Result | Scope |
| --- | --- | --- |
| Dependency-free unit tests | 39 passed | Configuration mapping, rejects and narrowly scoped timer patch |
| Reference + existing compiler | 19 passed locally | 15 generated configurations plus 4 invalid-input cases; syntax, deterministic output, selected schedule math, unchanged TakeOver bodies |
| Real Chromium with local mocks | 20 passed locally | Desktop/mobile TakeOver, Close/Escape, timers, failure/fallback, resize, duplicate script load, GPT-only lazy BTF, configured IDs/floors and mobile bidder overrides |

Browser tests use mocked GPT/Prebid, local iframe creatives and blocked external requests. All 20 observed zero HTTP(S) requests. The visibility handler test simulates `document.hidden`; it is not a native background-tab lifecycle test. No real GAM/AdX delivery, publisher endpoint, email, Cloudflare data write or production deployment was exercised.

## Reproduction

```
node --test tests/runtime/reference-bridge.test.mjs tests/runtime/consent-timer.test.mjs
node --experimental-strip-types scripts/verify-reference-bridge.mjs ORIGINAL.txt REPORT_DIRECTORY
python scripts/verify-runtime-browser.py REPORT_DIRECTORY
```

The first command needs Node 22 and no dependencies. The last command currently expects Python Playwright and Chromium at `/usr/bin/chromium` (the verified environment). The reference verifier requires the actual approved user source, SHA-256 `40e1ac4e546f0786fff95e236d9fd5fab36fcdf57ff3ff22ce8198c4751aea57`. An absent/wrong source is an error, never a passing skip.

The new read-only CI runs the 39 unit tests, compiler import and browser-check script syntax. It does **not** run the 19 reference or 20 browser cases yet: the full approved source is still a project attachment, not a vendored repository fixture. Local generation and browser report JSON are retained with the project conversation.

## Still required before operator acceptance

1. Vendor the reviewed reference/build module into the repository and enable full reference/browser checks in CI.
2. Wire exact runtime pins, capability checks and static bundle integrity into the existing release snapshot and Generate route; preserve conditional mapping, integrations, runtime-control, size-map and Prebid-mode overlays.
3. Wire version choice and TakeOver settings into the existing UI using explicit site IDs; no DOM text inference or silent migration of current profiles.
4. Verify isolation of preview data, full release artifacts and actual staging delivery/rollback on the approved Cloudflare account.

No main merge, automatic site upgrade, endpoint publication or new production binding is part of this slice. The operator-facing product is not declared ready by these isolated checks.
