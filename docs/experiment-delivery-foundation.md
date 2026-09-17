# Experimental delivery foundation (MBA-57)

Status: isolated implementation, **not connected to any hosted /ads.js**.
Pilot chosen by Marko: Tanjug. CMP: Google Funding Choices / Privacy & messaging,
managed by Marko. No production activation is authorized by this development step.

## Compatibility boundary

`worker/experiments/delivery.mjs` defines a separate `experiment-preview-v1`
delivery profile. The authenticated TEST Worker now imports it for private preview routes only. The main application Worker does not import it. The local fixture Worker
is under `tests/support`, requires an explicit fixture binding and only serves
`experiment.invalid`. It has no production bindings, credentials or deployment config.

Both complete input packages are copied and verified against the existing
manifest and exact package hash. The public asset selection reuses the accepted
publisher layout: original `ads.min.js` bytes exposed as `ads.js`, plus the exact
Prebid file when present. Original ZIPs, runtime records and source files are not
rewritten. A/A can pin the same package in both groups.

The `/ads.js` loader uses per-request weighted assignment and a page-local guard.
Duplicate tags, an SPA re-insertion or a stopped/new revision cannot launch another
runtime on that document. A real new document can receive a new assignment. No
cookie, localStorage, fingerprint or IP identifier is used. Failure never starts a
second runtime after potentially partial execution. `loaded` is a script load event,
not proof of successful ad initialization or a billable impression.

The loader first loads the exact pinned `prebid.js` when the package contains it,
then the unchanged `ads.js`. A dependency error never starts the wrapper or a
fallback. Existing `pbjs`, an existing Tessera runtime marker, or another experiment
owning the shared page namespace causes a conflict. The host still provides the
approved CMP and GPT. Arbitrary third-party wrappers cannot all be detected;
removing conflicting legacy tags remains a rollout requirement.

A page-local `snapshot()` records `assigned`, `prebid-loaded`, `script-loaded`,
`load-error` or `conflict`, with elapsed milliseconds and the immutable assignment.
It sends no requests, stores no identifiers and changes no consent/GAM targeting.
Assignment is recorded before errors, so later reporting can keep failed pages in
the denominator. `script-loaded` is not an impression or runtime-success signal.
No timeout or runtime-exception outcome is inferred from a script load event.
The delivery identity includes the loader code hash as well as package/rule pins.

The loader records country only as diagnostic metadata. It does not change
`gdprApplies`, load/hide a CMP or synthesize consent. All dynamic responses prohibit
browser and CDN caching. Public asset paths include the full source package hash;
asset responses are immutable and both Prebid and the entry script have SRI. Config and manifest
files are not exposed. Caller-selected URLs, query overrides and write methods
are not accepted.

## Private TEST controls

The TEST home links to `/experiments`: choose saved A/B packages and B percentage,
save an immutable experiment, then explicitly Start or Stop its private preview.
State and events use the separate `test-experiments/v1/state.json` R2 key, guarded
by revision and conditional writes. A stale tab must refresh; it cannot overwrite
newer decisions. Starting verifies both archives; stopping retains history.
Saving new rules does not change the running experiment. New private loads after
Stop select control A. Existing documents keep their original assignment.

Delivery is login-protected under `/test-api/experiments/preview/<site>/ads.js`.
All private responses, including pinned assets, prohibit shared caching. No public
publisher path is added. These controls are not live traffic activation or revenue
reporting; the interface does not automatically execute publisher ads.

## Verified locally

Run after installing the existing locked dependencies:

```sh
node scripts/prepare-builtin-runtime.mjs
node scripts/prepare-test-workspace.mjs
node --experimental-strip-types --test tests/runtime/experiment-delivery.test.mjs tests/runtime/experiment-workerd.test.mjs tests/runtime/experiment-controls.test.mjs
```

Tests cover allocation boundaries and a controlled 10,000-sample distribution,
A/A and A/B identities, Stop on a new document, duplicate loading, load failure,
country isolation, no consent writes, cache headers, SRI, invalid manifests/pins,
cross-site rejection, caller mutation races, and original Tanjug asset preservation.
The second test uses compiled **local workerd/Miniflare HTTP** with all outbound
traffic forbidden. Unit loader execution uses Node VM. CI also runs
`scripts/verify-experiment-loader.py`: real Chromium executes the actual loader
against loopback-only synthetic packages, checking A/B, A/A, Stop, pinned dependency
ordering, SRI rejection, CSP rejection, duplicate tags, SPA reinsertion and legacy
conflicts. This is not a hosted test, live auction, GAM report or revenue result.
CSP rejection removes the nonce in the local fixture only; the normal loader
propagates the original nonce and works with a strict-dynamic policy.

## Next integration gates

