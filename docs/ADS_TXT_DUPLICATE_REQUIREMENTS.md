# Duplicate-preserving ads.txt requirements

Tessera keeps two complementary views of ads.txt requirements:

- `ads_txt_requirement_sources` stores every partner-provided row separately, including repeated canonical records, source labels, inline comments and independent row IDs.
- `ads_txt_requirements` remains the canonical Monitoring view with one row per ads.txt record.

## Behavior

- Manual add, import and copy do not remove repeated source rows.
- Plain-text and CSV imports preserve inline comments such as `#Smaato`, including comments containing commas; full-line `# Partner` headings become the label for following rows.
- Ads.txt variable declarations such as `OWNERDOMAIN=novosti.rs`, `MANAGERDOMAIN=...`, `CONTACT=...`, `SUBDOMAIN=...` and future `VARIABLE=VALUE` records are preserved and monitored instead of being rejected as malformed seller rows.
- Each source row has independent Edit and Delete actions.
- If any source row for a canonical record is required, the canonical Monitoring row is required.
- Removing one source row does not remove the canonical Monitoring row while another source still requires that record.
- Check now maps the canonical live result back to every source row.
- Monitoring and Gmail notifications continue to report one missing canonical record and one corrected ads.txt line.

## Migration safety

Migration `0006_ads_txt_requirement_sources.sql` is additive. It creates the source table and backfills current rows without rebuilding or replacing the existing canonical table. The Worker runtime fallback performs bootstrap in two stages: tables first, followed by indexes and backfill, so a deployment remains safe even before the migration command is run manually.

## Concurrency and atomicity

Source mutations use a per-site D1 claim. Reads used by PATCH and DELETE occur while the claim is held. Every batch checks ownership both before and after the source write, canonical reconciliation and audit insert. If the claim is missing or expires, a database assertion fails and D1 rolls back the entire batch instead of leaving the source and Monitoring tables out of sync.

## Legacy rows

Copy and site-duplication operations use the fields already stored in the source table rather than reparsing them. This preserves older malformed rows so they remain visible and editable instead of blocking the complete copy operation.

## Site duplication

When a site is duplicated with `copyAdsTxtRequirements`, Tessera copies the complete source-row set after the existing site duplication succeeds and then reconciles the target canonical Monitoring table. An empty source snapshot also clears any canonical rows copied during the first phase. If the second phase fails, Tessera automatically deletes the newly created site so the operator can retry without an orphaned or incomplete duplicate.
