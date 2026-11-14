# Native contextual routing lab

This lab builds **unmodified Prebid core and SSP adapters** from exact commits, adding the unchanged canonical `contextualSignalsRtdProvider` module from runtime 3.21.0 and a synthetic `contextualAudit` RTD provider used only by this lab. It uses the runtime 3.21.1 `createContextualSignals` function, not a substitute. Every browser HTTP request is intercepted; SSP responses are synthetic HTTP 204. No live publisher, GAM or SSP traffic is sent.

The fixtures intentionally use synthetic category IDs, account IDs and EIDs. A passing result proves auction-local routing and the request serialization produced by these exact adapter versions. It does **not** prove IAB catalog membership, SSP receipt/acceptance, GAM eligibility, or revenue improvement.

## Run

Use Node 22.23.3 and Python 3.12 in CI, with Git and npm available:

```sh
node scripts/verify-contextual-prebid-build.mjs
python -m pip install playwright==1.55.0
python -m playwright install --with-deps chromium
python scripts/verify-contextual-prebid-wire.py
```

Both scripts accept `--version 11.11.0` or `--version 11.34.0` for a single version. The build script fetches pinned upstream commits, checks their lockfile SHA-256, installs with `npm ci --ignore-scripts`, and runs upstream `gulp build`. Existing checkouts must have the expected HEAD and no tracked modifications. It never changes a vendored production build or upstream adapter source.

The default output is `.generated/contextual-prebid`. `CONTEXTUAL_PREBID_ROOT` may select a separate output directory. During isolated worktree development, `CONTEXTUAL_RUNTIME_ROOT` may point to the repository with the canonical runtime sources. `CHROMIUM_PATH` optionally selects an installed Chromium binary; receipts record its version. The wire runner rejects changed sources/builds until rebuilt. CI should upload `*/manifest.json` and `*/wire-results.json`, not the upstream dependencies.

## Coverage and evidence

The real RTD hook, native `allowActivities` and `consentManagementTcf` modules and ConnectAd, OpenX, PubMatic, IX, Rubicon, Teads and RichAudience adapters execute. The cases cover taxonomy 6/7 serialization; a bidder route off; the whole feature off; no routes; absent/unmapped/cleared categories; an unowned auction; an auction ID mismatch; a throwing optional provider; overlapping auctions; no leakage into a subsequent unowned auction; Rubicon mixed-taxonomy protection; native activity redaction; and preservation of bidder-permitted user/EID data when that same data is denied to the RTD provider. A read probe through the actual RTD request Proxy confirms those protected fields are hidden from the provider and the configured denial rule runs; the subsequent real adapter request must still contain the bidder-permitted values.

RTD lifecycle cases also cover publisher-first, wrapper-first followed by a publisher write, combined first configuration before the helper exists, an empty first provider list, and repeated helper configuration. Assertions observe both providers actually running; they do not infer activation from `getConfig`. A second native build omits the contextual provider to prove the missing-module diagnostic while normal auctions continue.

Additional assertions check SChain preservation, existing global/bidder contextual data, no runtime writes to persistent bidder configuration, no contextual IDs under `user`, one callback per auction, and synchronous `waitForIt: false` configuration. Teads and RichAudience have no implemented contextual route in the inspected versions: their native requests still run, while the contextual contribution is deliberately omitted. Rubicon banner serializes category IDs as `tg_i.iab`, without a taxonomy identifier; the test verifies the IDs without pretending the wire retains `segtax`. ConnectAd 11.11.0 uses the v2 `sdc` route; 11.34.0 uses its v3 ORTB route.

The runner writes `passed: false` and `setupError` if Chromium cannot launch. A successful build alone is not a passing native wire test. This lab does not exercise the full publisher wrapper, native GPT PPS transmission, or CMP consent acquisition; those are separate integration gates.
