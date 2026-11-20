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

Natural CI causality remains unconfirmed. MBA-432 stays In Progress until a
real failure receipt or a faithful reproduction distinguishes observation,
timing and serving behavior. No retry of the failed MAIN workflow was used.
No live Google/GAM requests, paid traffic or publisher activation were used.
