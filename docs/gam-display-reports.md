# Original GAM display exports for any site

Open **Publishers → publisher → site → Measurement → GAM display reports**.
The same five presets are available for every site. Politika's original exports
were the reviewed starting format, not a restriction on the importer.

Create a Historical Interactive report for the selected site's display inventory.
The report name is your choice. Use the listed dimensions and metrics; the importer
recognizes the column set, not a saved report ID or publisher name. Each preset's
exact columns and filter instructions are shown under **GAM export settings and
saved reports**. Report 02 uses Ad server metrics and your exact Prebid order or
line-item scope. The other reports do not use delivery filters. Metric availability
depends on the GAM network; selecting these presets does not enable paid features.

Export a flat human-label **CSV**, with **Include report properties** enabled.
Turn off totals, hidden/filtered data, formatting fields and API column names.
Use the same completed date range, currency and time zone for comparable exports.
Revenue remains in integer micros during calculation; the CSV's row-level rounding
is not recoverable, so keep the XLSX original when reconciling finer precision.

Upload one or up to five CSV files. A later file replaces the same preset; files
are never appended. Imports stay in browser memory only. Nothing is uploaded,
persisted, sent to GAM or applied to an ad script. Leaving the site, reloading,
clearing reports or applying new report checks removes the current data. Late file
reads from an old site cannot restore data in the new site.

## Report scope and MCM

The panel displays the selected site's saved GAM path alongside the actual export
network, currency, time zone, inventory roots and filter IDs. A publisher network
**name** does not authenticate a numeric network code; MCM parent/child paths can
differ. Unknown network/inventory scope stays explicitly unverified.

Under **Optional expected export identifiers**, enter known export network name
or code, inventory root name/ID and Prebid order/line-item IDs to check all five
files. Matching identifiers verifies the declared report scope, not the original
CSV's authenticity. A root must match a complete root or descendant boundary;
`Site` never matches `Site2`. Missing metadata is not silently replaced with EUR,
Europe/Belgrade or Politika's IDs. Optional declared currency/time zone fills
missing metadata and must agree when the properties are present.

Only the displayed ID-filter grammar is supported. Unknown, repeated or ambiguous
filters are rejected rather than ignored. Mixed periods, declared networks,
inventory, currencies or time zones are flagged; reports remain separate.

## Interpretation boundaries

- Raw **Key-values** rows overlap. Variant, bid origin, refresh and timing families
  are viewed separately and cannot be joined or summed into one grand total.
- Report 01 derives display ad requests from matching code-served plus unfilled
  rows. Report 03 uses the reported request count and checks the same relationship.
  This is not a video/optimized-pod importer.
- `aq_bid_origin` describes the primary bid sent to GAM; it does not prove that
  a cached creative won. Report 02 must be checked against actual Prebid IDs.
- Report 03 includes unlabeled inventory and cannot be allocated to A/B variants.
- Timing labels can repeat on later slots/refreshes; they do not count all pages
  or establish page latency percentiles.
- Missing data stays unknown. Active View anomalies retain raw counters but
  suppress the affected percentage. Rates use summed counts, not mean percentages.
- A chosen period can contain multiple tests or packages. For package-specific
  analysis, use the actual VersionId/TestId filter and supported joint dimensions
  in the saved A/B report flow. These exports do not establish a joint Version ID × Variant package match,
  complete assigned-page coverage, page RPM, causal uplift or an A/B winner.
  Use the separate saved A/B reporting flow for its supported joint dimensions.

The older `politika-gam-csv` module/script entry points remain compatibility
adapters for already reviewed original exports. The shared UI uses neutral presets
and does not contain Politika-specific saved report links or network defaults.
