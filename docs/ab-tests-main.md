# A/B tests for saved site versions (MBA-416)

The MAIN **Generate and releases** workspace offers **A/B tests** to every site
using built-in saved packages. Give each generated version a name, choose A and
B, check compatibility and save an immutable experiment. A defaults to the
current built-in production release recorded in Tessera. If that release is
missing or from another release format, choose a control explicitly;
Tessera does not infer what a separately hosted publisher page currently runs.
Ambiguous production records block preparation until the site releases are checked.

Compatibility checks verify complete saved package bytes, site identity, the
same Prebid file, GAM path, page layout and consent-related settings. The
summary reports other changes, including cache, bidders, refresh and script
versions. To measure cache alone, generate both versions with **3.25.1**, the
same Prebid build and settings, changing only cache OFF/ON. A new auction still
runs when a valid cached bid exists; the experiment does not change that rule.

## Manual delivery

Download **A/B ZIP** and upload every file unchanged as one Pages deployment.
The root `/ads.js` is the experiment loader; it serves the exact saved compact
scripts from `r/<release>/ads.js` with SRI. Both arms share the verified root
`prebid.js` when Prebid is enabled. The experiment keeps its own copies, so
deleting an original saved release does not remove its scripts.

Keep the approved CMP and GPT installation. A Prebid-enabled built-in package
requires its shared `prebid.js` before `/ads.js`; the experiment loader does not
load Prebid for the publisher. GAM-only packages do not need that file. Follow
the saved package's installation instructions. In particular, an older pilot
that loaded Prebid automatically needs an installation check before replacing
its loader. The existing URL can remain for an already compliant installation.

Set up reportable GAM keys `Variant` (`A`, `B`) and `TestId` (the saved test's
value) before collecting data. In **API integrations → Key-values**, select
these keys and enter the exact saved TestId values. Preview the add-only plan:
it reuses existing keys and values and creates only missing ones. TestId values
must be explicit; there are no invented sample values. Saving or downloading an
experiment itself does not write to GAM. The A/B panel supplies the checklist
and exact TestId.

**Mark live** and **Mark stopped** record operator events only. They do not
publish, stop, switch channels or modify files on a publisher site. To stop a
manually deployed test, upload the exact approved control package at the same
URL, or restore its Pages deployment, and then record the stopped event.
Deleting a test hides it from the active list; its bytes and TestId stay reserved.

The prior Tanjug library and its saved ZIPs remain available during this
transition. This change does not rewrite or retire them automatically.

## MAIN API boundary

`/api/publishers/<site>/ab-tests` mounts the shared experiment API after MAIN
administrator authentication and same-origin mutation checks. All package SQL,
manifest identities and R2 prefixes are scoped to that site. MAIN accepts saved
`builtin-release-*` versions; TEST draft IDs do not become MAIN sources.

- `GET /` lists experiments and verified saved-version metadata.
- `POST /check` verifies compatibility without writes.
- `POST /` saves once; repeating identical inputs returns the existing test.
- `GET /<abx>`, `/download` and `/record` read verified stored artifacts.
- `POST /<abx>/events` records live/stopped events.
- `DELETE /<abx>` and `PUT /<abx>` hide/restore with exact ID and ZIP confirmation.

Experiment files use create-only R2 writes with read-back checks. The record is
the final commit point. No operation here changes publisher settings, release
channels or active GAM entities. A storage error remains visible and can be
retried; it does not authorize replacement of uncertain existing bytes.

## Measurement and verification limits

Assignment is per page view, without cookies or storage. `Variant` and `TestId`
describe the assigned group. A B-to-A load fallback retains assigned B, so these
keys do not prove which script executed, which ad won or what revenue it earned.
The loader diagnostic exposes the actual script identity and fallback status.
QA overrides are unlabelled and do not count as measured assignment.

New experiments use the separately registered loader **1.0.2**. Its eight-second
load deadline permits one control retry and blocks a retired arm from starting
later through the verified native startup guard. A control that also fails is
reported without repeated requests. The original 1.0.0/1.0.1 source and old saved
experiment bytes remain unchanged.

Before startup, missing label prerequisites or conflicting reserved keys choose
control A without experiment attribution. Later conflicts exclude the page from
measurement while preserving the running script and unrelated publisher data.
Checks at GPT display/refresh cover page and slot targeting, including the
modern configuration API. Only labels owned by this experiment are removed;
publisher-owned reserved values are preserved. Inspect the loader diagnostic's
exclusion reason instead of interpreting these pages as measured B delivery.

Revenue comparison, all-assigned-pageview denominators, executed-versus-assigned
coverage, distribution checks and GAM report imports belong to MBA-58. A passing
compatibility check or `aq_bid_origin=cached` is not revenue evidence.

Automated verification uses local SQLite/R2, the MAIN Worker and panel, genuine
saved 3.25.1 packages, native Prebid, pinned browser/GPT assets and intercepted
synthetic demand. It covers desktop/mobile actions and loading/error recovery,
exact downloaded ZIPs, first/refresh/lazy labels, CMP waiting, SRI/CORS/CSP,
duplicate tags and load failures. It performs no live publisher activation,
paid ad traffic or GAM writes. The existing legacy A/B CI job remains separate;
new MAIN coverage runs in the parallel `generic-ab` job of the same workflow.