1. Verify the private editor in CI using `scripts/verify-experiment-ui.py` with
   synthetic storage, loopback TLS, stale tabs and desktop/mobile layouts.
2. Add a separate preview delivery build and verification before any hosted route.
   Do not replace the existing Pages delivery profile or publisher URL by default.
3. Extend synthetic browser evidence to the new runtime on an approved test page.
   Verify actual GPT/CMP integration and configured absolute resource paths, which
   are **not rewritten** by this loader. The archived implementation expects GPT
   and the approved CMP from the host; Prebid is now loaded from its package pin.
   Unsuitable packages must be rejected rather than silently edited.
4. Implement MBA-58 assignment/render/error measurement and GAM reportable keys;
   count assigned pageviews even with no-fill or errors. Verify A/A reporting before
   comparing cached bidding strategies.
5. After TEST evidence and explicit activation, use the agreed publisher URL.
   Rollback must restore the original saved package/delivery. No live traffic has
   been changed by this foundation.

## CMP regional proposal (MBA-25)

For Google's European message, use its own targeting preset **Countries subject
to GDPR (EEA, UK, and Switzerland)**, rather than implementing a competing list
in the wrapper. EEA includes the EU plus Iceland, Liechtenstein and Norway.
For other countries, preserve the CMP's applicable regional policy; this preset
does not establish that Serbia or the rest of the world needs no privacy controls.
Unknown geography or unavailable/conflicting CMP data must not produce a forced
false flag. Actual Tanjug settings still need verification before any changes.
US state messages and other applicable obligations remain separate.

Sources checked 2026-09-17:

- [Google message targeting](https://support.google.com/admanager/answer/10076098)
- [Google EEA, UK and Switzerland CMP requirements](https://support.google.com/admanager/answer/13554116)
- [Google EU user consent policy](https://www.google.com/about/company/user-consent-policy/)

New behavior requires new script/runtime releases. Existing release history,
selected versions and Tanjug's active script remain untouched.

## Console inspector (MBA-62)

The existing Debug / Runtime section includes **A/B experiment inspect**. The
private experiment editor also exposes the same command for copying to DevTools
on the page under test. It reads assignments, selected runtime/Prebid versions,
script URLs, timeline and bounded loader-attempt/blocked-duplicate counters.
The JSON report is available at `window.__TESSERA_AB_DEBUG` and copied when the
DevTools `copy()` helper exists. Query strings, fragments, URL credentials, CMP
strings and user IDs are excluded. No network or auction is triggered.

A script tag is not an execution. Existing runtime markers are reported as markers,
not a trustworthy execution count. The counter remains unknown until a new runtime
provides initialization evidence. Generic script errors do not prove SRI vs CSP vs
network failure; the inspector directs the operator to Console/Network evidence.
This tool does not retrospectively instrument or modify archived runtime files.

## Version 3.11.0 experimental runtime (MBA-58 / MBA-62)

A separately registered `3.11.0-tessera.preview.1` candidate builder is under
`worker/runtime-observed`. It uses the preserved position compiler and adds entry
instrumentation and local GPT listeners only to the new output. The source closure
has its own checksum and recorded source commit. Old release records, default
selection and archived bytes remain unchanged. This candidate is not yet in the
selectable publisher catalog and is not deployed.

The debugger exposes per-runtime entry attempts, accepted entries and blocked
reinsertions, plus owned-slot request/render/empty/filled counts. An accepted entry
means the new runtime passed its duplicate guard, not that setup or an auction
completed successfully. It listens through GPT's command queue before the runtime's
own GPT setup. Foreign slots are ignored, including same-ID slots with a different
object; TakeOver's internal element ID maps back to its configured unit code.

Request-to-render latency is recorded only for an unambiguous request cycle.
Overlapping requests and renders without an observed request have no attributed
latency; duplicate render callbacks are ignored within the same cycle. Consequently
ambiguous cycles must be excluded from comparisons, not treated as perfect fill.
Iframe load and viewability event counts are separate observations, not billable
impressions or revenue. First filled render is timed from runtime observation start,
not navigation start or experiment assignment. Logs cap at 500 entries while totals
continue; `droppedEvents` reports the truncation. Stop removes this observer's
listeners, including when GPT has not loaded yet, without stopping ads.

No identifiers, consent reads/writes, storage, telemetry requests, GAM targeting,
cache changes or revenue estimates are added. Central aggregation, GAM keys and
consent-aware telemetry remain pending. CI executes the compiled new candidate in
Chromium using mocked GPT/Prebid; it does not call real ad services.

Event meanings follow the official [GPT event listener sample](https://developers.google.com/publisher-tag/samples/ad-event-listeners)
and [GPT reference](https://developers.google.com/publisher-tag/reference), checked
2026-09-17. Real Tanjug/GPT/CMP integration remains a separate verification gate.
