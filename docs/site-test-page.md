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

Marko accepted the hosted TEST page on 2026-09-23 and authorized main promotion.
The main release carries the reviewed TEST page, bootstrap fix and Sticky inspection.

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
