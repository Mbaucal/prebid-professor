# Independent verification of the 14 October generator audit

Baseline: `3be20bd888ffdcae486d6c7e876b6e4c49adbd61` (current MAIN at the start of this review).

The source audit was independently cross-checked rather than adopted as a patch specification. The checks below use actual frozen 3.16.0 compiler output and extracted original helpers, deterministic fake clocks and synthetic signals. They do not establish real publisher incidence, paid delivery, revenue loss, or actual historical hosted ZIP contents. No hosted data or production scripts were changed.

## Reproduction

Install the checked-in tools, prepare the frozen compiler inputs, then run:

```sh
node scripts/builtin-toolchain.mjs bootstrap
node scripts/prepare-builtin-runtime.mjs
TZ=UTC node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs scripts/audit-observe-20261024.mjs
```

This is an observational baseline diagnostic, not a regression gate which expects new code to remain defective. It intentionally reads the original unfrozen admin helper source from the baseline Git object, while frozen compiler modules remain immutable. Results are written to `.generated/audit-independent-review/baseline-mechanisms.json`.

The focused native baseline reproduction uses pinned Playwright1.55/Chromium1187 and the real generated3.16.0 program:

```sh
TZ=UTC node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs scripts/prepare-readiness-browser-fixtures.mjs --stable
TZ=UTC python scripts/audit-native-observe-20261024.py
```

Observed22/22 cases at1440px/390px, readable/minified: empty, wrong-size, request-timeout and define-null TakeOver cases all issue zero Interstitial guard requests; the filled controls correctly issue zero. Pending→ready cases issue zero requests before the decision, then one TakeOver request but no guard fallback. Empty renders report `fallback-requested` despite no guard request. There are no page errors or unexpected network requests. GPT/TCF are synthetic; no real Google or paid requests were sent. This confirms T04 at actual browser scheduling boundaries, not only an isolated helper.

## Findings matrix

“Mechanism reproduced” means independently executed original code or generated output. “Source confirmed” means the relevant causal code was inspected, with no claim that the complete reported browser/handler scenario was independently rerun. Reported timings and revenue estimates are not repeated as new measurements.

