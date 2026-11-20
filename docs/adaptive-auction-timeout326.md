# Local adaptive auction timeout (MBA-402)

Script **3.26.0 Preview** retains the complete 3.25.1 engine and adds an optional local timeout policy. Selection and enabling are separate explicit saves. The policy defaults OFF; no site is upgraded or published automatically.

The MAIN editor exposes it under **Config → Delivery → Refresh**. The isolated TEST workspace exposes the same card under **Unit rules**. The existing authenticated site-settings endpoint accepts `action: "auction-timeout"`, the displayed `revision` and `policy`; its snapshot CAS rejects concurrent edits. A conflict or unknown save result preserves the draft and requires an explicit reload. Older built-in versions and historical named-script generators reject an enabled policy.

The configured position timeout remains the auction base (the existing maximum for a batched auction). Enabled local rules add these configurable amounts and then clamp the selected `requestBids.timeout`:

| Setting | Default |
| --- | ---: |
| Minimum / maximum local timeout | 800 / 4000 ms |
| Mobile device | +200 ms |
| Slow available connection | +500 ms |
| Auction containing video | +300 ms |
| Each additional distinct position | +100 ms, capped at +500 ms |

The device uses available user-agent mobile data, otherwise the viewport breakpoint when available. Connection uses known effective type, otherwise positive downlink: 1.5 Mbps or less is slow. Unknown device, connection or format contributes zero and records a fallback reason; it does not invent a fast connection. Local min/max accepts 100–10000 ms; adjustments accept 0–5000 ms. OFF preserves the configured base without local clamping.

The local policy does not install `timeoutRtdProvider`, call a remote service or use storage. Upstream timeout RTD can modify the request after the wrapper supplied it; setting global `bidderTimeout` is not proof of that request’s effective value. This version sends the selected timeout in the actual request, then observes only the matching native `auctionInit.timeout`. Its auction watchdog starts there and follows the validated native value plus 500 ms. An external RTD override can therefore exceed the **local** bounds and is diagnosed explicitly. Native values must be finite and between 1 and 30000 ms; an invalid or absent value uses the local request value. Existing library and pre-auction readiness deadlines remain separate. CMP remains authoritative, including pending/unknown scope and revocation.

`window.__AD_AUCTION_TIMEOUT.snapshot()` returns up to 50 copied records with the configured base, chosen local value, actual native value, watchdog budget, position codes and context/reasons. The editor’s preview is an example, not a measurement of future visitors. No runtime timing or GAM labels claim higher revenue.

Verification uses local synthetic resources only:

- Independent helper and actual generated-readiness tests cover bounds, unknown signals, native extension/shortening, concurrent auctions, foreign/duplicate events, CMP/RTD order and exactly-once fallback.
- Native Prebid 11.11/11.34: 14 cases, 150 assertions, 28 auctions/dispatches; delayed responses after the obsolete deadline remain eligible. Demand/GPT are synthetic and request hooks model post-request/RTD changes; no claim that a remote provider was installed.
- MAIN/TEST editor browser checks cover desktop/mobile, explicit version selection, OFF, effective preview, loading, pending save, validation, real CAS conflict and committed-save response loss. MAIN uses the shared ConfigPanel and authenticated MAIN router; TEST uses its actual workspace. This is local proof, not hosted deployment.
- Complete MAIN and isolated TEST generation/read/save checks preserve previous stored package bytes; compiled production generation parity includes a 3.26.0 account/cache/TakeOver case with the policy explicitly enabled. Older runtime sources and release records remain unchanged.
- The measurement-loader 1.1.0 integration has a separate two-case native proof: cache OFF/ON saved arms retain their exact bytes, each refresh starts a new auction, and a failed B arm executes A while its memory ledger and GAM classification retain assigned B. The existing generic A/B CI job builds the pinned 11.34 source and runs this proof with the 3.26 runtime; no collector or publisher is activated.

TEST-first staging and any production promotion remain with the release coordinator. These checks do not activate a publisher, send paid ad traffic or measure revenue.
