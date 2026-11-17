# GAM request reporting in 3.25.0 (MBA-424)

3.25.0 adds request labels to the combined 3.24.0 runtime. Select the new
version explicitly and generate a new package. Existing runtime records,
saved packages and live publisher URLs keep their identities and bytes.
The implementation targets MAIN; this change has no separate TEST port.

## Keys and predefined values

| GAM key | Scope | Predefined values |
| --- | --- | --- |
| `aq_bid_origin` | Slot, per request | `fresh`, `cached`, `none` |
| `aq_first_request` | Page/document | `lt_500`, `500_999`, `1000_1499`, `1500_1999`, `2000_2999`, `3000_plus` |
| `aq_consent_wait` | Page/document | The six time buckets above, `na`, `timeout` |

Create these custom targeting keys and predefined values in GAM and enable
their supported reporting/custom dimensions before collecting pilot results.
Generating this package does not create or modify GAM settings.

`aq_bid_origin` describes the primary, unsuffixed `hb_adid` actually applied
to the slot immediately before its GPT request. `fresh` requires identity
from that slot's current completed auction. `cached` requires an earlier
auction's exact bid identity and acceptance by the cache engine for the
current request. Exact aliases remain separate. A cached secondary bidder
does not make a fresh primary bid cached, or vice versa. `none` means a
Prebid-active slot is confirmed to be sent without a primary bid. Inactive
Prebid, missing evidence and ambiguous identities omit the key. Old values
are cleared before the next request, including fresh → cached → none.
An empty slot value can inherit a page-level `hb_adid`. That publisher-owned
fallback omits the origin label; it is not reported as `none`. A known
slot-level primary retains GPT's normal override of the page value. No
existing `hb_*` targeting is cleared to produce these measurements.

`aq_first_request` measures navigation to the first owned GPT ad-request
dispatch. The bucket is applied before that call and kept for subsequent
refresh, batch and late lazy requests in the same document. A new document
starts a new measurement. It is not script-load, response, render or
viewability latency.

`aq_consent_wait` measures entry into the existing serving CMP gate until
the accepted decision that enables the first request. An already available
decision normally yields `lt_500`. SSP/Prebid processing after the decision
does not extend the CMP interval. The page keeps the first request's value.
GAM-only demand still measures the gate when it uses that gate; disabling
Prebid alone does not imply `na`.
If a resolved decision is revoked before the first request, measurement
starts at the new actual blocking gate entry. An update that remains ready
does not extend a resolved CMP interval with SSP time. Subsequent consent
changes do not rewrite the page buckets after the first successful dispatch.

As clarified by the owner, `timeout` means that waiting for the accepted CMP
decision reached the configured CMP reporting deadline. The first actual
dispatch uses the existing maximum positive `cmpTimeout` of its owned slots,
or the existing package fallback when no slot overrides it. Logical TakeOver
codes resolve their own rules even when the GPT container has a different ID.
Only time spent waiting for the decision is compared with this deadline;
later SSP/Prebid work cannot turn an immediate CMP decision into `timeout`.
Equality with the deadline counts as expiry. `na` requires an actually
ungated request.

The inherited strict MAIN gate continues to wait for a real decision. A
`timeout` label therefore reports a missed deadline, not permission to send
an ad before consent. No new serving timer, fallback or consent permission is
introduced. Nonexpired waits use their actual bucket, including
`3000_plus` when the configured deadline is longer than that interval.

The three keys are owned by this runtime version. `adsKeywords` and stale
page/slot values cannot override them. Unrelated targeting, existing
`Variant`, refresh labels, bids, auction ordering and consent decisions are
preserved. Missing reporting evidence omits the affected measurement.

## Pilot reports

Generate both new arms with 3.25.0 so the meaning and clock are identical.
The accepted legacy Tanjug saved-script/A/B profiles use their frozen
3.9.1-based templates; selecting a new standalone runtime does not retrofit
those packages. Generic named-script/A/B integration remains MBA-416.

For demand analysis use `Variant` × `refresh_bucket` × `aq_bid_origin`,
with impressions, revenue and fill calculated from a matching request
population. For startup analysis use `Variant` × `aq_first_request` ×
`aq_consent_wait`. Retain `hb_size`, existing bid-count and auction-timeout
labels as supporting dimensions. Do not sum overlapping raw Key-values rows.

A `cached` request can be filled by a direct campaign, AdX or another source.
It does not prove that GAM rendered or paid for the cached Prebid bid.
Likewise, `none` does not mean GAM no-fill. These labels provide neither a
complete assigned-pageview denominator nor page RPM or a causal uplift.
Use the same inventory, period, timezone, currency and revenue basis in both
arms, and keep requests separate from impressions and render events.

Google documentation:
https://support.google.com/admanager/answer/14528835?hl=en

## Verification boundary

The regression matrix checks the primary applied identity, alias isolation,
request-by-request cleanup, time boundaries, immediate/delayed decisions,
late lazy requests, multiple slots and new documents. Actual GPT serialization
is checked with pinned Google scripts and intercepted GAM requests, separately
from synthetic GPT/unit checks. Native Prebid demand remains synthetic and
external ad HTTP is intercepted. No live paid ad traffic is generated.

Receipts distinguish local execution, PR CI, application deployment and
publisher acceptance. A successful build alone does not establish live GAM
report availability, SSP acceptance, fill or revenue. The existing Tanjug
stability and A/A tests need not be repeated for this instrumentation.

### Recorded local candidate

Canonical source commit: `32385ebf2c35287b9fed92e12bfacb46f4416f30`.
Source SHA-256: `64d6cf24556be4ed895203effaa4989c8ef44b7a182a553bc3cd252ef99dc250`.
All 176 declared source files match that commit. Retain its ancestry when
merging; do not squash it away or rewrite the Preview record afterward.

- Independent source QA and 31 policy/compiled isolation checks pass.
- 203 targeted regressions, 64 serial preservation/preflight checks and all
  three strict TypeScript targets plus the production build pass.
- Compiled MAIN Worker/direct generation: 162 identical packages and 325
  generated Chromium programs, without outbound traffic or noncanonical
  function serialization.
- MAIN selection/save/reload/download passes all eight desktop/narrow cases;
  the new saved Preview and downloaded reporting contract are included.
- Native Prebid 11.11.0 and 11.34.0 each pass 140 comparison programs:
  70 new 3.25 programs and 70 baseline 3.24 programs per core, both arms,
  readable/minified and desktop/narrow. Each observes 360 genuine intercepted
  GPT requests. All six navigation buckets, six CMP buckets and configured
  `timeout` are observed. `na` is covered by the isolated policy check because
  current owned serving paths always use the CMP gate.
- Eight additional documents compare 96 actual synthetic-adapter HTTP RPCs
  and 32 genuine intercepted GAM requests. Bidder permutation is normalized
  only inside a contiguous SSP block; GAM barriers, counts, per-slot rounds
  and existing page/slot targeting remain strict comparisons.

The SSP-slow case uses the existing five-second auction-budget fixture so
response timing remains safely inside its auction deadline; its CMP-ready
assertion still requires `lt_500`. Four affected 11.11 programs were rerun
after that QA-only adjustment. Runtime bytes and their source hash did not
change. PR CI and deployment receipts are recorded in MBA-424 and its PR.
