# GAM request reporting — MBA-103

Version **3.13.0**, `tessera-reporting-v1`, adds seven slot-level labels to the
existing 3.10 position runtime. Select it in **Config → Script setup → Change
version**, save, then generate a new package. Existing selections, published
scripts and saved ZIPs do not upgrade automatically. The TEST release was accepted for main promotion on 23 September 2026.
It retains 3.10 delivery behavior and does not include the separate 3.11 creative
bridge or the separate Tanjug cache engine.

| Key | Values | Meaning |
| --- | --- | --- |
| `refresh_count` | `0`, `1`, `2`, … | Requests dispatched for this slot after the first. A rejected visibility-gate attempt does not count. This is not an impression count. |
| `refresh_bucket` | `initial`, `r1_3`, `r4_plus` | First request, refreshes 1–3, refreshes 4 onward. Works with GAM-only too. |
| `refresh_interval` | `initial`, seconds such as `30`, `unscheduled` | Selected minimum interval for the actual refresh path. Not elapsed time; `unscheduled` means no scheduler interval was available. |
| `refresh_policy` | `initial`, `fresh_auction`, `gam_only`, `prebid_fallback` | First request, completed fresh auction, GAM-only refresh, or refresh without usable completed auction data. It does not identify the GAM winner. |
| `aq_bidder_count` | `0`, `1`, `2`, … | Distinct bidders with positive bids for this slot in the completed auction. Not the number contacted. |
| `aq_bid_count` | `0`, `1`, `2`, … | Unique positive numeric CPM responses matching both the current auction ID and ad-unit code. |
| `aq_timed_out` | `yes`, `no` | Prebid's callback timeout flag. In a batched auction it describes the whole auction, not one particular slot. |

GAM-only, GAM-only TakeOver and the GAM interstitial fallback send no `aq_*`
values. Missing or malformed results also omit them. A completed auction with
no positive bids sends count `0`; this differs from missing data. Duplicates,
zero/negative/nonfinite CPMs and cached responses from older auctions are not
counted. A consumed or late callback cannot label a later request.

The runtime writes labels immediately before the original GPT call, after the
existing visibility gate. It uses Tessera-owned slot objects only. Overlay DOM
IDs are mapped to their actual Prebid unit codes. Existing `hb_*`, `Variant`,
consent, eligibility, auction scheduling and refresh settings are preserved.
Reporting errors must not block delivery. No analytics endpoint is introduced.
Browser helper source is captured before Worker bundling, including the inherited
position helpers, so bundler-injected function-name helpers cannot leak into ads.js.

## GAM setup

Sending labels does not automatically make them reportable. In GAM's custom
targeting/key-values settings, create these keys and the values you intend to
report, then enable reporting and use the supported custom dimensions. Start
with `refresh_bucket` and `refresh_policy`; their small value sets are convenient
for comparing initial and refreshed impressions. Use numeric count/interval
keys only where that extra detail is needed. Reports begin collecting after
reporting is enabled; they do not backfill earlier traffic.

Keep these keys at slot level. In particular, **do not set `aq_*` as page-level
defaults**: removing a slot override cannot remove the page's targeting.
This change does not write to a GAM account or activate scripts on publisher sites.

Use GAM's impression and revenue metrics for reporting. Positive Prebid bids do
not prove a Prebid win. These labels alone do not supply pageviews or page RPM.
Do not sum rows for overlapping raw key-value pairs as independent traffic.
Inspect the selected package's `gam-reporting.json` for its exact contract.

## Verification

`tests/runtime/gam-reporting.test.mjs` checks ownership, callback fidelity,
current-auction attribution, deduplication, zero versus unknown, timeout, late
callbacks, errors, buckets and dispatch counts. The runtime-selection HTTP tests
check explicit selection, generation, saved/downloaded package identity and old
package preservation.

`scripts/verify-gam-reporting.py` runs readable and minified generated scripts
with local GPT/Prebid mocks. It compares request order/counts, auction inputs and
unrelated targeting against the unchanged 3.10 compiler. It covers initial,
dwell/Sticky refresh, configured and legacy lazy loading, TakeOver, GAM-only,
no-bid, timeout, wrapper fallback and interstitial fallback. External traffic is
blocked. This is deterministic runtime verification, not proof of live fill or
GAM report collection; those require the selected package and real GAM.

References: [Prebid requestBids callback](https://docs.prebid.org/dev-docs/publisher-api-reference/requestBids.html),
[GPT slot/page targeting](https://developers.google.com/publisher-tag/guides/key-value-targeting),
[GAM custom targeting reporting](https://support.google.com/admanager/answer/14528835?hl=en).
