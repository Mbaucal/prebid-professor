# MBA-109: explicit PubMatic outstream pilot

This implementation prepares an opt-in slice for the new `3.16.0-revenue.preview.1` runtime. It does not activate video on existing sites or modify an earlier saved package. It is not a completed live-player rollout.

Ad units expose Banner, Outstream and Banner + Outstream through a separate format dialog. Saved `media_type`, banner parameters and size maps remain unchanged. Settings are stored under `runtimeControls.outstream`, with snapshot-revision comparison and the existing configuration CAS/audit transaction. Banner canonicalizes to no override, so a later rename/delete cannot leave a blocking inactive entry. Active video requires the checked Prebid 11.34.0 PubMatic module, the operator's activation confirmation and partner-supplied `outstreamAU`. Aliases and other video partners are outside this pilot.

The player size must exist in every nonempty responsive size-map row. Empty rows continue disabling the position. This deliberately avoids inventing GAM video sizes or resizing a mismatched display slot. Sticky and TakeOver positions cannot opt in. Video-eligible positions do not automatically refresh, including after the player finishes; there is no guessed playback-completion event.

## Native evidence

`verify-outstream-native.py` uses the unchanged vendored Prebid 11.34.0 and a pinned official PUC 1.17.2 `video.js`. Both source hashes are asserted. All network routes are intercepted: PubMatic OpenRTB response, VAST cache and the vendor script response are synthetic. The actual PubMatic adapter creates its native renderer; the renderer calls a synthetic BlueBillywig `bootstrap` sink. PUC runs in a friendly iframe and reaches native `pbjs.renderAd` with the selected ID.

The 29-case matrix covers the helper separately and both mixed/video-only generated scripts, readable and minified:

- No renderer bootstrap before the selected creative; selected video bootstraps once and repeated PUC invocation cannot start it again.
- A direct/banner selection never invokes the video creative. Consent-epoch changes, expired bids and a consent change during delayed renderer download prevent bootstrap.
- Generated requests retain configured managed deal `0000199`, real video dimensions and the appropriate banner/video formats. Native net-revenue bids convert USD 2.50 to EUR 2.25.
- Each generated variant runs through 120 seconds with one native auction and one GPT dispatch for the video position.

Generated fixtures are supplied by the PM-owned revenue preparer. Their exact byte hashes are recorded per case in the native receipt, rather than treating copied fixture output as an independently registered release. GPT dispatch/creative selection and CMP decisions are simulated. This is not a real GAM auction, live publisher test, fill or revenue result. Native adapter/render queue behavior is real; actual vendor player pause/end/close, layout restoration and mobile playback behavior are **not** established by the synthetic sink. SafeFrame video is not covered or supported by this pilot. Existing CMP recovery/cache findings are not closed by this work.

## UI and local checks

The browser UI harness serves the actual built dashboard and intercepts its API. At 1440 and 390 pixels it checks loading focus, prerequisites, save/reopen, revision-conflict feedback, draft preservation, reload/recovery, return to Banner, focus restoration and horizontal overflow. Screenshots cover the form, its reachable footer and error state. Visual review corrected the checkbox to the existing compact style and made save feedback scroll into view with keyboard focus. No hosted session or credential is involved.

Local commands (Node 24.19; remote Node 22.23.3 CI is a separate gate):

```sh
node scripts/builtin-toolchain.mjs bootstrap
node --test tests/runtime/outstream-settings.test.mjs
npm run typecheck
npm run build
# Run the PM-owned preparer in the combined integration checkout first:
node scripts/prepare-revenue-browser-fixtures.mjs
CHROMIUM_PATH=/tmp/rei-chromium /tmp/tessera-browser/bin/python scripts/verify-outstream-native.py
CHROMIUM_PATH=/tmp/rei-chromium /tmp/tessera-browser/bin/python scripts/verify-outstream-ui.py
```

Native time is fixed at 2026-10-11T12:00:00Z. Browser artifacts are written under `.generated/outstream-evidence/`. The owner branch does not contain the shared preparer, catalog or HTTP route wiring; those are PM-owned combined changes. Existing frozen-source/63-output checks run as part of the locked build. No lockfile or frozen runtime source changed in this owner branch.

## Sources and rollout limits

- [PubMatic adapter documentation](https://docs.prebid.org/dev-docs/bidders/pubmatic.html): activated outstream renderer ID, VAST cache and video fields.
- [Exact Prebid 11.34.0 PubMatic adapter](https://github.com/prebid/Prebid.js/blob/11.34.0/modules/pubmaticBidAdapter.js): BlueBillywig renderer construction, native queued bootstrap and no standardized player lifecycle subscription in this integration.
- [Exact adapter manager](https://github.com/prebid/Prebid.js/blob/11.34.0/src/adapterManager.ts): per-bid mediaTypes override; non-pilot bidders remain banner-only.
- [Prebid Universal Creative](https://docs.prebid.org/overview/prebid-universal-creative.html): friendly-iframe video handoff and SafeFrame limitation. Pinned test bytes and license are under `tests/fixtures/prebid-universal-creative-1.17.2/`.

A live rollout still needs the actual partner renderer/placement activation, compatible GAM creative configuration at the accepted sizes, observed player lifecycle/layout behavior and separately designed revenue comparison. No partner is automatically enabled; no live ad request, GAM mutation or deployment was performed. The standalone selected-video result does not prove broader multibidder revenue competition or a completed A/B measurement workflow.

Owner local result: 7 contract tests, 29 native scenarios and both UI viewport scenarios passed; strict typecheck and App/Worker build passed. The initial locked bootstrap passed. Saved receipts are `docs/evidence/outstream-native-2026-10-11.json` and `docs/evidence/outstream-ui-2026-10-11.json`. The final dropdown instruction is a text-only follow-up; PM rebuilds and independently reviews the combined tree. Screenshots remain CI/local artifacts rather than repository binaries.
