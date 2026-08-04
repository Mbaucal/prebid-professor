# Duplicate-preserving ads.txt requirements

Tessera keeps two complementary views of ads.txt requirements:

- `ads_txt_requirement_sources` stores every partner-provided row separately, including repeated canonical records, source labels, inline comments and independent row IDs.
- `ads_txt_requirements` remains the canonical Monitoring view with one row per ads.txt record.

## Behavior

- Manual add, import and copy do not remove repeated source rows.
- Each source row has independent Edit and Delete actions.
- If any source row for a canonical record is required, the canonical Monitoring row is required.
- Removing one source row does not remove the canonical Monitoring row while another source still requires that record.
- Check now maps the canonical live result back to every source row.
- Monitoring and Gmail notifications continue to report one missing canonical record and one corrected ads.txt line.

## Migration safety

Migration `0006_ads_txt_requirement_sources.sql` is additive. It creates the source table and backfills current rows without rebuilding or replacing the existing canonical table.

## Concurrency

Source mutations use a per-site D1 claim. Reads used by PATCH and DELETE occur while the claim is held, and every source write, canonical reconciliation and audit insert requires the current, unexpired claim token.

## Site duplication

When a site is duplicated with `copyAdsTxtRequirements`, Tessera copies the complete source-row set after the existing site duplication succeeds and then reconciles the target canonical Monitoring table.
