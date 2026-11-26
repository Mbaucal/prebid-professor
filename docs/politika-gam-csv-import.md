# Politika GAM CSV review

For a site whose domain is `politika.rs` or `www.politika.rs`, open **Measurement → Politika GAM reports** and choose up to five original GAM CSV exports. Columns identify the report automatically. Each new file replaces the corresponding report; exports are never appended. Files and results remain in this browser view only and are cleared on navigation or reload.

Use the saved reports in network `23339552141`, the `Politika.rs - Display` inventory including children, a common completed date range, EUR and Europe/Belgrade. Export the flat table with human-readable English column names. Report properties are supported and recommended; turn off totals, hidden/filtered data, formatting fields and API column names. Without properties, currency, time zone and filter scope remain explicitly assumed. XLSX is not imported.

| Report | Supported interpretation |
| --- | --- |
| 01 Monetization | Variant A/B totals across demand. Display requests are code served + unfilled; request RPM uses that denominator. |
| 02 Prebid | Ad server counters for the five saved Prebid orders; separate Variant and bid-origin families. No joint Variant × origin or request denominator. |
| 03 Unfilled inventory | Direct total display requests, code served and unfilled. Site-wide; no A/B allocation. |
| 04 Refresh | Separate refresh bucket and interval families. |
| 05 First request and CMP | Separate first-request and consent-wait labels. Delivery counters are not page latency distributions. |

Use the key-family selector and date/ad-unit/device/line-item/requested-size filters for the dimensions actually present in each report. Ratios come from summed raw counters. Missing metrics poison only their affected totals and ratios; missing rows never imply zero traffic. Reports with different periods remain separate and show a warning.

The legacy pilot exports have no sent `VersionId`/`TestId` or all-assigned-page-view denominator. They do not establish a saved package match, page RPM, causal uplift or a winner. The existing immutable, package-bound v2 flow is unchanged. `aq_bid_origin=cached` is targeting context, not proof that GAM served a cached creative. GAM Prebid revenue uses line-item rates and needs SSP reconciliation. GAM CSV revenue rounding is retained; keep XLSX for greater precision.

The importer accepts 20 MiB / 200,000 detail rows per file (the observed seven-day Prebid export exceeded the older 10,000-row limit). It validates headers, quoted CSV cells, grain uniqueness, inventory, properties, date bounds, numeric precision and request components. It never combines overlapping key families or files. Source rows with viewable > measurable keep their raw counters, but affected viewability ratios are withheld.

The corrected report 05 includes all 14 first-request/CMP key-value selections, including `aq_consent_wait=lt_500` and `aq_consent_wait=500_999`. Older exports with the incomplete 12-value filter remain readable but show an explicit coverage warning; re-export them for comparison.

## Verification

- `node --experimental-strip-types --test tests/runtime/politika-gam-csv.test.mjs`
- Existing `gam-report-v2*.test.mjs` and `ab-measurement*.test.mjs` regressions.
- `python scripts/verify-politika-gam-import-ui.py` uses the real App and synthetic authenticated MAIN router with all traffic intercepted. It covers desktop/narrow import, family isolation, filters, replacement, invalid-file recovery, loading, cancellation and stale reads across sites. No SQL/R2 mutations or outbound requests are allowed.
- Existing `verify-gam-report-v2-ui.py`, all typecheck targets and the production build.

All five actual GAM CSV exports (89,871 rows and 24 separate groups) were also parsed locally and their separate family counters reconciled with an independent Python CSV/Decimal calculation. The actual files passed a local full-App import, including the large Prebid file, corrected CMP categories and a mismatched-period warning. Real CSVs and financial totals are excluded from fixtures, git and CI artifacts. Local verification is not a hosted deployment or production verification.
