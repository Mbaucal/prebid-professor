# GAM measurement candidate — 3.12

Status: candidate code in draft PR #63. Not in the selectable TEST catalog,
not merged/deployed and not enabled on Tanjug. Existing engines and archives
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

1. Make the candidate explicitly selectable in private TEST and verify full package
   generation, pinned loader delivery and debugger together.
2. Both A and B must implement this measurement contract. A legacy control without
   labels cannot support a valid two-arm GAM revenue comparison. Begin with A/A of
   the new measured runtime; only then introduce a separately versioned cache arm.
3. Export both values and their full ledger mapping, checking for collisions.
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
