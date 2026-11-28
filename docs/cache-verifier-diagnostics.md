# Cache verifier failure evidence (MBA-432)

The legacy per-position browser check failed after two different MAIN merges:
`ab936c3` / run `44544139563` and `513a1b11` / run `44576583624`.
Both failures were `StopIteration` while looking up an intermediate slot/round
in the `S / 390 / normal` case. Their artifacts contained release manifests,
but no failed request or auction chronology. The recorded positions and
default-off manifests match the passing PR223 artifacts. They describe the
frozen 3.9.1 preview base and native Prebid 11.34.0; `hb_ver=1.17.2` is the
legacy PUC version, not the Prebid or Tessera runtime version.

There is no confirmed production serving cause or measured revenue impact.
This change is CI observation and failure reporting. It does not change a
frozen script, Prebid build, demand payload, cache policy, refresh, consent,
publisher configuration, or ad delivery.

## Failure contract

The existing CPM, fresh/cache, own-slot targeting, unique auction, empty-bid,
Variant, consent and dependency checks remain unchanged. All 37 original
`check(...)` call ASTs are identical. The existing 45-second wait is unchanged.
An exact round lookup now rejects both missing and duplicate observations
with the slot, round, scenario and observed round numbers. It never replaces
an absent round with a later request, picks an ambiguous first match or skips
an intermediate requirement.

A failed scenario writes
`browser-failure-{arm}-{width}-{case}.json` beside the package's `release.json`
before the browser context closes. This contains:

- the original error and scenario, completed checks and the last wait/deadline;
- all synthetic GAM observations, adapter request IDs/rounds and native events;
- optional native callback auction context and immutable callback/adapter logs;
- Variant/cache snapshots, page errors and actual SHA256/byte counts for all
  declared package files, separately from their recorded manifest descriptors.

The existing always-upload artifact paths collect these JSON files. A failure
is still a failing CI result. Errors while gathering extra evidence are
printed separately and do not replace the original failure.

The callback observer forwards the native request and callback receiver,
arguments, return and exception unchanged, preserves native hook properties,
and restores nested context in `finally`. It does not start an extra auction.
Context is valid only during synchronous callback execution. A legitimate
outer fallback can have no callback context. Adapter auction IDs can differ
from public native IDs; correlate adapter `requestId` with native
`bidRequested.bids[].bidId` when analyzing the public auction. These diagnostic
fields do not replace the existing round or latest-auction assertions.

## Executed evidence and limits

- Exact copied positions package: 53/53 browser checks pass; default-off:
  49/49 pass with native Prebid and intercepted synthetic demand.
- Pure diagnostic helpers: 12/12 Python unit tests pass, including strict
  missing/duplicate rejection and independently copied snapshots.
- Transparent observation: 20/20 Node VM tests pass, including strict primitive receivers, callback
  nesting/errors, hook metadata, original CPM sequences and unknown fallback
  context. Independent mutation probes catch all introduced regressions.
- A temporary controlled negative lookup removes Billboard round 2 from the
  assertion input. It fails explicitly and writes the full receipt: 21 GAM
  observations, 46 adapter observations, 18 callbacks, 223 native events and
  all eight actual file hashes. The original dispatch data is retained in the
  receipt; this is a deliberate observation fault, not a real ad failure.
- Independent causal mobile probe: 26/26 pass. Holding the first Billboard
  callback for 3.5 seconds also passes 26/26, with a legitimate initial fallback
  outside callback context. A deliberately injected distinct native auction
  reproduces missing dispatch observations, so renumbering by GAM request
  ordinal would conceal that failure rather than prove a recorder-only fix.

At that stage, natural CI causality remained unconfirmed. The following
investigation used the new failure receipt rather than retrying that failure.

## Native timing collision found on 2026-11-28

Run `46087897687`, job `140801693800`, failed at `S / 1280 / normal` on
`5ed23d47619983ef5e347ba8c9de4bcce493a192`. The receipt contains actual
Billboard requests for rounds 1, 2, 3 and 5. Round 4 completed its native
auction with a valid bid and callback, but did not reach the synthetic GAM
dispatcher. The same gap affected Billboard_2 and Billboard_3; Sticky kept
all its rounds.

The fixture had set auctions to start every 2 seconds. The frozen runtime's
non-Sticky GPT wrapper rejects another submission within 1500 ms. A slow
round 3 followed by a fast round 4 compressed the actual submission gap to
1367 ms. Counting an attempted cache submission does not prove GPT dispatched
it. This is a real gate collision in the accelerated synthetic fixture, not a
reason to replace an absent observation or relax the round assertion.

All eight generated files from the failed artifact match a package generated
at base `4fb4160abd0ccfc02bbbc8c998d64ddddb154cb3`. With those identical
bytes, delaying one round 3 synthetic RPC by 700 ms and allowing round 4 to
respond immediately reproduces the missing round 4. Applying the same delay
to subsequent rounds keeps callback spacing even and passes the unchanged
single-scenario verifier. This comparison does not establish that every
older failure had this cause or that production revenue was affected.

The per-position fixture now uses 4 seconds, derived explicitly from the
1500 ms GPT guard + the longest 1500 ms auction timeout + its 500 ms callback
failsafe + a 500 ms scheduling margin. Both default-on and default-off
profiles use this bound. No production setting, frozen source, old ZIP or
runtime registry entry changes. The existing 45-second wait, exact round
lookup and all CPM/cache/native-auction assertions remain unchanged.

`verify-position-cache-latency.py` runs the original verifier with a wrapper
around only its synthetic bidder RPC. It adds one 700 ms round 3 delay per
browser context, below the frozen ATF auction timeout, then delegates to the
original callback. It does not change a packaged script, request lookup or
deadline. A successful run writes `browser-latency-report.json` beside the
manifest, with the checks, exercised delays and verified file hashes.

The existing A/B editor CI keeps the original normal runs for both profiles
and adds one delayed positions run. Its offline regressions also preserve the
old 2-second missing-round trace and check the new interval against the full
callback bound:

```sh
node --test tests/runtime/position-cache-fixture-timing.test.mjs
python -m unittest discover -s tests/runtime -p 'test_position_cache_latency.py'
TANJUG_PACKAGE_DIR=.generated/script-library-delivered/positions/deploy python scripts/verify-position-cache-latency.py
```

Local verification of the compiled Worker/downloaded package passed 69 service
and package contracts. The new 4-second profiles passed the original verifier
at both 1280 and 390 px: 53 checks with default cache on, 49 with default off,
and 53 with the controlled round 3 delay. Related Node suites passed 42 tests;
Python diagnostics passed 12 and the new wrapper helper passed 2. These are
local results; the integrated branch still requires its fresh CI run.

All browser traffic in this investigation uses native shipped Prebid with
intercepted synthetic demand and local GPT/TCF. No live Google/GAM requests,
paid traffic or publisher activation were used.
