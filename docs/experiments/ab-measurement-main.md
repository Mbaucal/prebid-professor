# Review GAM results for a saved A/B test

Open the site's **A/B tests**, then open **Measurement** for the saved test. The
test, its original scripts and its ZIP remain immutable. Preparing a report does
not publish a script or change Google Ad Manager.

1. Prepare a reporting plan for the exact saved test. Confirm the reporting
   dates, currency, GAM time zone, revenue basis and revenue metric. The network
   and inventory must match both verified saved source packages.
2. Download the plan's CSV template and follow the reporting guidance. Export
   joint `TestId` and `Variant` dimensions from GAM for that exact inventory and
   period, then normalize the daily rows to the template.
3. Import or paste the CSV and review the quality messages before interpreting
   the A/B totals. Download the JSON review to retain a local copy.

The reporting plan is stored privately with the experiment. Its content identity
includes the experiment record and ZIP hashes, both release/script/runtime pins,
the loader pin, traffic split and reporting context. Repeating the same plan
request returns the existing plan. A different reporting context creates a new
plan; it does not edit an earlier one. Existing plans remain readable when an
original source release is no longer available.

Raw CSV and computed previews are processed in memory and are not stored by this
feature. They are still transmitted to the authenticated Tessera API for parsing.
The result export is an operator download. Changing the input or encountering an
error clears the previous preview in the UI.

## Compatible report data

Use one row for each date and assigned `Variant=A|B` under the plan's exact
`TestId`. Missing days or groups remain missing. Fill the required impression and
revenue fields; blank optional metrics are unknown, not zero. Duplicate rows,
another test, another period, ambiguous raw Key-values
exports and invalid numeric input are refused. Do not sum overlapping Key-values
rows, a report total and its details, or the same revenue from GAM and an SSP.

The source package proves the saved inventory/network and delivery identity. It
does not independently authenticate the uploaded GAM report or its declared
currency, time zone, gross/net basis and revenue metric. Match those settings in
the original report. A shared time zone alone does not reconcile a page assigned
before midnight with its later ad requests.

Revenue per thousand impressions is descriptive eCPM. Response rate uses
responses served and ad requests from the same imported population. Viewability
uses measurable impressions as its denominator. None of these is page RPM.

## Assignment diagnostics and readiness

New A/B bundles use loader **1.1.0**, with a versioned, bounded, page-local
assignment/outcome ledger. It keeps the original random group separate from the
script that executes, control fallback, exclusions and load failures. It sends
no external measurement request and adds no persistent visitor identifier.
Existing loader versions and saved ZIPs retain their original bytes.

On a page using the new bundle, inspect the copied ledger with
`window.__tesseraAbLoader.measurement()` or `window.AdVariant.measurement()`.
Re-saving an existing test returns its original loader and ZIP. Use a new TestId
for a new bundle; reporting plans do not retrofit instrumentation into old files.

Assignment to B followed by execution of A still belongs to assigned B for an
intention-to-treat comparison. Exclusions after assignment and failed loads stay
in the assigned-page denominator. Revenue from requests that lost their test
labels is missing revenue; treating it as zero would bias the result.

This phase has no production assignment collector and cannot establish complete
assigned-page coverage. The preview therefore leaves **page RPM, uplift and the
winner unavailable**, even when every daily GAM row is present. GAM impressions
and ad requests cannot substitute for all assigned pageviews. There is no manual
override for this readiness rule.

Before an external collector can be enabled, its eligible population, handling
after CMP rejection, payload, storage and retention must be decided explicitly.
The current reporting and local diagnostic features do not change CMP authority
or permission to serve ads. The previously accepted A/A delivery check does not
need to be repeated for this offline reporting phase.

## Verification boundary

Automated checks use synthetic sites, local storage and intercepted demand. They
verify authenticated MAIN routes, site boundaries, immutable source bytes,
idempotent plan creation, strict parsing, missing-data handling and desktop/mobile
recovery. They do not prove real revenue lift, a publisher's deployed script, an
authenticated hosted UI session or actual GAM report completeness.
