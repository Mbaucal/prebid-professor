# Saved-package Test page (MBA-94)

Each site has a **Test page** tab. Choose a saved built-in package and open its
separate HTTPS diagnostic page. Releases also link directly to that exact test.
TEST exposes the same controls at `/site-workspace#test-page` for its saved copy.

The server verifies the archived package and embeds its original `ads.min.js`,
`min-height.css` and, when required, original `prebid.js`. It creates standard
and sticky DIVs from that archive's normalized configuration, with responsive
maps. TakeOver containers remain runtime-created and appear separately.
Changes currently in the editor never alter an existing test package.

**Start test** loads the saved scripts and official GPT. The table compares
actual registered slot IDs/GAM paths, requests and render events with expected
positions. Empty ads are acceptable; inactive breakpoints and lazy slots are
distinguished. Scroll through positions, open Google Publisher Console, or copy
the observed JSON report. Restart after changing desktop/mobile viewport.
Console URL options `?googfc`, `?google_console=1` and
`?google_force_console=1` are accepted; scripts still require Start.

**Sticky inspection** shows live computed position, offsets, visibility, size,
`ad-loaded` state and the actual GAM response. Real Sticky DIVs are direct body
children, outside diagnostic cards, with no placeholder paint overriding their
saved CSS. Empty/closed Sticky remains controlled by the archived runtime.
**Show Sticky CSS preview** displays a labelled, size-map-aware box using the
archive's original `sticky.css` in a separate shadow tree. It neither registers a
GPT slot nor changes the real container, request count, response or loaded class.
Preview closes on viewport change, when the real Sticky becomes visible, or
before a page console button opens Google's UI. The latter captures a timestamped
snapshot of real Sticky state for comparison with live state and JSON export.
**Inspect [slot] in GAM** opens the console focused on that real slot. Direct
DevTools/bookmark/URL console opening has no before-click snapshot; use the page
buttons without console URL parameters for a fresh comparison. Older archives
without `sticky.css` retain live inspection but cannot show this CSS preview.

Google documents its separate ad overlays and console slot inspection at
https://developers.google.com/publisher-tag/guides/publisher-console.
Tessera does not alter those overlays or force the actual ad visible.

Opening the page is an authenticated, read-only operation. It changes no site
settings, package bytes, channels, schema, production content or Google inventory.
The page has no admin API client. CSP gives its ad scripts an opaque origin
(no `allow-same-origin`), and COOP/noopener separates it from the admin tab.
Original scripts may make real ad requests after Start. Publisher CMP/storage,
real demand and the publisher layout require a publisher-site check. The report
uses selected text when clipboard access is unavailable in the isolated page.

Validation covers archived-byte integrity, authentication, wrong-site IDs,
corrupt files, invalid queries, unchanged storage/channels and HTML escaping.
CI uses the real compiler with synthetic GPT in Chromium for desktop/mobile,
slot/path matching, empty responses, lazy scrolling, console-button invocation,
report export and opaque-origin cookie/storage isolation. It sends no live ads
and does not validate Google's externally hosted console UI or live delivery.

Release to the existing TEST branch first. Main promotion requires owner acceptance.

Bootstrap correction: the browser client is now bundled as a complete IIFE at
build time and embedded as immutable text. Serializing a Worker function with
`toString()` dropped Wrangler's injected `__name` helper and stopped the page
before rows or click handlers existed. Bundling/minification regression tests
check unchanged browser bytes, and the Chromium fixture now obtains its HTML
from the real Wrangler bundle through authenticated local workerd/D1/R2.
Sticky browser coverage includes empty and filled responses, close behavior,
fixed placement while scrolling on desktop/mobile, preview isolation, responsive
preview size, and a before/live comparison after a synthetic external style
change. This checks observation, not the externally hosted Google console UI.

## 2026-09-23 follow-up review (MBA-104)

Confirmed findings and changes:

