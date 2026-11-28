# ReportingObserver lifetime — MBA-435

The new opt-in Prebid build binds each observer to the actual rendered document
instead of the persistent cached renderer iframe. Display and native-format
source call sites pass `win.document`. A module-local WeakMap replaces the prior
registration for a repeated render into the same document without strongly
rooting detached documents.

Cleanup drains a pending intervention, disconnects once, removes its lifecycle
listener and clears document/window/callback references. Already queued callbacks
cannot emit stale events. A BFCache `pagehide.persisted=true` keeps reporting
active; a later nonpersisted pagehide releases it. Missing or failing reporting
APIs remain best-effort and do not block rendering. An explicitly inactive
document never falls back to the persistent renderer realm. Retained cleanup
handles also release inactive documents and API-absent windows before returning.

No ReportingObserver API is globally disabled. No auction, cache, TTL, CMP,
refresh or bidder-account policy is changed. This is a separate Prebid source
patch/build, not a rewrite of frozen ads.js 3.25.1/3.26.0 or previous vendor files.

## Source and module boundary

The bounded upstream audit on 28 November 2026 found the same missing ownership
argument and cleanup in the latest official release 11.53.0 and master commit
`8e7a0a4036301a421b755b45dbe58505865971f7`. This does not claim an exhaustive
search of renamed or unindexed upstream work.

The candidate intentionally patches reviewed 11.34.0 source commit
`195e0c6069928ed906bde550cb4e4183d1dc8474`, with unchanged upstream lock SHA256
`077338389169c8834d5bd1dedacd92094fb3b0e05a1c54fb4de7ffaa4b7d02d9`.
The patch verifies all three original file hashes before any write and rejects
unknown source bytes. Locked `npm ci` and upstream gulp produce separate control
and fixed bundles. Builds refuse to overwrite prior outputs.
The recipe records the UTC banner date and accepts `--build-date 2026-11-28`
to reproduce the reviewed file. Upstream's current-date stamp is normalized only
on the `Updated:` comment line; strict UTF-8/date/banner checks and a separately
recorded executable-body hash prevent that normalization from changing code.
The actual upstream-produced date is recorded too. Other source/lock/module/tool
inputs must also match for an exact byte reproduction.

The checked-in artifact is a Tanjug-derived **20-module display profile**, not a
universal per-site acceptance result. Other module sets use the builder's
explicit `--modules` input. The reviewed rebuild exercised that explicit route
with the checked-in 20-module config; the manifest records its input SHA256.
All enabled adapters, required features and consent
modules must survive the normal site-specific upload/preflight checks. A module
profile from an older Prebid version is refused, not silently upgraded.

The fixed build SHA256 is
`d58129a05e32ea325cbbb8bbf8531b4676b7df5ace5b32a3f8474beb8dff5889`.
Its source-control build has the same 20 modules and SHA256
`32889a517c5e0ab7d02859d1744cb8725bdc7fc6a76d603dad1f0d54752f57d8`.

The full combined runtime regression fixture has a separately declared **21st
synthetic contextual audit provider**, required by that existing verifier. Its
manifest says `isProductionCandidate:false`, records the provider hash and
points back to the production candidate. It is not shipped for publisher upload.

## Controlled result

Fresh frozen 3.25.1 packages were generated with both builds. All ads.min.js
bytes, runtime identity and selected module lists match across the pair.
Real Prebid banner rendering produced 40 renders/GAM dispatches per branch,
with matching CPM sequence, demand rounds, bounded 0/0/120 settings, identical
clock inputs and no escaped ad requests or browser errors. The actual browser
ReportingObserver remained available in every current realm in both branches.

| Post-GC observation | Control | Fixed |
| --- | ---: | ---: |
| Documents at final opportunity | 45 | 15 |
| Document growth after warmup | 30 | 2 |
| Final used heap bytes | 24,469,428 | 12,390,872 |
| Used heap growth after warmup | 14,281,592 | 3,007,120 |

