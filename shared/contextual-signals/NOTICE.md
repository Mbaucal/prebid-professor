# Context taxonomy data

The category IDs, labels and SCD markers in `catalog.mjs` are derived from IAB Tech Lab's Content Taxonomy 2.2 and Content Taxonomy 3.0 TSV files at commit `0fa1a8b3d7b6a94d245ee858d936dcfe021ca2c5` of https://github.com/InteractiveAdvertisingBureau/Taxonomies.

Copyright IAB Technology Laboratory. Licensed under Creative Commons Attribution 3.0: https://creativecommons.org/licenses/by/3.0/.

Adaptation: blank/header rows removed, tier names joined for display, SCD converted to a boolean. IDs retained verbatim, including alphanumeric 3.0 IDs. No inferred mapping between taxonomy versions. Per-file source SHA-256 is embedded in the catalog. This is an identifier catalog, not evidence that an SSP or GAM accepts every category. Google notes that some sensitive categories are unsupported.