| Finding | Change |
| --- | --- |
| Release links inherited browser default / visited purple and underlines. Standalone UI used an unrelated teal palette. | Explicit normal/visited/hover/focus button styles, Tessera charcoal header, orange primary actions and neutral panels. Ad/Sticky CSS stays separate. |
| GPT script `load` cleared the only deadline even when its API never became ready. | One 20-second load/initialization deadline, visible failure status and restart guidance; timeout/error cleanup is idempotent. |
| Wrong GAM paths and duplicate slots only appeared in table rows beneath a generic waiting summary. | Summary distinguishes container failures and GPT registration mismatches; recorded error count remains visible. |
| Resizing mixed fresh responsive sizes with requests from an earlier viewport. | Capture Start viewport in the report, show a restart notice after resize, close preview and stop an ongoing scan. |
| Automatic scroll gave no progress, and jumping to a row could compete with a running scan. | Position/count progress, cancellation on jump/resize, and reduced-motion support. |
| Each GPT event and timer rebuilt unchanged status badges. | Batch event rendering per animation frame and preserve unchanged badge/live-status nodes. |
| Mobile results had no horizontal-scroll hint or keyboard focus target. | Focusable labelled results region, column scopes, mobile hint, visible focus rings and touch-size controls. |
| Reload packages discarded the current package choice. | Preserve selection when it still exists. |

Validation extends the compiled-Worker Chromium fixture at 1440 and 390 pixels:
empty/filled Sticky, original fixed placement and close control, preview isolation,
responsive maps, lazy requests, report, stop/resume, resize/restart, keyboard focus
and styling. Fault fixtures exercise blocked GPT, loaded-without-API GPT, wrong
GAM paths, duplicate DOM IDs and duplicate GPT slots. Synthetic GPT is used for
these deterministic checks; it does not validate live demand or Google's hosted
console UI. Hosted TEST visual/interaction and deployment evidence is recorded in
MBA-104. No production promotion is included in this follow-up.

## Consent status (MBA-184)

After **Start test**, the existing status panel reads the saved runtime's optional
readiness diagnostics. **Waiting for publisher consent** explains that this
isolated page does not load the publisher CMP and directs the operator to test
that same package on the publisher website. **Waiting for user decision** means
that the runtime is still waiting for a CMP choice. Registered slots and loaded
libraries do not change either waiting status into a successful consent test.

**CMP decision ready** means a decision is available, including a possible
rejection or an explicit decision that GDPR does not apply. It does not mean
consent was accepted, a bidder may participate, or an ad was delivered. Older
packages and unreadable diagnostics show **Consent diagnostics unavailable**,
without inferring a consent state from slot counts. Script errors keep the
existing error/restart flow; the report remains usable while waiting.

**Copy report** adds only `consent.status`, `phase`, `ready` and `epoch` from an
explicit allowlist. It does not copy raw CMP data, TC strings, vendor maps,
identity values or runtime event payloads. The observer does not call the CMP,
change a decision, create a fallback CMP, or alter the archived runtime/CSP.

The existing site-editor browser gate now covers real compiler-produced 3.10
and 3.14 GAM-only archives through the authenticated compiled Worker and local
D1/R2. Chromium at 1440 and 390 px checks 33 seconds of missing-CMP waiting with
zero dispatches, synthetic late user-decision/decision-ready transitions,
neutral old-package status, loading, script/GPT failures, keyboard restart and
report fallback, diagnostics failure/recovery and export sentinel scrubbing.
GPT and the late CMP event are test doubles; all network routes are intercepted.
These checks do not establish live Google consent enforcement or publisher UX.

Local verification on 2026-10-01: `npm ci`, all three strict typecheck scopes,
production build, TEST Worker dry-run, 9/9 targeted Node tests and 13/13 browser
cases passed. The Node suite ran with `TZ=UTC`, matching CI: the pre-existing
archived ZIP route uses a 1980-01-01 UTC timestamp that falls in 1979 under the
container's default western timezone. No ZIP/runtime change was made here.
This TEST integration preserves the MBA-104 / PR102 layout, styling, focus,
resize, scan and GPT initialization/error checks. Visual review covered desktop and 390 px waiting, ready and error states; the
existing table scrolls within its panel and the page has no horizontal overflow.
Evidence is produced by the existing CI gate under
`.generated/test-page-evidence/`; this is local/CI verification, not a hosted
publisher acceptance or deployment claim.

Review follow-up: a failed or timed-out Prebid prerequisite now makes consent
diagnostics unavailable instead of leaving “Checking consent status” active
when the saved ad script never started. The explanation identifies Prebid and
keeps the existing restart action. A GPT failure after the saved script loaded
does not discard a readable CMP status. The existing browser verifier now has a
separate compiler-generated Prebid fixture with synthetic bytes and error/timeout
plus restart cases at 1440/390. Targeted follow-up verification passed 10/10 Node
tests and 4/4 prerequisite browser cases on each layout variant, with zero live
requests. Run `python scripts/verify-site-test-page.py --consent-prerequisites-only`
for this focused check; evidence is `prerequisite-result.json` alongside its
screenshots. The default existing CI gate also includes these four cases.