| ID | Independent classification | Evidence and boundary |
| --- | --- | --- |
| T01 | Confirmed; mechanism reproduced | Stable `previewInput` + `compileRuntime316` set `REFRESH_ENABLED=false` for no rules, exact-P1-only enablement, and disabled-default + enabled-P1. `setupAutoRefresh` exits on that flag; UI merges a refresh-enabled baseline separately. |
| T02 | Confirmed shadowing; mechanism reproduced, mutation cause source confirmed | A basic default changed to1200/off and absent basicP1 still resolve to advanced2500/on/P1. `updateUnitRule`/`deleteUnitRule` update basic rows and `syncConfigJson`, while the advanced map wins the frozen snapshot merge. Full D1-handler transaction not rerun here. |
| T03 | Confirmed inconsistency; mechanism reproduced | Missing saved `userSync` compiles to sync-disabled values; User ID GET defaults in `worker/user-id-config.ts` have `syncEnabled:true`, and publisher creation does not persist the same default. Actual sync/revenue effect was not measured. Preserve an explicitly saved false value. |
| T04 | Confirmed; mechanism and native browser reproduced | Actual readiness helper defers even an already-ready CMP callback through timeout0. The one-use TakeOver guard flag is reset in the caller's `finally`; the later gate blocks dispatch. Isolated control:0 sent/1 blocked. Real Chromium22/22 baseline cases confirm the missing fallback; actual Google codeless lifecycle remains separate. |
| T05 | Confirmed retry/lifecycle mechanism; partial reproduction | Two calls of the actual generated retry function schedule two independent750ms callbacks despite an existing waiting flag. Source creates a new observer after sticky CSS mutations, retries sticky-only DOM, and wires ordinary late slots only through configured lazy handling. Complete reported exponential timing/late-request matrix needs browser reproduction. |
| T06 | Confirmed; mechanism reproduced | Actual readiness helper caches targeting at auction completion and later dispatches it unchanged after live Prebid targeting becomes empty or drops a secondary bidder. Both winning `hb_adid` and suffixed Send All Bids keys survive. Native TTL expiration itself was simulated by the live-targeting omission, not measured against a real SSP. |
| T07 | Confirmed source omission; full handler reproduction pending independent fix review | Legacy `worker/releases.ts` required-module loop checks bidder/User ID modules only. The demand-mode wrapper delegates directly in Prebid mode. It does not add TCF enforcement requirements. Must fix withT27, before making the formerly broken legacy JS executable. |
| T08 | Confirmed; parser reproduced | Original checker rejects `33acrossBidAdapter`, `51DegreesRtdProvider`, and `1plusXRtdProvider`. Its regex requires an initial letter and applies to every declared module. This blocks generation rather than emitting incorrect JS. |
| T09 | Confirmed; helper reproduced | Original legacy CSS `activeBreakpoint` selects the desktop768px row at width0. CSS generation also skips zero-height rows, so a prior min-height persists. Built-in artifact styling is a separate, correct path. |
| T10 | Conditional toolchain defect; source basis confirmed | The3.10 compiler embeds `Function#toString`; original TEST configurations do not set `keep_names`. Actual esbuild/Wrangler-bundle proof belongs to the root-owned TEST configuration fix. No hosted affected package was independently inspected here. |
| T11 | Confirmed; generated function reproduced | Actual `tryRefresh` with last request60s ago, dwell30 and saved wall-clock gap120 still enqueues a refresh. It reads `minSeconds`, not `minGapSeconds`. Reporting semantics must be explicit in the fix. |
| T12 | Confirmed seed mismatch; generated input reproduced | Default rule60s without exactSticky rule yields `options.sticky.refreshSeconds=30` and `STICKY_REFRESH_SEC=30`. Source timer passes that fixed value into `tryRefresh`, overriding inherited/dynamic sequence rules. Full schedule timings not rerun here. |
| T13 | Confirmed guard mechanism; geometry impact conditional | The generated guard rejects an empty Sticky with0% geometry and minimum-view50. Source no-fill collapses/removes loaded state before retry. Actual Chromium geometry/no-fill lifecycle must verify the final fix; do not bypass the threshold for a filled or closed Sticky. |
| T14 | Confirmed; generated function reproduced | First `clearDwell(id,true)` preserves20000ms; the second identical pause sets it to null because deadline was already cleared. Source resumes only positive remaining dwell, so two native lifecycle events lose the timer. |
| T15 | Confirmed; generated function reproduced | `lateMergeTargeting` sees default empty `ADS_KEYWORDS={}` as a valid source and returns immediately: zero polling callbacks remain for later `window.adsKeywords`. Live publisher lateness incidence not measured. |
| T16 | Mixed: preserve intentional hysteresis; guard retry issue confirmed | Actual `tryRefresh` schedules a retry even for `refresh disabled`. Source retry callback does not check offscreen state; exit hysteresis itself follows saved `exitViewPct` and is not a bug. Do not copy the prototype's changed exit condition. |
| T17 | Migration capability gap; some original claims are not defects | Actual stable adapter ignores an unsupported `runtimeControls.targeting.pageTypeKeys=['category']` and emits default `pageType`. Separate mobile lazy margin/render-percent fields are absent. Existing desktop lazy field already exists; per-slot viewability threshold is deliberate; size-map sizing already matches the reference path. No evidence of lost real GAM line-item delivery was collected. |
| T18 | Confirmed early counting; mechanism reproduced | Generated `tryRefresh` increments its internal count before queued work reaches dispatch. Source fetch/gate can later reject the slot. GAM reporting has its own sent counter since3.13 and is not the same defect. Never add an aggressive retry on the auction lock. |
| T19 | Conditional legacy portal issue, not an active built-in default failure | Actual generated program has13 camelCase CSS `setProperty` calls; built-in output deliberately has `ALLOW_CLOSE_PORTAL=false`. Invalid spelling should be cleaned in a new version, but reported unclickable/duplicate portal UI needs a legacy-enabled browser test, including its real CSS. |
| T20 | Confirmed duplicate; generated output reproduced | Stable output contains2 `responseInfoAtRender` declarations. Source repeats response/layout reads; no demonstrated behavior or revenue regression. Cosmetic cleanup can join an otherwise needed version. |
| T21 | Confirmed validator/compiler mismatches; generation reproduced | Saved45000 group timeout is rejected by the frozen adapter; stringID5 partner rejected by bridge; U+2028 bidder parameter produces misleading missing-BIDDERS error. Admin accepts broader types/ranges in inspected validators. Full save/Generate UI error recovery belongs to admin fix verification. |
| T22 | Confirmed; actual stable compiler reproduced | Saved `sid:s$&t` becomes `s__SCHAIN_CONFIG_LINE__t`, and `name:X$$Y` becomes `X$Y`. This is String.replace replacement-string interpolation. Correct output must preserve the saved strings exactly; the report's rare-input frequency/revenue speculation is unmeasured. |
| T23 | Confirmed diagnostic mismatch; viewport-null crash source confirmed | Actual responsive overlay input seeds desktop300×250 while its1400px row is800×600. `tesseraOverlayDevice()` can return null and `initTakeOver` reads `.device` without a guard after deferred consent. Full resize/guard acceptance needs browser verification andT04. |
| T24 | Confirmed behaviors, mixed defect/improvement classification | Direct helper confirms2 consecutive missing-Prebid calls each wait3000ms. Source dispatch clears all `hb_*`, including version keys; source consent-change cancellation deliberately uses the clean fallback tested in existing readiness tests. A bounded fresh-auction retry is a behavior improvement, not permission to reuse a canceled bid. No real CMP incidence claim. |
| T25 | Confirmed parser level; compatibility impact conditional | Stable Prebid output fails ES2015 parsing; lazy optional chaining raises the level further. This proves syntax level, not a supported-browser contract breach. Vendored Prebid11.34 itself needs newer syntax; quantify/document browser support instead of claiming all old browsers must work. A new wrapper can keep GAM fallback parseable without changing historical outputs. |
| T26 | Conditional raw Sheets-builder defects; not a Tessera release defect | Actual raw builder with numeric refresh-cap0 emits20; decimal-comma floor emitsNaN. Sheets reader is absent, so actual cell normalization and live production impact are unverified. Tessera validates or normalizes these inputs separately; never modify its frozen vendor source for an external Apps Script fix. |
| T27 | Confirmed; both actual admin helpers reproduced | Baseline `ensureVarAfter` and `ensureWindowMetadata` produce literal slash-n outside a string; Acorn rejects both outputs. This is the legacy path, not built-in3.16 generation. Needs syntax checks before write/promotion, plusT07 in the same fix. |

