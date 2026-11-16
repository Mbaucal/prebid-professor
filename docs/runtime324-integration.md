# Combined runtime 3.24.0 (MBA-421)

3.24.0 is an explicitly selected Preview combining the audited 3.22.2 account,
SChain, bidder-rule and lazy-auction implementation with bid caching. Existing
runtime sources, release records, saved selections and package bytes are retained.
Without active caching its program is the 3.22.2 program with its new version pin.

The exact historical 3.23.0 source stays selectable and keeps its recorded stable
channel, but is excluded from the current recommendation and has a source-specific
notice. Its separate cache policy lacks the combined safeguards below. The current
recommendation remains 3.21.2 until an accepted new stable release is registered;
the exclusion permits future stable releases automatically. Preview records must
not later be overwritten to change their channel.

## Cache and request contract

Every refresh still starts a new auction. Reuse is limited to unused, unexpired
Banner bids for the same position, size and TCF decision. Fresh same-bidder deals
retain their native targeting priority. TakeOver and Outstream remain fresh-only.

The combined policy owns one native cache filter. It intersects the final request
after account/rule/responsive-format filtering with actual native `bidRequested`
membership. An activity-restricted bidder cannot be revived from the old pool
because another bidder still participates. Exact aliases and positions remain
separate identities. Cached IDs previously admitted to readiness are removed and
revalidated at every targeting read against current rules and account health.
Fresh bids retain the established request-time eligibility contract.

Cached bids also consult the current exact native request's bound `getFloor`,
using original CPM/currency and cached dimensions. This prevents saved time/day
floor rules from accepting an earlier bid below a raised floor. Native deal and
enforcement exemptions are retained. Unknown quotes, unsupported adjustments or
currency mismatches deny cache reuse while fresh demand continues. An empty quote
after Prebid deletes its private auction context is not proof of no floor. The
exception requires a still-owned, unchanged and provably all-zero wrapper model,
including its schema, native metadata, functions and absence of remote/per-unit
overrides. No second floor matching engine is introduced.

Foreign/replaced cache filters and missing native features keep fresh serving
available. Diagnostics do not expose raw consent strings, IDs or bid payloads.

## Verification and reproduction

Source commit: `5bb9e47c62ea1e8c95b15b42f818d5cdf15cf274`.
Source SHA-256: `6a897977487d60d69165fd574a468db5cf3a7269b87868ae3dd794b66ea0bc48`.
All 168 declared files match that commit. Merge ancestry must retain the source
commits of the included releases; do not squash them away.

The native matrix has 100 passing programs on Prebid 11.11.0 and 104 on 11.34.0,
with both outputs at 1440 and 390 px. It checks real cached alias IDs, SChain,
contextual RTD coexistence, in-page GPID, GEO/device/activity exclusions, consent,
TTL/age, size, deals, foreign hooks, lazy ownership, Sticky and fresh-only formats.
Six floor cases include raised/valid floors, deals, deleted native floor context
and explicit all-zero models. Build manifests record pinned upstream commits,
locks, canonical custom modules and resulting bytes.

```sh
node scripts/build-runtime324-prebid.mjs --version 11.11.0
node scripts/prepare-runtime324-browser-fixtures.mjs --prebid .generated/runtime324-prebid/11.11.0 --out .generated/runtime324-browser-1111
python scripts/verify-runtime324-browser.py .generated/runtime324-browser-1111
```

Repeat with 11.34.0. The existing site-editor workflow runs both native versions
and uploads their reports. Package and policy tests live in
`tests/runtime/runtime324*.test.mjs` and `tests/runtime/bid-cache324.test.mjs`.

## Acceptance boundary

Native tests use synthetic adapters, GPT and TCF, with external HTTP intercepted.
They do not prove SSP acceptance, revenue or live GPT privacy parameters. The
inherited native GPID limitation on logical TakeOver versus its physical slot is
recorded separately under MBA-107; this release preserves that behavior. Grouped
auction deadlines retain their inherited maximum-timeout behavior.

TEST integration, its exact provider build receipt, and authenticated hosted
Generate/Save/reopen/download verification are separate gates. Verify downloaded
bytes locally with ad networking intercepted. Existing accepted publisher tests
and unrelated Pages rollback tests need not be repeated. Production application
promotion and replacing a publisher's live script require their applicable
explicit authorization; neither follows from generating a package.