The fixed document samples plateau within the fixture's four-document allowance.
The comparison is one synthetic controlled pair; whole-page heap includes
browser/fixture effects. It is not a publisher memory budget, production impact
measurement, exclusive retained-byte attribution or revenue claim.

An earlier candidate run failed its exact-clock gate: navigation
introduced a 76 ms startup offset and adaptive waits produced different command
journals. That receipt is retained and is not used for a causal heap claim.
The 435-only driver now navigates before installing/pausing its clock, loads both
exact scripts afterward, and replays one explicit clock vector. It requires the
same pre-auction epoch, every sample time and every `run_for` command, plus the
original native/render/duplicate/API checks and explicit expected-policy guards.
No frozen 430 harness or match predicate was weakened.

Local receipts:

- `.generated/observer435-native-pair-cleanup-final/summary.json`: accepted final
  pair; 237 common commands, 585,700 ms commanded advancement, all inputs sealed.
- `.generated/observer435-native-pair-final/summary.json`: rejected adaptive
  startup pair, retained with its original inputs.
- `.generated/observer435-functional-cleanup-final/report.json`: actual compiled
  display and native-format payloads, separate from quantitative memory measurement.
- `tests/runtime/observer435-lifecycle.test.mjs`: ownership, pending reports,
  repeated-document replacement, BFCache, API failures, stale callbacks and
  retained-disposer and unsupported-path WeakRef regressions, plus explicit
  module validation.
- `tests/runtime/observer435-artifact.test.mjs`: exact candidate bytes/provenance,
  unchanged old vendor, normal stored-byte checks, archived-selection and missing
  adapter refusal.

Additional local regressions passed:

- 26 source/artifact tests, including retained-disposer and unsupported-path
  WeakRef edges and banner-date normalization/body-identity checks.
- Four compiled renderer functional cases (control/fixed × display/native-format)
  preserve the intervention payload and reporting lifecycle.
- Ten late-render/TTL cases run with the exact 20-module production-profile
  artifact and frozen 3.25.1 packages: root integration receipt
  `.generated/observer435-late-cleanup-final/summary.json`.
- 112 readable/minified × desktop/390 combined programs pass with the separately
  declared 21-module audit fixture: aliases, per-account SChain, GEO/device,
  consent, RTD, current floors/deals/size, lazy/Sticky, cache history and expiry.
  The extra test provider makes this a source-level integration regression, not
  a claim that the 20-module production file includes the audit provider.
  Root integration fixture: `.generated/observer435-combined-native-cleanup-final`;
  declared source build: `.generated/observer435-native-integration-cleanup-final`.

The standalone native-format payload tests do not establish that the 20-module
display build enables native-format ads. Per-site module acceptance and live
publisher installation remain separate explicit steps.

## Reproduce

```sh
node scripts/build-prebid-observer435.mjs \
  --modules vendor/prebid/observer-lifecycle-11.34.0-tessera-1/prebid-config.json \
  --build-date 2026-11-28 --out .generated/observer435-builds
node --test tests/runtime/observer435-lifecycle.test.mjs tests/runtime/observer435-artifact.test.mjs
python tests/runtime/observer435-browser.py \
  --control .generated/observer435-builds/control \
  --fixed .generated/observer435-builds/fixed --out .generated/observer435-functional
```

For the native pair, prepare new frozen 3.25.1 packages with the existing
`prepare-retention430-fixtures.mjs` and the separately declared control/fixed
Prebid inputs, then use `scripts/profile-observer435.py --control ... --fixed ...
--harness-root ... --out ...`. Coordinate a quiet browser window before comparing
GC/heap observations. The existing late-render/TTL suite can use the fixed
production-profile packages without synthetic audit modules.

No production D1/R2, GAM entity, saved site configuration, old package or publisher
serving URL was changed in this work.
