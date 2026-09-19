# Tanjug full A/B bid cache — new delivery version

The accepted A/A package `tanjug-aa-1.0.2` is the control source. Marko confirmed
Variant A/B in GAM and a populated TC string in an actual OpenX `bidRequested`
event. That closes the reported CMP investigation; it does not establish what
caused the earlier differences in Funding Choices responses.

`tanjug-cache-1.0.1` is a new complete static Pages package with all 19 positions,
the same Prebid 11.34.0 bytes, existing CMP integration, minification, one runtime
per document and the public GAM key `Variant` (`A` or `B`).

- A retains the accepted fresh-auction code, changing only the release guard.
- B still starts a new auction. Native Prebid targeting can also select a valid
  unused bid from an earlier auction on the same page and owned slot.
- Cache age is capped at 60 seconds and at native bid TTL / buffer limits.
  Size, slot identity and consent epoch must still match. Submitted, rendered,
  expired and incompatible bids are excluded. Every submitted secondary/deal ID
  is tracked too; capacity exhaustion disables reuse rather than forgetting IDs.
- `fluid` and 1×1 remain in the layout. Fresh 1×1 bids can still be targeted;
  cached reuse is restricted to numeric banner dimensions greater than one.
- Targeting is checked at the actual GAM request, including lazy slots. GAM
  retains the final competition; a cached bid does not guarantee an impression.
- Refresh settings are identical to the accepted source. Cache-first and an
  adaptive shorter refresh are separate future versions (MBA-60 / MBA-63).
- Unknown CMP state or an additional unsupported GPP/USP API disables cached
  reuse; it does not fabricate consent. Native Prebid remains responsible for
  current auction consent. The geo/banner settings are not changed here.

`AdVariant.inspect()` reports the selected arm and its exact script hash.
For B, `AdBidCache.inspect()` reports fresh/cache/empty selections, rejected reuse
and current context status without exporting bid payloads or TC strings.

## Package storage in the main UI

The main `Generate and releases` panel now includes A/B packages for tanjug.rs.
The original reviewed ZIP can be saved and downloaded byte-for-byte. A new
authenticated same-origin API accepts only exact catalog hashes and sizes,
isolates keys by site, uses create-only writes, and verifies downloads again.
Existing normal releases, TEST releases and channel state are not repurposed.

This first integration is an archive shelf for reviewed complete pilot packages.
It does **not** yet generate arbitrary A/B pairs from two editor versions, offer
traffic settings, or dispatch the existing Cloudflare Publish workflow. The UI
explicitly says to upload the downloaded full ZIP in Pages. A/B direct Publish
must later consume the same pinned archive, preserve nested arm URLs and retain
rollback history; it cannot use the old flat two-script export contract.

## Reproduction and verification

After preparing the original pilot and AA/compact/CMP archives, run
`TZ=UTC node scripts/prepare-tanjug-cache-fixed.mjs`. The build refuses changed prior
archives and writes public assets from the exact ZIP. Private evidence stays
outside the ZIP. Run the full-cache package/policy and ab-packages Node tests,
the app build, then `python scripts/verify-tanjug-cache.py` with Playwright 1.55.
The browser suite uses exact native Prebid and packaged scripts, synthetic GPT,
TCF and bidder responses with external ad traffic blocked. It exercises a real
wrapper refresh selecting an unused cached bid as well as CMP startup, mixed
formats, duplicates, integrity/dependency failures and labels on all 19 slots.

These checks establish implementation behavior, not revenue uplift. When this
new ZIP is manually deployed, record the cutover time and compare only the new
test window in GAM: the earlier A/A impressions use the same Variant values.
No assistant deployment or GAM/CMP account changes are part of this work.

## Pre-release correction

The initial 1.0.0 candidate passed cache selection but the expanded browser check
found that a CMP-blocked native callback can happen without `auctionInit`. The
old lifecycle treated that callback as ready and blocked clean GAM fallback.
1.0.0 is withdrawn from the package shelf and is not a live release. Its bytes
and source are retained for evidence. New 1.0.1 recognizes the absent auction,
removes it from cache tracking, and submits the existing clean GAM fallback
once. Late callbacks cannot target or refresh again. Prebid consent remains
enabled. The B config also retains cache mode if initial setup is repeated.

1.0.1 ZIP SHA-256: `430c321a614a4894ee512366a85fc4ef23f7789aadb55888097f6251a079c80e`.
