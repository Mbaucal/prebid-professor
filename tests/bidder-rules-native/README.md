# Native bidder eligibility lab

Run after the ordinary isolated runtime preparation:

```sh
node --experimental-strip-types tests/bidder-rules-native/prepare.mjs
python tests/bidder-rules-native/check.py --version 11.11.0
python tests/bidder-rules-native/check.py --version 11.34.0
```

The versioned runs reuse the pinned, hash-verified build manifests from `node scripts/verify-contextual-prebid-build.mjs`. The runner accepts `CONTEXTUAL_PREBID_ROOT` and `CHROMIUM_PATH`, like that existing lab. Without `--version`, it uses the repository's exact vendored Prebid 11.34.0 build; this also validates its SHA-256.

The actual generated `ads.js` and `ads.min.js` run in Chromium with native Prebid core, auctions, callbacks, Send All Bids targeting and bid caching enabled through the public API after initial wrapper configuration. The inherited wrapper defaults caching off; these cases explicitly exercise compatibility with a subsequent integration enabling it. Only the PubMatic/OpenX adapters, CMP, GEO and GPT are synthetic. Every HTTP request is intercepted; no publisher, paid demand, or production configuration is contacted.

The scenarios exercise country changes on a natural refresh, viewport changes on a natural refresh, explicit pending/unknown Allow/Skip behavior, all bidders skipped, and the feature disabled. High-CPM cached PubMatic bids must never displace the eligible OpenX winner after the rule excludes PubMatic. Original SChain values must survive into native bidder input. Both code variants must preserve consent-gated GAM fallback and the enabled native cache setting.

Receipts are written to `.generated/bidder-rules-native/browser-results-<version>.json`. A failed browser launch writes `passed: false` and `setupError`; fixture preparation alone is not a passing native test. This lab proves local runtime/native-core integration, not unchanged SSP wire serialization, SSP acceptance, a real CMP decision, real GPT transmission or revenue improvement. Separate contextual-adapter tests cover actual adapter serialization.
