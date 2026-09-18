# Private TEST GAM report review

Status: implemented in draft PR #63. No GAM API connection, live publisher change,
experiment activation or modification to existing script versions. This is a
read-only preview of an explicitly uploaded, normalized report. Reports are not
saved in R2; download the JSON review to retain the result. Reloading clears it.

Open **Review GAM report** on a saved experiment with prepared, verified labels
for both arms. Download its template, map the GAM export to the columns below,
enter the report's inclusive dates, currency, time zone, revenue metric and basis,
then preview it. The template contains the exact two experiment values and blank
metrics; it does not supply synthetic zeroes or real report data.

## Normalized input contract

One report covers one experiment/delivery, one currency, one time zone and the
same inventory scope and filters for both arms. Supply one daily row per value.
Aggregate any other GAM dimensions before import; do not include subtotals or
grand totals. This is a Tessera template, not an automatic parser for every GAM
UI/API export format. No localized-header or metric-name guessing is performed.

| CSV column | Source / format |
| --- | --- |
| `date` | GAM report date, `YYYY-MM-DD`, in its original time zone |
| `value` | `A` or `B` for `Varijant` (3.14.0); original mapped value for legacy experiments |
| `impressions` | Total impressions, whole number |
| `revenue` | Selected Total revenue or Total CPM and CPC revenue, decimal currency units |
| `adRequests` | Total ad requests, whole number, optional with responsesServed |
| `responsesServed` | Total responses served, whole number, optional with adRequests |
| `measurableImpressions` | Total Active View measurable impressions, optional with viewableImpressions |
| `viewableImpressions` | Total Active View viewable impressions, optional with measurableImpressions |

The distinction between total revenue (including CPD) and CPM/CPC revenue, and the
Active View measurable denominator, follows the [official GAM metric definitions](https://developers.google.com/ad-manager/api/reference/v202511/ReportService.Column).
The displayed revenue per 1,000 impressions is calculated from the selected
revenue total. It need not equal GAM's average eCPM when the selected revenue
includes CPD. Response rate is responses served / requests, not impressions /
requests. This display-report profile rejects responses above requests and
viewable above measurable counts; different inventory semantics need a separate
reviewed profile.

Use the exact eight headers in the template order. Optional pairs may be blank;
unavailable metrics stay null. If any supplied row lacks a metric, its aggregate
rate is unavailable instead of treating that row as zero. Use decimal points,
without currency symbols or thousands separators, and at most six revenue decimal
places. Negative revenue adjustments are supported. Money is parsed to exact safe
integer micro-units; out-of-range values and aggregate overflow are rejected.
Do not import percentages or average eCPMs in place of raw totals.

UTF-8 (optional BOM), LF/CRLF and quoted scalar cells are accepted. Multiline cells,
extra dimensions/columns, duplicate day/value rows, malformed dates, values from
another experiment and localized numeric formats are rejected. Maximum CSV size:
128 KB, 366 days / 732 rows. The authenticated same-origin JSON request has its own
256 KB transport cap. Input is data only; neither CSV cells nor filenames execute.

## Review semantics

* A missing day/value row is unknown, never synthesized as zero. A completely absent
  arm has null totals. Explicit zero rows should only be supplied when verified in
  the source report. Visible totals always describe the provided rows, even when
  the period is incomplete.
* Rates use summed raw counts, not an average of daily rates. Zero denominators
  return null. Revenue strings preserve six decimal places; displayed percentages
  may be rounded without changing the JSON totals.
* Whole-day completeness is checked in the declared report time zone. Current and
  future days, an unknown revenue basis and a zero-allocation arm are flagged.
  A closed day is not proof that GAM's data is final or independently verified.
* Received assignments are read from the selected delivery's private collection,
  including load errors/conflicts/pending outcomes. Only dates in the requested
  range are shown, and only when both data sets use UTC. Non-UTC GAM days are not
  relabeled or silently joined to UTC assignment days. These are different cohorts:
  assignments are dated by allocation, GAM outcomes by reporting date. Pages can
  cross midnight and outcomes may arrive after the period.
* Currency and revenue basis are declarations from the uploaded report, not an
  automatic validation against GAM. No currency conversion, cross-file merging,
  GAM/SSP revenue addition or ownership verification is performed. Confirm the
  source network, exact inventory/filter scope, revenue basis and metric availability
  in the real GAM export before a measured pilot.
* Even a structurally complete file has `revenueReady: false`, `coverage: unknown`,
  null page RPM, null uplift and no winner. The bounded private assignment sample
  cannot justify revenue per page. There is no user-supplied flag that can override
  this restriction. Sampling coverage, reporting scope, cross-day cohort handling,
  uncertainty and a verified real GAM A/A comparison remain outstanding.

The downloadable JSON identifies the full experiment/delivery, original CSV
SHA-256, metadata, totals, missing rows and blockers. It contains no raw CSV or
page IDs. Changing an input or encountering an import error clears the previous
review, preventing a stale result from being downloaded as the current one.

## Verification

Node tests exercise exact money, weighted rates, UTC range filtering, missing arms,
negative adjustments, zero denominators, incomplete optional metrics, foreign
labels, duplicate rows, malformed CSV, date/time-zone errors, unknown revenue basis,
sample capacity, overflow and request size/auth boundaries. Read-only HTTP tests
assert that review causes no R2 writes. The CI Chromium flow uses the actual TEST
Worker: generate measured A/A, prepare mapping, download template, upload synthetic
CSV, download JSON, reject duplicate rows, show missing B/time-zone mismatch and
check mobile layout. Synthetic data only; no live GAM requests.

## Public A/B values in 3.14.0

New candidates use `Varijant` with exactly `A` and `B`. Prepare GAM values and
the CSV template use that key and those values. Legacy stored mappings are not
rewritten, and mixed measurement formats cannot export a comparison.

Because values are reused, the importer cannot detect a report from a different
test by its A/B labels alone. Filter the source GAM report to the chosen site,
ad units and non-overlapping test period/revision. The preview explicitly retains
this verification requirement; revenue readiness and winner remain unavailable.
