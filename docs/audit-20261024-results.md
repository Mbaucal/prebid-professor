# Tessera audit verification — 24 October 2026

The 14 October independent audit was checked against MAIN `3be20bd888ffdcae486d6c7e876b6e4c49adbd61` before adopting changes. Its descriptions, proposed prototype and estimated impact are not treated as proof. Detailed original-code observations and limits are in [the independent review](audit-20261024-independent-review.md).

## Decision for each group

| Finding | Verified result | Change in this round |
| --- | --- | --- |
| T01 | Effective position refresh can be blocked by the global switch; UI can report otherwise. | Selected-version UI summary and warnings; 3.16.1 starts the scheduler for effective enabled positions. |
| T02 | Advanced rules shadow edits and deletion in Unit rules. | Atomic config/rule updates, preserved loading and refresh schedule settings, explicit conflict for incompatible edits. |
| T03 | Unsaved User ID defaults differ from generated sync settings. | Persist matching defaults for new setup; warn for old unsaved settings; preserve explicit sync-off. |
| T04 | Empty, invalid or timed-out TakeOver loses its Interstitial fallback after asynchronous consent gating. | 3.16.1 preserves one authorized fallback request through the gate. |
| T05 | Discovery retries duplicate; supported late wrappers can remain unrequested. | Bounded discovery with one timer/observer and request ownership; supports id/data-ad/data-slot/data-gpt. Not a general infinite-scroll feature. |
| T06 | Prefetched bid targeting can survive expiry, including secondary Send All Bids keys. | 3.16.1 validates current-auction native responses and expiry before dispatch; one bounded replacement auction. |
| T07 | Imported-template release lacks complete TCF module verification. | Check actual uploaded bytes, version/module metadata and checksum before legacy generation/activation; delivered together with T27. |
| T08 | Numeric-leading Prebid module names are rejected. | New mutable artifact checker accepts valid names such as 33across, 51Degrees and 1plusX; frozen checker remains intact. |
| T09 | Legacy placeholder CSS can use a desktop row below its breakpoint or retain height at an empty row. | Legacy CSS chooses an eligible row and emits zero-height resets. |
| T10 | Function-name preservation can insert private Worker helpers into serialized publisher functions. | Explicit TEST bundling configuration and standalone-script checks after actual Worker Generate/Save/download. |
| T11 | Saved minimum wall-clock gap is ignored, including after a delayed consent dispatch. | 3.16.1 checks actual send time; UI warns on older versions. |
| T12 | Sticky timer can ignore inherited intervals and schedules. | 3.16.1 uses the resolved schedule. |
| T13 | Hidden empty Sticky cannot pass the normal viewability guard to retry. | Only an empty, open Sticky gets the geometry exception; filled/closed controls stay protected. |
| T14 | Duplicate blur/visibility pause events erase saved remaining dwell. | 3.16.1 preserves the remaining interval and resumes once. |
| T15 | Empty default keywords end polling before late window.adsKeywords arrives. | Bounded late merge. Initial targeting and size-map inputs still belong before ads.js. |
| T16 | Disabled/offscreen guard retry is defective; saved exit hysteresis is intentional. | Correct retry behavior; preserve exit hysteresis instead of copying the audit prototype. |
| T17 | Additional Politika migration settings are a capability gap, not all claimed behavior is defective. | Deferred to explicit migration work. Existing desktop margin and deliberate per-slot thresholds retained. |
| T18 | Internal refresh count advances before dispatch that may be blocked. | Count successful owned automatic sends; do not confuse this with existing GAM reporting counters. |
| T19 | Invalid CSS property spelling matters to the enabled legacy close portal; built-in portal is disabled. | Verified legacy portal repair and new-version spelling cleanup; disabled legacy output unchanged. |
| T20 | Duplicate response-info code exists; no demonstrated delivery loss. | Remove duplicate only in new runtime. |
| T21 | Admin accepts values the compiler rejects. | Consistent timeout limits, numeric ID5 normalization, precise Unicode-separator errors before saving/generating. |
| T22 | Replacement-string metacharacters corrupt SChain values. | Warn/block incompatible old engines; 3.16.1 preserves exact literal values. |
| T23 | Deferred TakeOver can reach a disabled viewport; diagnostics show the wrong dimensions. | Safe viewport skip/fallback and actual map dimensions in diagnostics. |
| T24 | Version metadata is cleared and missing Prebid repeats its wait; changed-consent clean fallback is deliberate. | Preserve only software version keys, bound missing-Prebid wait. Do not add a fresh-auction consent policy change. |
| T25 | Newer syntax exists; a promise to support every old browser was not established. | New wrapper output parses as ES2015. This is not a guarantee for native Prebid syntax, browser APIs or polyfills. |
| T26 | Raw historical Sheets builder has coercion issues; the actual Sheets reader is absent. | No frozen source change. External Sheets correction requires its real input path. |
| T27 | Legacy postprocessing inserts literal slash-n and emits unparseable JavaScript. | Correct newlines, parse both outputs before promotion, reject invalid stored drafts without rewriting them; paired with T07. |

B10/B12 describe older consent behavior already superseded in 3.14+. E1 (waiting for a definite CMP decision) is intentional. CMP loading recovery, GEO fallback, a live Politika switch and new migration options are separate work.

## Evidence limits

- Original generated code and actual admin handlers were exercised before accepting findings. No revenue-loss percentages or live publisher incidence were inferred from synthetic tests.
- Native Chromium checks use local fixtures, pinned Prebid 11.34.0 where relevant, and intercepted GPT/CMP/demand. They are not evidence of live Google wire parameters, impressions or revenue.
- Independent review found and corrected a candidate defect for late data-attribute wrappers. Separate actual-send gap checks caught an interaction between consent delay and refresh timing.
- Existing runtime sources, release history entries, saved pins and packages remain immutable. Only explicit selection of 3.16.1 changes newly generated runtime behavior. Admin saves are explicit; no publisher settings are migrated in the background.
- Local, CI, TEST deployment and production promotion are distinct gates. Delivery status and exact commits are recorded in the PR and Linear checkpoint.
