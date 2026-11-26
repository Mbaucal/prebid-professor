# Bid cache per ad position

Every site can save bid caching. The site default is under Config → Demand → Prebid ("Reuse valid, unused bids" and a maximum bid age of 1–300 seconds). Each eligible position has three choices under Config → Ad units → Bid cache:

- **Use site setting**: inherit the current default in Config → Demand → Prebid.
- **On**: let valid, unused bids from earlier auctions for this position compete with fresh bids.
- **Off**: use only bids from the current auction for this position.

Each refresh still starts a fresh auction. A higher fresh CPM can win on any refresh, including the third. Turning cache off does not prevent the GAM request when the fresh auction returns no bids.

Saving changes the configuration for the next package only. It does not modify saved packages, existing ZIPs or an active publisher deployment. Removing an override restores inheritance; changing the site default preserves explicit overrides. Disabling Prebid keeps the choices saved but inactive.

## Which positions can reuse bids

A position is eligible when its ad unit is enabled, in the ATF or BTF group, and Banner. The rule is `bidCacheEligibleCodes` in `shared/bid-cache/eligibility.mjs`, shared by the admin API and the runtime. These positions always use the current auction and are never dropped: Draft and disabled units, video and native units, the TakeOver ad position and its Interstitial fallback (or the legacy TakeOver code), and Outstream positions. Ad units shows a Bid cache button only for eligible positions, and re-reads the list after a unit, its Formats or its display changes.

The API (`PUT /api/publishers/:id/prebid-mode`) checks, in this order:

1. the shape: a boolean, an age of 1–300 seconds, and at most 500 overrides, each a valid GAM ad unit code with a boolean (422);
2. the form revision, so a stale form never overwrites another change (409);
3. that every new or changed override names one of the site's eligible positions (422, for example "Choose bid caching on or off for a supported ad position. Sticky is not an enabled ATF or BTF banner position on this site. Reload to see the current positions.").

An override saved earlier for a unit that later became ineligible (renamed, deleted, disabled, moved to Draft, made Outstream or TakeOver) is kept when it is sent back unchanged, so it never blocks an unrelated save. It is not applied: a package generated with 3.23.0 records it as a warning in its manifest and README (under "Saved settings not applied in this package"). Demand → Prebid lists it as "Not applied" with a **Remove unused overrides** action; removing an override is always allowed.

## Which scripts apply it

Built-in packages apply bid caching only when the site's saved script version has the `bid-cache` capability. 3.23.0 is the first such version, and a site uses it only after it is explicitly selected in Script setup. Demand → Prebid, the position dialog and Generate name the same versions, read from the release registry: those that apply bid caching together with the site's other saved options (bidder accounts, bidder rules), at most two of them, the smallest step (the version with the fewest capabilities, the newest patch on a tie) and the newest, leaving out versions with a runtime notice. Never "or later". With the releases up to 3.26.0 that is 3.25.1 (Preview) or 3.26.0 (Preview). The panels say which case applies:

- capable version selected: "Applies to new packages generated with the selected script." (the position dialog: "Applies to the next package generated with the selected script.");
- another version, or no built-in version, with saved settings that would reuse bids (the site default on, or a position override on): "Select script 3.25.1 (Preview) or 3.26.0 (Preview) in Script setup to apply bid caching. Your setting is saved." While the form has unsaved changes, the last sentence is left out;
- another version and nothing saved that would reuse bids: "Bid caching needs script 3.25.1 (Preview) or 3.26.0 (Preview)." The position dialog says "Applies to the next package generated with script 3.25.1 (Preview) or 3.26.0 (Preview). Select one of these versions in Script setup to use it." (with one version: "Select that version").

With an earlier version, Prebid on and saved settings that would reuse bids, Generate stops with 409 "Bid caching needs a compatible script version. Select 3.25.1 (Preview) or 3.26.0 (Preview) in Script setup and save; your bid cache settings are kept. Both versions combine bid caching with bidder accounts, bidder rules and the current native activity and floor checks. To keep this script version instead, turn bid caching off in Config → Demand → Prebid, remove unused overrides there, and set positions that are On to Use site setting under Config → Ad units → Bid cache." With one version it reads "This version combines". If no version without a runtime notice applied the saved options, Generate would name none: "Bid caching needs a compatible script version. No corrected script version is offered that applies bid caching. Versions with a runtime notice in Script setup still apply it. Your bid cache settings are kept.", or "No available script version applies …" when no registered version applies them at all, followed by the way to keep the selected version. Releases → Generate shows that message above Script setup. Saved settings that would reuse bids are never silently ignored. Overrides that are all Off need no capable version: without bid caching every position already uses only its current auction. With Prebid off, Generate continues GAM-only and the settings stay saved. The older legacy generator and preview bundle routes keep refusing saved cache settings that would reuse bids.

