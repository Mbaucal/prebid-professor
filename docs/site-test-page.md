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
