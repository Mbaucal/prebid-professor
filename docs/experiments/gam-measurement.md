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
   Local console diagnostics are not a durable collector. No such collector is
   shipped in this candidate. Revenue per assigned page cannot yet be calculated.

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

`worker/experiments/assignments.mjs` implements offline counting for a future
collector. It counts all valid `assigned` records once per random 128-bit page ID,
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
unknown. No collector or automatic network transmission is shipped in this step.
Do not call these counts site pageviews or compute experiment revenue per page
until collection completeness, GAM time zone and both arms' coverage are verified.
The existing console snapshot cannot supply this contract: it has no assignment
ID/time suitable for durable deduplication. A new versioned emitter is required.