The browser behavior of the capable runtime (consent, size, age, TTL and submitted-bid rules) is documented with that runtime release.

## Named scripts (Tanjug)

Releases → Scripts and A/B tests is unchanged and remains available only for the reviewed Tanjug site and GAM path. Its named scripts use the same saved settings for their 19 reviewed positions with the existing Tanjug cache lifecycle and pinned Prebid 11.34.0. An override for any other position stops a new named script with 409 "Named scripts use the reviewed Tanjug inventory of 19 positions, which has no …", instead of dropping it. Existing named scripts and A/B ZIPs keep their exact bytes and settings. Named scripts do not use the runtime selected in Script setup or the newer built-in CMP/readiness implementation.

## Implementation and verification

`prebidBidCache = {enabled, maxBidAgeSeconds, positionOverrides?}` in the site configuration is unchanged. Overrides are stored in code-unit order. `GET /prebid-mode` returns `bidCachePositions` (the eligible codes), `bidCacheRuntimeVersion`, `selectedRuntime` (only when the runtime catalog still verifies the saved pin), `runtimeSupportsBidCache`, `bidCacheScriptVersions` (the versions named for bid caching with the site's other saved options), `bidCacheNoticedScriptApplies` (whether a version with a runtime notice applies them; it is never named), `namedScriptLibrary` and `namedScriptPositions` (the 19 reviewed named-script positions on Tanjug, else empty). The last two only choose the named-script sentence: the position dialog says new named scripts use the override only for those positions, and otherwise that an override there stops new named scripts until it is set to Use site setting. They never change what can be saved.

- `tests/runtime/prebid-mode-bid-cache.test.mjs`: a synthetic `example.invalid` site saves cache and its own overrides; Tanjug codes, ineligible positions and malformed overrides are refused without writes; stale revisions get 409; kept overrides never block unrelated saves; the payload for 3.21.2, a changed pin, any catalog descriptor with the capability and the registered 3.23.0; Tanjug gets the same cache fields and its named-script positions.
- `tests/runtime/script-library.test.mjs`: named scripts refuse an override outside the 19 positions.
- `scripts/verify-script-library-workerd.mjs`: the compiled Worker with local D1/R2 runs the same checks for the synthetic site next to the Tanjug library checks.
- `scripts/verify-bid-cache-settings-ui.py`: real React panels and the compiled Worker on the synthetic site at 1280 and 390 px: loading, saving, a 409 stale form and reload, a 422 position that stopped being eligible and reload, removing an unused override, Prebid off, and the copy once the saved selection is the registered 3.23.0. It also opens Releases → Generate on a site with 3.21.2 selected and bid caching saved: the 409 reason with both ways out is shown above Script setup at both widths, and turning caching off or selecting 3.23.0 unblocks Generate.
- `scripts/verify-script-library-ui.py`: on Tanjug, the position dialog promises named-script use only for the 19 reviewed positions and warns for any other position.

No external live auctions are used by these tests.

## 2026-10-02 review evidence and delivery boundary (named scripts)

PR107 merged main `68e738b` locally, preserving its navigation and async-save changes. `npm ci`, all three strict typechecks, production build, 64 Node tests, 54 compiled named-library checks and 8 compiled A/B checks passed. Native Prebid checks passed 102/102 at desktop/mobile with both site defaults; each refresh had a distinct auction, higher fresh bids won, and empty OFF requests contained no effective bidder targeting. Wrapper-owned `hb_ver`/`hb_version` metadata and empty native targeting values are not stale bids. The shared-auction ON/OFF policy test uses two slots; the native baseline retains its existing separate auction groups.

React checks passed 35/35 plus 22 independent UX checks at 1440/390, including loading, 503/409 recovery and keyboard focus during a held save. Fresh, cached and A/B legacy ZIPs matched main byte-for-byte. Exact-candidate readiness checks passed 34/34; a separate, uncommitted MBA188 test overlay passed 8/8 integration controls. These readiness checks verify shared-fixture compatibility, not newer CMP support in named scripts.

These are local candidate results; current CI must confirm the published tree. Hosted TEST does not contain the named-script library/API, so no hosted TEST or live publisher verification is claimed. Adding that capability is tracked separately in MBA19; this change adds no TEST infrastructure, deployment or production promotion.