## Additional classifications from the audit

- **B10**: malformed legacy TCF payload can throw when purpose-consents is absent.3.14+ readiness does not call the old decision function; this is not a new3.16 defect.
- **B12**: original legacy1200ms timeout is real, already superseded by explicit CMP readiness in3.14+. Existing versions stay immutable; help text can accurately describe the selected behavior.
- **E1**: missing/pending CMP means no permission and no ad dispatch in3.14+. This is intentional and covered by the frozen readiness tests. CMP recovery/GEO remains a separately planned feature; audit fixes must not turn a timeout into consent.

## Prototype cautions

- T05 prototype must skip configured-lazy ATF slots to avoid a second initial request.
- T06 must validate every suffixed bidder adId, not only the winning `hb_adid`.
- T13 must exempt only empty, non-closed Sticky geometry. A blanket Sticky exemption silently ignores saved minimum viewability.
- T16 must preserve saved exit hysteresis.
- T18 must count at actual dispatch without adding fast retries on auction locks.
- T17 includes migration feature additions and intentional differences; do not blindly label every row a fix.

## Status of this review

No product changes or deployment were made in this independent-review worktree. This baseline classification is not approval of an implementation. Final approval requires the exact combined commit, relevant regression results and the browser evidence for changed runtime/UI behavior.

## Combined-candidate review: deferred consent and explicit request gap

The first combined working3.16.1 candidate passed the isolated refresh/CMP cases but still violated an explicit wall-clock request gap when consent delayed a queued refresh. A real Chromium run used GAM-only demand, `minSeconds:30`, `minGapSeconds:100`, and a pending decision from5s through105s. Billboard request offsets were `[2,105000,136201,236201,336201]`ms: the request after the delayed first refresh arrived only31.201s later. No requests occurred during pending consent, and there were no page errors or unexpected network requests.

This is a T11/T18 interaction, rather than a new consent bypass: the attempt timestamp stayed behind the actual dispatch timestamp. The runtime and counter owners received the reproduction before the new runtime was frozen. The acceptance check must use actual dispatch time for an explicit minimum gap and preserve existing attempted-time cadence when no separate minimum gap is set.

Reproduction: `scripts/audit-native-cmp-gap-20261024.py --script <generated-gap100.js>`. Add `--expect-fixed` to require every actual request gap to be at least100000ms, while also checking that refresh counts equal actual refresh sends and that pending consent sends nothing. The input must be generated from a local fixture with Billboard refresh enabled, fixed30s and minimum gap100s. The report records the exact generated script SHA256.
