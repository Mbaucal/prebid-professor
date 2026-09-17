# GAM measurement candidate — 3.12

Status: candidate code in draft PR #63, explicitly selectable in the private TEST
catalog. Not merged/deployed and not enabled on Tanjug. Existing engines and archives
retain their exact bytes. No GAM account settings or CMP settings were changed.

## Request contract

The new runtime reads the active, matching page-local experiment loader context
once, after duplicate entry guards. It sets only the runtime's own normal and
TakeOver slots, before display/refresh; it never sets page-level targeting.
An absent, stopped, conflicting or mismatched context gets no experiment label.
The codeless interstitial guard and unrelated publisher slots are excluded.

| GAM key | Value | Meaning |
| --- | --- | --- |
| `tessera_ab` | `d<first 32 hex characters of delivery SHA-256>_a` | Control |
| `tessera_ab` | `d<first 32 hex characters of delivery SHA-256>_b` | Treatment |

One dimension keeps delivery identity and arm together. Values are 35 characters,
contain no visitor identifiers and do not depend on country, cookies or URLs.
The full delivery hash includes site, experiment ID/revision, allocation, both
package pins and loader code. Changing those inputs changes the reporting pair.
The 128-bit prefix is a compact label, not an archive identity: retain the full
hash and both package pins in the experiment ledger and check for prefix collisions
across exported experiments before enabling reporting. Do not silently merge rows.

`__tesseraGamMeasurement[siteId].snapshot()` exposes the full identity, value,
applied-slot count and failures. The existing A/B console inspector includes a
bounded summary. Applying a GPT setting is not proof that GAM received it, recorded
an impression or reported revenue. Failure counts invalidate measurement until
investigated; ad delivery itself is not stopped by measurement failures.

## Before a measured pilot

1. Private TEST selection and package generation are integrated. Local Chromium
   verification exercises the actual pinned loader, identical compiled A/A package,
   both assignments, GPT request labels and debugger together with mock ad libraries.
   This does not replace the approved staging check with real GPT.
2. Both A and B must implement this measurement contract. A legacy control without
   labels cannot support a valid two-arm GAM revenue comparison. Begin with A/A of
   the new measured runtime; only then introduce a separately versioned cache arm.
3. Use Prepare GAM values and download the CSV/JSON mapping. Collision checks run
   against the prepared reporting registry; verify any values already in GAM too.
4. In the publisher's GAM network, verify `tessera_ab` is an unused reserved key,
   register the two values and enable the supported reporting setting. Do not target
   campaigns or pricing rules to A/B values: that would confound the experiment.
5. On approved staging, inspect actual GPT requests and confirm the values and
   intended metrics appear in GAM. Check compatibility with existing slot targeting
   and Prebid; do not allow custom configuration to overwrite this reserved key.
6. Collect an assignment denominator that includes no-request pages and failures.
   Local console diagnostics are not a durable collector. The opt-in private TEST
   collector below supplies a bounded received sample; full traffic coverage and
   revenue per assigned page are not verified.

GAM revenue is the outcome source; Prebid bid CPM and local render callbacks are
not realized revenue. Keep request count, filled/empty responses, latency and
viewability separate. A higher CPM alone is insufficient: compare revenue per
assigned page along with impressions, fill and latency on consistent cohorts.
Stop applies to new pages; existing pages retain their original assignment.
Do not pool successive delivery hashes without an explicit analysis rule.

## Verification

Unit checks cover both arms, missing/inactive/mismatched contexts, frozen assignment,
GPT errors and original generator bytes. CI Chromium runs the compiled candidate
with mock ad libraries: first requests, refresh, TakeOver, unrelated slots and
blocked duplicate insertion. All external requests are blocked; this proves local
integration only, not real GAM reporting or earnings.

## Official references checked 2026-09-17

