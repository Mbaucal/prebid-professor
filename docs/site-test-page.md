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
production build, TEST Worker dry-run, 9/9 targeted Node tests and 8/8 browser
cases passed. The Node suite ran with `TZ=UTC`, matching CI: the pre-existing
archived ZIP route uses a 1980-01-01 UTC timestamp that falls in 1979 under the
container's default western timezone. No ZIP/runtime change was made here.
Visual review covered desktop and 390 px waiting, ready and error states; the
existing table scrolls within its panel and the page has no horizontal overflow.
Evidence is produced by the existing CI gate under
`.generated/test-page-evidence/`; this is local/CI verification, not a hosted
publisher acceptance or deployment claim.
