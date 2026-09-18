# Tanjug: first local check on the live page

## Current evidence

On 18 September the live homepage was opened with its existing integration.
The [DOM observation](../evidence/tanjug-live-dom-20260918.json) records one tag
for each public `https://tanjug.pages.dev/ads.js` and `prebid.js`, Google GPT,
and Tanjug's own Funding Choices entry
`https://fundingchoicesmessages.google.com/i/22852026051?ers=3`.
The existing page contained the Funding Choices/TCF locator frames and iframe
elements in Billboard and P1. This is not proof of consent, filled impressions,
exact script response bytes or successful candidate behavior. No candidate ran.
The ordinary baseline visit could request real ads through the old integration.

Existing console warnings included missing P4/P5/P6 elements on the homepage
and deprecated GPT targeting getters. These are baseline observations, not new
candidate regressions. They have not been fixed by changing an old script.
Raw tracking request URLs, consent strings, cookies and bid IDs were not saved.

## Prepared local replacement kits

`node --experimental-strip-types scripts/prepare-tanjug-local-check.mjs`
creates two ZIPs in `.generated/tanjug-local-check/`, one per arm. Select only
one kit. Its `overrides` directory contains exactly:

| Observed request | Replacement from the exact candidate |
| --- | --- |
| `https://tanjug.pages.dev/ads.js` | `ads.min.js` |
| `https://tanjug.pages.dev/prebid.js` | `prebid.js` |

Each ZIP has a hash mapping and setup/end-test instructions. No wrapper is
appended in the console. No server routing, publisher HTML, CMP, GPT, security
header or stored runtime is changed. A uses fresh-only; B uses new auctions plus
eligible cached bids. Both include only Billboard and Sticky. The remaining
positions are absent for this operator's local test; these are not full-site
replacement packages. The older staging wording inside the frozen candidate
archive remains byte-identical; the user's 18 September live-test decision and
this local test scope supersede that environment wording.

Use a dedicated local Chrome profile, inspect the current initial tags and
loading order, and enable both exact response replacements before reloading.
Check both override indicators and file identities in Network before interpreting
the runtime result. If either URL changes or only one file is replaced, stop and
recheck. Do not disable CSP/CORS or integrity enforcement to force a result.

[Chrome's Local Overrides documentation](https://developer.chrome.com/docs/devtools/overrides)
explains folder selection and disabling. Overrides persist across page loads;
they are not automatically single-use. **To end the test, disable Local Overrides
and reload.** Confirm the page receives the current CDN responses again. Closing
a tab alone is not cleanup. Cache is disabled during overrides, so this is a
functional check, not a latency/revenue benchmark. Changing A/B arms also requires
a reload; do not start both wrappers on an already initialized page.

The available cloud browser supports reading the DOM and console, but exposes no
request-response replacement API. Its URL policy also rejected a view-source
navigation. No alternative browser-control surface was used. Actual activation
of these local overrides requires a supported developer browser; this step does
not claim a completed live test of the new scripts.

## Capture and rollback scope

`node scripts/capture-tanjug-live-baseline.mjs` reads only the two public script
URLs, twice each, with bounded sizes/time, no credentials, no redirects and no
JavaScript execution. Matching bytes are saved with hashes and a report. A
separate CI job retains `tanjug-live-baseline`; failed reads remain failures and
do not produce a successful capture. Two matching observations detect changes
during collection but are not an atomic snapshot or a guarantee of future bytes.

For this local-only test, disabling overrides returns to the **current** public
delivery. Captured bytes provide evidence and a future deployment rollback
source; they do not pin the CDN or automatically restore a previous deployment.
Public cohort selection, complete inventory support and an actual hosted
rollback are separate subsequent work. The existing experiment Stop still
chooses the new control package, not the old live script.
