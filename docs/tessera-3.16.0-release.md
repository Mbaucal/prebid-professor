# Tessera 3.16.0

Tessera offers a choice of supported script versions for generating a standalone site package from saved configuration. **3.16.0** is the current release. Changing the script version keeps the site's ad units, size maps, bidders and other settings. It supports GAM / AdX only and GAM + Prebid. Public labels, version history and new package metadata use the same product version.

## Operator flow

1. Open the site, then **Config → Script → Script setup**.
2. Choose **GAM / AdX only** or **GAM + Prebid** and select the desired supported **Script version**, then click **Save script setup**. A new setup offers **3.16.0** by default. An earlier saved build stays selected until explicitly changed; **Use current version** is an optional shortcut. Public version choices use numeric release names, with no development snapshots offered as new choices.
3. Save the site's ad units, size maps, bidders, Deals and Formats. Deals require separate SSP and GAM configuration. Outstream currently supports the checked PubMatic / Prebid 11.34.0 integration; confirm partner activation, renderer ID, VAST cache and the compatible GAM/PUC creative.
4. Open **Generate and releases**, generate a new package and download its verified ZIP. The package includes the saved configuration and script; it does not require Tessera administration to execute on the publisher site.
5. Follow the package's README and implementation example for script order and containers. Load the approved CMP before the ad libraries. Use one Tessera script. Review on the intended site before publication.

Video dimensions use the selected position's size-map breakpoint. A single eligible size is automatic; choose once where a breakpoint has several eligible sizes. Banner sizes are independent. Outstream is limited to Standard in-page positions; video-enabled positions do not automatically refresh.

## Identity and compatibility

The new engine identity is `tessera-3.16.0`, version `3.16.0`, channel `stable`. Selecting it does not require preview acceptance. Its exact source is recorded at commit `1427580b80b28c19d5cc01e5f7e68b9cb18db74b`, source SHA-256 `624afa6dff60db3f6da1f71ada6d89c55c513d1c72ddbe210b3b2246832c69b9`.

New `config.json`, `manifest.json`, README, implementation example and generated JavaScript identify **3.16.0**. Package IDs remain content-based. The public history groups earlier development builds under their product version, preferring the stable release's notes. This presentation does not change historical records, old pins, hashes or stored ZIP bytes.

Existing saved configurations keep their selected build until explicitly updated. A mode change alone does not upgrade the engine. Selecting a different compatible script version changes its exact runtime pin and preserves other site settings and the checked Prebid build. An incompatible version is rejected with an explanation before saving, without resetting settings. Generate a new package after saving the selected script version. Existing packages remain readable and downloadable. Generation, storing, staging and publication remain separate actions; this release does not change publisher configuration or live script URLs automatically.

Consent remains under CMP authority. Missing or pending CMP decisions never become permission because time elapsed. Real partner delivery, creative/player lifecycle and revenue require observation on the configured publisher site; synthetic verification uses no paid traffic.