- [GPT slot-level targeting and persistence](https://developers.google.com/publisher-tag/guides/key-value-targeting)
- [GAM key/value setup and Report on values](https://support.google.com/admanager/answer/9796369)
- [Valid key/value names](https://support.google.com/admanager/answer/10020177)

## Prepared exports

The private A/B page now offers **Prepare GAM values** for each saved experiment.
It verifies both original ZIPs and runtime source pins, calculates the active
preview's delivery identity and saves an append-only reporting plan separately
from experiment Start/Stop history. The registry checks compact-label collisions
across prepared plans with atomic R2 writes. Repeating preparation is idempotent;
changed delivery identity requires a new experiment. A prepared mapping also
blocks Start/active preview if later loader changes would change its GAM labels.

Supported pairs offer CSV values and JSON details. Unsupported legacy arms are
identified individually, and their CSV export is blocked. CSV is a reference
mapping, not a claim of automatic GAM account import. It includes both full package
pins and the full delivery hash. Preparing or downloading does not activate ads,
configure GAM or collect events. An experiment with a 0% arm can export its labels,
but is explicitly not ready for a two-arm comparison. Stop does not rewrite the
prepared active mapping; restarting the same experiment reuses its labels.

## Assignment analysis contract

`worker/experiments/assignments.mjs` implements counting for the private
collector and offline analysis. It counts all valid `assigned` records once per random 128-bit page ID,
including pages with load errors, conflicts or no outcome. Retries are deduplicated;
out-of-order outcomes are supported. Outcomes without an assignment are reported
as orphans, and contradictory outcomes are reported as ambiguous. Foreign delivery
hashes, changed identities, wrong package pins and unexpected fields are rejected.

Input is an array of records with exactly `assignmentId`, `deliverySha256`,
`packageSha256`, `variant`, `assignedAt` (original ISO UTC time) and `type`.
Types are `assigned`, `script-loaded`, `load-error`, `conflict`. The future emitter
must create a random ID once per document assignment, never reuse user/session IDs,
and preserve it and the original timestamp across retries. This is a data contract,
not an authentication mechanism: a future collector must verify delivery attribution,
validate intake, address abuse and enforce retention before accepting real traffic.

For offline fixtures or reviewed exports:

```sh
node scripts/analyze-experiment-assignments.mjs reporting-plan.json events.json
```

The output includes totals per arm, daily UTC counts, duplicate/orphan counts and
observed allocation. It contains no individual IDs and always reports coverage as
unknown. The standalone analyzer never transmits data; the opt-in TEST collector
is described below.
Do not call these counts site pageviews or compute experiment revenue per page
until collection completeness, GAM time zone and both arms' coverage are verified.
The existing console snapshot cannot supply this contract: it has no assignment
ID/time suitable for durable deduplication. The new collected loader emits directly
using a signed ticket, without exposing it through the console snapshot.

## Opt-in automatic collection for private TEST

A newly saved experiment can now select **Collect TEST assignments and load
outcomes**. This selects a separate `experiment-collected-preview-v1` loader;
old experiment records continue to use the original unchanged loader. The packaged
3.12 runtime is unchanged. The new loader keeps the existing runtime context
contract and includes the sender implementation in its delivery hash. Start
prepares its reporting mapping automatically. The private page's **Show received
assignments** action and JSON endpoint show the received sample per arm.

The authenticated TEST server signs a fresh random assignment ID, exact delivery,
package, arm and issue time with a domain-separated HMAC key. The ticket is returned
only in the private no-store loader body, never in a URL or console snapshot. It
expires after one hour. The browser acknowledges `assigned` before loading the
selected script and then reports `script-loaded`, `load-error` or `conflict`.
This is asynchronous and does not wait before loading ads. Duplicate loader tags
return before creating a sender. Each retry carries the same ticket and cumulative
outcomes, so a lost acknowledgement cannot create another assignment.

The endpoint requires TEST login, same-origin POST, strict JSON fields and a valid
ticket matching a stored reporting plan. It stores one record per signed assignment
under `test-experiments/assignments-v1/<delivery hash>.json` with atomic R2 writes.
No page URL, IP, cookie value, consent string or cross-page visitor ID is collected
in these records. The HTTP platform may have its own logging outside this module.
Reported outcomes are not independent proof that the runtime or an ad executed.

The sender has a two-second request timeout and at most six send attempts per
page. Its acknowledgement/failure state appears in A/B console inspect. Collection
failures do not prevent the runtime from loading. Stop disables collection for new
loads, while previously issued tickets may finish their original outcome until
expiry. The assignment timestamp is the server's allocation time, not browser
navigation time. Issued-but-unexecuted loaders and fully blocked collection are
not counted as received assignments; coverage remains unknown.

This is a bounded private TEST sample, not a production collector: at most 1,000
unique assignments per experiment. Existing assignments can still receive outcomes
at capacity; new ones receive HTTP 429. Records are retained in this bounded ledger;
there is no automatic deletion/expiry policy for stored records and no bucket
lifecycle configuration is changed. Production rollout requires a separate reviewed
retention/aggregation policy, scale/rate controls, consent assessment for real
traffic, and coverage validation before these counts can be a revenue denominator.
