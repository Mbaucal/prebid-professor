# Regional CMP experiment: native scope is not GPT recovery

This is isolated test evidence, not a production serving workaround. The existing
`loading` CMP cannot be rescued by telling Prebid alone that GDPR is out of scope.
No publisher API, deployed package, registry, version, or advertising configuration
is changed. The older native IAB replacement/cache blockers remain unresolved.

## Concrete integration direction

Make the regional decision **before CMP, Prebid, and GPT initialization**, under
exclusive publisher control of CMP startup. A fresh, page-bound response from a
publisher-configured trusted endpoint and an explicit regional policy may select
the regional startup plan. That branch configures native Prebid TCF in static mode
with `consentData.getTCData.gdprApplies:false`, without a TC string, and does not
initialize a TCF CMP. Unknown/disallowed scope uses the normal CMP route. This
means out-of-scope, not fabricated consent. The module remains enabled.

The fixture's positive early branch uses the actual controller's
`planRegionalStartup`, then locked native Prebid, then actual Google GPT JavaScript.
It asserts no existing CMP, initialized Prebid, or initialized GPT before choosing
the plan. Its intercepted ad-request attempt proves only that this startup order
can reach the network boundary with no installed CMP. It proves neither delivery,
revenue, personalization, nor that GPT consumed Prebid's regional scope. The
receipt preserves GPT's actual `gdpr` parameter: the early regional request had
`gdpr` absent, while the ready-false CMP control had `gdpr=0`. Thus the positive
branch does not demonstrate that GPT and Prebid consumed the same scope. All seven
native contracts and seven GPT characterizations reproduced; the four perpetual
loading GPT cases each delivered 37 successful callbacks and zero ad attempts.
GPT reported version `202609290101` and completed `display` in every case.

This requires a reviewed publisher integration (including Tanjug's CMP ownership
and GAM regional settings). Google Funding Choices' regional message setting can
hide the message; that alone does not establish that no TCF API is installed.
`controlledMessagingFunction` controls message display, not GDPR scope. The pure
startup planner does not inject libraries or wire a production consent observer.
A running CMP reporting `gdprApplies:true`, even while loading, is a conflict and
must not be overridden by this regional branch.

## What the isolated proof covers

Seven native cases use the actual geo controller and locked vendored Prebid
11.34.0 consent/core with a synthetic adapter and intercepted synthetic demand:
repeated successful loading beyond the experiment's 30-second threshold; denied
scope; loading with true scope; later Reject; later true/loading; Reject while a
bid response is held; and same-page refresh. Later authoritative scope invalidates
the controller epoch and suppresses subsequent requests or held-response dispatch.
Native static mode is not switched into IAB mode. Native dispatch here is a simple
simulated sink, not `createGamReporting` or GPT. These checks do not resolve the
previous native IAB listener/cache replacement failures.

Real GPT is a separate characterization using standard and dedicated limited-ad
libraries. Both stuck-loading scenarios repeatedly call listeners with
`success:true` for 35 seconds of browser-clock time. No-CMP and ready-false controls
ensure GPT can initialize and attempt a request under the same interception.
Manual limited ads are tested only through the dedicated URL and documented
privacy setting; they are not NPA and are not offered as a proven stuck-CMP fix.
All network routes are intercepted before traffic leaves the browser. Google
configuration, dictionary, telemetry, and ad endpoints are blocked or fulfilled
locally. The sample slot is Google's documented sample, not publisher inventory.
Real geo is simulated; server eligibility and CMP/publisher integration remain
unverified. A failed GPT initialization is a characterization failure, never proof
that ads are blocked.

## Reproduce

Run `npm ci` and install `playwright==1.55.0` plus its Chromium as in the existing
consent CI. From the repository root:

```sh
python scripts/verify-geo-cmp-fallback.py --native-only
python scripts/verify-geo-cmp-fallback.py --fetch-gpt-fixtures
python scripts/verify-geo-cmp-fallback.py
```

`--native-only` needs no downloaded Google sources, explicitly records GPT skipped,
and exits 0 only if every native check passes. It does not establish end-to-end
readiness. The fetch command downloads only four public Google JavaScript assets;
it makes no ad requests. Google bootstrap URLs change: each acquisition records
exact URLs, byte counts and hashes in `sources.json`. Full replay validates those
hashes and permits no browser network access. `--gpt-dir PATH` selects a preserved
source directory; Google source is not vendored. `CHROMIUM_PATH` optionally selects
the executable; Playwright's `PLAYWRIGHT_BROWSERS_PATH` is supported.

Results are written to `.generated/geo-cmp-fallback/results.json`. The full run
intentionally exits **1**, with `endToEndFallbackReady:false`, even when all native
contracts and GPT characterizations reproduce: the original already-loading CMP
serving fallback remains unsupported. Review case failures separately from this
acceptance marker. The committed receipt contains sanitized classifications and
counts, no TC strings, auction identifiers, or ad-request query strings.

## Official sources

- [Prebid CMP best practices](https://docs.prebid.org/dev-docs/cmp-best-practices.html): publisher/CMP owns applicability; publisher geographic alignment is supported.
- [Prebid TCF module](https://docs.prebid.org/dev-docs/modules/consentManagementTcf.html): static consent configuration and timeout behavior.
- [Google TCF integration](https://support.google.com/admanager/answer/9805023): GPT automatically consumes the CMP and waits for valid TCF information.
- [GPT reference](https://developers.google.com/publisher-tag/reference): documented privacy settings contain no authoritative `gdprApplies` override.
- [Limited ads sample](https://developers.google.com/publisher-tag/samples/display-limited-ad): dedicated library and manual limited-ad setting.
- [Funding Choices API](https://developers.google.com/funding-choices/fc-api-docs): message control versus consent availability.
- [Regional message settings](https://support.google.com/admanager/answer/10076098): geographic message configuration needs integration validation, not assumptions about API absence.
