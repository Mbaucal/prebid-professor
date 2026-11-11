# Contextual signals / PPS — MBA-338

Optional contextual signals map exact values from a saved `window.adsKeywords` key (default `category`) to explicit IAB content IDs. The feature defaults off. Saving does not require a future page category, choose a new script for a site, generate a release, or publish anything. Existing runtime versions and ZIPs remain immutable.

## Taxonomy choices

| Destination | Supported setting | Encoding | Acceptance evidence |
|---|---|---|---|
| GAM | IAB Content 2.2 | `pps.taxonomies.IAB_CONTENT_2_2.values` | GPT API support; account/demand eligibility still required |
| Selected Prebid bidder | IAB Content 2.2 | `site.content.data[].ext.segtax: 6` | Adapter and SSP dependent |
| Selected Prebid bidder | IAB Content 3.0 | `site.content.data[].ext.segtax: 7` | Adapter and SSP dependent |

Catalogs are separate snapshots from IAB Taxonomies commit `0fa1a8b3d7b6a94d245ee858d936dcfe021ca2c5`: 1,196 Content 2.2 IDs and 703 Content 3.0 IDs. IDs stay strings, including alphanumeric 3.0 IDs. No automatic cross-version conversion or relabeling occurs. Provenance/checksums and CC BY 3.0 attribution are in `shared/contextual-signals/NOTICE.md`. Catalog presence is not buyer eligibility; GAM documents limitations for sensitive categories.

Google currently documents PPS as a GAM 360 feature. Demand-channel sharing and account controls can affect use. GAM and Prebid destinations are independently enabled. This implementation does not create audiences, infer interests, collect identifiers, or read/write cookies/localStorage.

## Auction-local delivery

The custom Prebid RTD provider `contextualSignalsRtdProvider` works with `rtdModule`. The dashboard's integration kit contains its canonical source, current saved module list plus these two modules, exact reviewed version pins and build instructions. The standard Prebid.org download builder does not include this project-specific provider. A custom build must preserve the approved bidders, consent and other modules.

The wrapper uses the documented RTD `getBidRequestData` hook to enrich auction-local bidder fragments. It does not overwrite `pbjs.setBidderConfig`, global `ortb2`, publisher content or SChain. Category context is captured at the actual request after existing readiness gates. Missing modules, unmapped categories and optional enrichment errors omit signals without delaying ads. Existing consent authority remains unchanged. Another RTD provider can affect the final data; inspect actual HTTP payloads for final evidence.

GAM PPS is page-level and has no supported public getter. Enabling GAM here explicitly gives the wrapper sole control of the entire GPT PPS feature. Do not combine it with another PPS writer, including an audience/structured PPS writer. The wrapper clears stale values for unmapped categories. Other targeting features remain managed by their existing code.

## Adapter evidence, not a universal SSP guarantee

Source review covered exact Prebid versions 11.11.0 (`0f6ba177203d5f63e0a11453ed0c887fcf5efe33`) and 11.34.0 (`195e0c6069928ed906bde550cb4e4183d1dc8474`). Other versions are explicitly unverified. Bidder aliases require checking their actual adapter mapping.

| Adapter | Source-reviewed route / limitation |
|---|---|
| ConnectAd | 11.11 copies content data into its v2 payload; 11.34 uses generic OpenRTB |
| OpenX, PubMatic | OpenRTB content data route; downstream taxonomy acceptance needs partner confirmation |
| Index Exchange | Copies `site.content`; top-level `site.cattax` is stripped, so this feature does not use that fallback |
| Rubicon / Magnite | Banner flattens taxonomy IDs into `tg_i.iab`, losing the version label; conflicting existing content taxonomies cause this contribution to be skipped |
| Smart AdServer / Equativ | Content data mapped to `sdc` |
| Criteo | OpenRTB translation retains content data |
| Adform (`adf`) | Site copying / generic OpenRTB, depending on version |
| RTB House, Eskimi, Ogury | Content data paths found in source |
| Teads, RichAudience | No reviewed `site.content.data` route; feature skips contribution on reviewed versions |

An adapter source path, configured mapping, RTD callback or HTTP parameter does not prove SSP acceptance, DSP use or increased CPM. Obtain a network-side request sample and confirmation of accepted taxonomy/version before enabling a partner in production. Do not send an IAB 3.0 ID labeled as 2.2 just to match an integration.

## TEST and review

1. Keep settings off and confirm the generated baseline continues to request ads.
2. Select 3.21.0 explicitly in isolated TEST configuration. Upload a reviewed custom Prebid build with the provider and existing modules.
3. Set `window.adsKeywords = {category: 'Books'}` before the generated script. Map a valid ID independently in each desired taxonomy. Enable GAM only on an eligible account with no other PPS writer; enable one confirmed bidder at a time.
4. Use Debug → Contextual signals / PPS, or `window.__AD_CONTEXT.snapshot()`. Inspect the category, exact taxonomy, IDs, provider observation and event reasons. The report states its evidence limit.
5. Inspect synthetic adapter payloads and verify `site.content.data` (or the adapter's transformation), preserving SChain and foreign first-party data. Test unknown category, missing module, denied/delayed consent, simultaneous auctions and later category changes.
6. Confirm partner receipt and version support separately. Measure any revenue change through a controlled comparison; this release does not add an A/B allocation platform.

Automated checks use synthetic demand and intercepted networks. Actual executed evidence belongs in the PR and test receipts; this document is not a claim that browser, hosted or production verification has passed.

## Primary references

- [Google GPT PPS config](https://developers.google.com/publisher-tag/reference#googletag.config.PublisherProvidedSignalsConfig)
- [Google PPS eligibility and limitations](https://support.google.com/admanager/answer/12451124)
- [Google PPS demand settings](https://support.google.com/admanager/answer/15287325)
- [Prebid first-party data](https://docs.prebid.org/features/firstPartyData.html)
- [Prebid RTD provider interface](https://docs.prebid.org/dev-docs/add-rtd-submodule.html)
- [IAB Taxonomies](https://github.com/InteractiveAdvertisingBureau/Taxonomies/tree/0fa1a8b3d7b6a94d245ee858d936dcfe021ca2c5)
