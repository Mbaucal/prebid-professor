# MBA-430 controlled retention profile

This is an isolated lab investigation for [MBA-430](https://linear.app/mbaucal/issue/MBA-430). It does not change serving code, publisher settings, saved packages, refresh policy, consent, or `suppressExpiredRender`. MAIN runtime 3.25.1 remains frozen at source SHA-256 `e92b88fcb1ea6e48b1e7f4c92a6b78543e3682f6348833cfdefa072c593527c7`.

## Reproduction

Use the checked-in lockfile and the existing pinned native build tool. The native build manifests pin upstream commit and lockfile hashes. Reusing matching builds is sufficient; the fixture preparer checks their bytes and manifests before producing packages.

```sh
node scripts/bootstrap-toolchain.mjs
node scripts/isolated-toolchain.mjs prepare
RUNTIME324_PREBID_ROOT=/tmp/retention430-prebid node scripts/build-runtime324-prebid.mjs --version 11.11.0
RUNTIME324_PREBID_ROOT=/tmp/retention430-prebid node scripts/build-runtime324-prebid.mjs --version 11.34.0
node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs \
  scripts/prepare-retention430-fixtures.mjs --native-root /tmp/retention430-prebid
python -m pip install playwright==1.55.0
python -m playwright install chromium
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/runtime -p 'test_retention430_metrics.py'
PYTHONDONTWRITEBYTECODE=1 python scripts/profile-retention430.py .generated/retention430-fixtures \
  --out .generated/retention430-profile --measurement-context 'Describe the coordinated host window here'
```

Use a dedicated Python environment and Chromium 140.0.7339.16. On a shared host, coordinate a window with no other builds or browser proofs before interpreting CPU. `--quick` checks one short OFF/ON pair and is not long-page evidence. `--phase late` runs only render/buffer probes. Raw `.heapsnapshot`, `.cpuprofile`, per-case JSON and full `summary.json` remain in ignored `.generated`; the committed compact receipt identifies their hashes and observed results. Do not edit the four harness inputs while a measurement is running: the runner rejects a changed hash.

Large raw render-document snapshots can exceed a small workspace disk. In a separate terminal, start the completed-case retention helper before the full run (it tolerates a directory not yet created):

```sh
PYTHONDONTWRITEBYTECODE=1 python scripts/retain-retention430-artifacts.py .generated/retention430-profile --watch
```

The helper validates saved successful per-case metrics, hashes each finished heap, keeps representative default/bounded OFF and steady bounded ON heaps, then deletes only that case's redundant raw heaps. It never authorizes deletion from an incomplete JSON file or an active snapshot. All compact metrics and CPU profiles remain. `artifact-retention.json` records hashes, sizes, preserved/deleted status and helper hash. Hash/deletion I/O can overlap profiling, so CPU remains descriptive; this is not a precision CPU comparison. The four profiling/serving inputs stay sealed. After completion:

```sh
PYTHONDONTWRITEBYTECODE=1 python scripts/summarize-retention430.py \
  .generated/retention430-profile/summary.json docs/evidence/retention430-controlled-20261120.json
```

The summarizer requires the full two-version matrix, validates all cache pairs again, checks per-case JSON against the full report, and accepts a missing redundant raw heap only with a matching extraction/hash receipt. Representative heaps remain required.

## Experimental boundaries

- Both native versions use the same synthetic adapters, viewport, two visible banner slots, auctions, bidder responses, 120-second bidder TTL and 8-second native render delay. Network routing blocks every unlisted request. Neither real GPT nor paid demand is loaded. Consent is explicitly non-GDPR in this synthetic page; this is not a CMP policy test.
- Cache OFF and ON packages differ only in the saved bid-cache setting. The preparer compares the rest of the snapshot exactly. Every pair must have equal per-slot GAM counts, bidder wire counts, native response/event counters and successful renders. Each primary bid belongs to its slot, and no previously submitted primary or send-all-bids ID may be resent.
- Counts have distinct denominators: `gam` counts logical slot refreshes in mock GPT, not real GAM HTTP requests; `bidder` counts native `bidRequested` events, which can group both slots; `wireByCode` counts the ad-unit entries submitted through intercepted synthetic bidder HTTP payloads. Pair equality checks all three, without treating grouped requests as extra opportunities.
- Demand repeats four auction prices: the leading bidder returns `[10,4]`, then `1`, then `2`, then `12`; a second bidder returns `0.5`. The expected primary sequence is `10,1,2,12` with cache OFF and `10,4,2,12` with cache ON. Thus ON must exercise actual eligible cached competition while still making fresh bidder requests.
- The long-page arm raises only this synthetic fixture's refresh cap to 150 and observes 120 opportunities per slot (about 60 virtual minutes). The unchanged-cap control stops after the initial request plus 20 refreshes, then remains open for the same virtual duration. An idle document runs the same loader without slot containers. These controls distinguish ordinary capped operation and browser/loader warmup from sustained native retention.
- The main active contexts have 20 warmup opportunities; the idle control waits the corresponding virtual duration with zero auctions. Its `opportunities` field represents virtual interval count, not dispatched ads. The runner drains primitive-only observation queues before GC, collects post-GC heap/DOM samples, and takes detailed heap snapshots after warmup and at the end. Bid IDs and historical rows are retained in the external Python process, not a growing browser-side observer. Old synthetic render frames are removed from the current slot. Native event history may still retain their document references; that is part of the object lifetime being measured.
- A further bounded OFF/ON pair per version measures 150 opportunities with detailed snapshots at opportunities 120 and 150. Wrapper occupancy is checked at both snapshots: this demand reaches the 64-auction cap and a steady 288 tracked bids, below the separate 512-bid cap. The 512-bid cap is not exercised by this workload. This separates filling the observed bounded history from subsequent native/page growth; it does not assume that bounded bid/event arrays bound all native closures or browser objects.
- `heapAfterGC.usedSize` is the whole synthetic page, not exclusive Prebid memory or a production budget. The heap parser reports node counts and bid-shaped objects with own `adId`, `adUnitCode`, `auctionId`, `responseTimestamp` and `ttl` properties. Shape counts and `self_size` do not prove package ownership or total retained bytes. Native bid-pool/event counts and DOM counters provide separate evidence.
- Creative markup is deliberately small and repeated. Real creative payload diversity, external iframe resources and full publisher/CMP memory are absent, so byte totals are not a production capacity estimate.
- CPU is sampled exclusive frame time grouped by native Prebid, frozen wrapper, fixture, GC, idle and unattributed frames. CDP script/task durations and sampling include instrumentation and synthetic-clock work. Two repetitions with alternate OFF/ON order are descriptive; they are not a statistical production latency or revenue result.

## Native retention and late render contract

The pinned sources are primary evidence: [11.11.0 bidTTL.ts](https://github.com/prebid/Prebid.js/blob/0f6ba177203d5f63e0a11453ed0c887fcf5efe33/src/bidTTL.ts), [11.34.0 bidTTL.ts](https://github.com/prebid/Prebid.js/blob/195e0c6069928ed906bde550cb4e4183d1dc8474/src/bidTTL.ts), [event history](https://github.com/prebid/Prebid.js/blob/195e0c6069928ed906bde550cb4e4183d1dc8474/src/events.ts), [TTL collection](https://github.com/prebid/Prebid.js/blob/195e0c6069928ed906bde550cb4e4183d1dc8474/src/utils/ttlCollection.ts), and [rendering](https://github.com/prebid/Prebid.js/blob/195e0c6069928ed906bde550cb4e4183d1dc8474/src/adRendering.ts).

Native bid retention uses `max(configured minimum, original bid.ttl)` from the response timestamp; zero therefore preserves the original TTL instead of shortening it. Targeted-bid minimum can override the general minimum. Collection timers permit up to five seconds of cleanup slack. That slack is not extra SSP validity. Both versions default to lifetime bid/event history when these settings are absent.

`ttlBuffer` defaults internally to one second even when `getConfig('ttlBuffer')` is unset. The separate explicit 10-second-buffer probes preserve the original bid TTL. A 40-second bid is excluded from cached targeting at the first 30-second-dwell refresh; the probe requires its actual age to be at least 30 but less than 40 seconds, so original SSP expiry cannot explain the exclusion. Loader setup adds an initial offset before the first dwell. The fresh bid wins. For a 120-second bid, default native `renderAd` (without `legacyRender:true`) still renders at 108 seconds. At 115 seconds it emits `expiredRender` because `120-10=110`, even though original SSP TTL has not yet elapsed. Default rendering continues; explicit `suppressExpiredRender:true` blocks it. At 130 seconds the default lifetime pool can still render an expired creative, whereas a bounded pool may no longer find it. None of these outcomes establish paid attribution or authorize extending SSP TTL.

The event-only, bid-only and combined arms test `eventHistoryTTL:120`, `minBidCacheTTL:0` plus `minTargetedBidCacheTTL:0`, and all three together. These values are **evidence candidates**, not a production policy. A 120-second event window matches four refresh intervals and the measured bidder lifetime; real analytics lookback requirements and longer production TTL distributions remain unmeasured. A future explicit runtime and a controlled pilot must establish acceptable analytics loss, valid late-render behavior and partner accounting before choosing values. This work does not enable either bounded retention or suppressed expired rendering.

The previous 19 November 14–103 MB synthetic figures combined browser/framework warmup, unusually large CMP grant data and native retention without an OFF arm. They are not a production regression or a usable memory budget. This fixture replaces the large grants with a minimal explicit synthetic consent response and adds OFF, idle, capped and decomposition controls. Results from the two harnesses must not be compared as a production before/after claim.

## Attribution remains limited

Independent read-only review found three concrete mechanisms to distinguish before attributing whole-page growth:

1. The fixture removes the previous outer render iframe and creates/open-writes/closes a new document for each real native `renderAd` call. `page.add_init_script` installs the fixture in child frames too; there is no top-frame guard. This does not accumulate observer result rows, but it does add synthetic state to every render realm.
2. Pinned Playwright 1.55's server clock implementation adds an init script for each `runFor` and evaluates clock commands in all frames. Equal virtual document duration in idle/cap controls does not equal the long loop's number of clock commands. These controls therefore do not isolate opportunity-correlated clock/frame instrumentation.
3. Native `adRenderSucceeded` payloads contain strong `doc` and `bid` references, and event history stores the payload. Event TTL can remove that anchor. Independently, both pinned native versions' display renderer calls `registerReportingObserver` on each render. Where `ReportingObserver` is supported, the observer is registered on the persistent renderer iframe window, its callback captures `sendMessage`, and no disconnect appears in that path. The callback chain through `adRendering`'s message handler/resize function can reference the original render document. This is a strong static retention candidate outside the bid pool/event collection, not a confirmed heap dominator or a production leak diagnosis.

The corresponding primary sources are [display renderer](https://github.com/prebid/Prebid.js/blob/195e0c6069928ed906bde550cb4e4183d1dc8474/creative/renderers/display/renderer.js), [reporting observer](https://github.com/prebid/Prebid.js/blob/195e0c6069928ed906bde550cb4e4183d1dc8474/creative/reporting.js), [persistent renderer cache](https://github.com/prebid/Prebid.js/blob/195e0c6069928ed906bde550cb4e4183d1dc8474/src/creativeRenderers.js), and the pinned `src/adRendering.ts` linked above. Read-only inspection found the same observer chain at commit `0f6ba177203d5f63e0a11453ed0c887fcf5efe33` for 11.11.0.

The sealed matrix is not altered to remove these mechanisms after seeing the result. The matrix alone does not identify a heap dominator or establish that retention settings fix the remaining page heap. Retention-array counts and valid late-render outcomes remain direct observations; whole-page heap and CPU evidence has the limits above.

After the window, independent QA ran one separate [ReportingObserver availability control](retention430-observer-qa.md), commit `0a767901c67ee36d84a5428e79176fe5bb9b81af`. On 11.34 only, both bounded/cache-ON branches had 40 native renders, matching demand and exactly 237 clock commands. QA verified original API availability and actual deletion inside the persistent renderer realm, not merely the top page. Document counts at opportunities 1/5/10/20 were `7/15/25/45` with the API available and `7/13/15/15` when disabled; final post-GC page heaps were 24,007,608 and 11,915,772 bytes. The separate full receipt SHA-256 is `87bc9b91f401be8318e7c590f4b50bcec8d0356b15977dc77567ea3e6f8b8893`.

That control isolates an availability-only retention effect in this synthetic path while matching clock commands; it is not part of the sealed 30-profile matrix, a production impact estimate, or authorization to disable ReportingObserver globally. The source chain matches 11.11, but that version was not causally probed. Full production/retainer coverage and an appropriate native-renderer remedy remain unproven.

## Results

The complete matrix passed on 20 November 2026, 16:42:45–17:06:49 UTC: **30 profiles, 12 matched OFF/ON pairs and 20 buffer/late-render cases**, with unchanged input hashes. Playwright 1.55.0 / Chromium 140.0.7339.16 ran in a root-coordinated window without other local builds or browsers. Completed-case artifact hash/deletion I/O began during the window and is recorded as a CPU interpretation limit.

The committed [compact receipt](evidence/retention430-controlled-20261120.json) contains source/build hashes, every sampled native counter, heap/DOM/object summary, CPU groups, pair validation and raw artifact hashes. The raw local full summary SHA-256 is recorded there. The artifact helper hashed all 60 detailed heaps, preserved 12 representative heaps and removed 48 redundant completed heaps after metrics extraction. All 30 case JSONs and CPU profiles remain. Free disk was approximately 4.8GB at completion.

Each main long-page case produced **240 logical slot refreshes, 242 native bidder-request events, 480 bidder/ad-unit wire entries, 540 native bid responses and 240 successful native renders**. All pairs had identical denominators and no duplicate slot dispatches, bidder/ad-unit rounds or reuse of any previously submitted targeting ID. Cache OFF followed `10,1,2,12`; ON followed `10,4,2,12` while still sending the same fresh demand.

| Native version | Test-only policy | Final bid pool per slot | Native events | Final whole-page heap after GC (MiB, four main runs) | Exclusive native-frame sampled time (seconds) |
| --- | --- | ---: | ---: | ---: | ---: |
| 11.11.0 | Default lifetime retention | 270 | 3,431 | 105.09–105.37 | 3.39–5.36 |
| 11.11.0 | Bid minima 0/0, events 120s | 9 | 118 | 102.82–103.17 | 0.87–1.09 |
| 11.34.0 | Default lifetime retention | 270 | 3,431 | 105.46–105.73 | 2.41–3.73 |
| 11.34.0 | Bid minima 0/0, events 120s | 9 | 118 | 100.98–102.62 | 0.75–0.97 |

CPU ranges cover OFF/ON and both repetitions during the last 100 opportunities per slot (200 logical slot refreshes). They describe this instrumented workload, with substantial GC/unattributed/idle samples and artifact I/O; they are not total native retained size, production CPU budgets, latency improvements or revenue uplift.

The decomposition controls agree across versions: event-only retention leaves the pool at 270/slot but reduces events to 118; bid-only retention reduces the pool to 9/slot but leaves 3,431 events. Neither makes the whole-page heap small. At 120 opportunities, both default and bounded cases have 245 document objects; the bounded cases still contain 620 bid-shaped objects with OFF and 770 with ON. The shape counter includes copies/other objects and is not an exact retained-bid count.

The idle loader ends near 2.13–2.14MiB with zero auctions and two documents. The unchanged 20-refresh cap ends at 42 slot refreshes, 48 pooled bids/slot, 614 events, 47 documents and approximately 24.0–24.16MiB; it sends no additional demand during the remaining virtual session. These controls have the clock-command limitation above.

The final bounded steady controls are decisive about the limit of the proposal: from opportunities 120 to 150, native pool/event counts stay at 9/slot and 118, and wrapper ON occupancy stays at 64 auctions / 288 bids. Nevertheless, document count rises 245→305 and post-GC page heap grows another **24.1–24.5MiB**. Bid-shaped objects grow 620→680 with OFF and 770→830 with ON. Therefore this candidate bounds the measured collections but **does not bound whole-page retention** in the current harness/native-render path.

All 20 late/buffer cases pass with the outcomes described above. The buffer-selection probe records the rejected cached bid at 36.2 seconds old: beyond native buffered TTL30, inside original SSP TTL40. Valid default native render at 108 seconds and the default continuation at 115 seconds are preserved by the bounded candidate. Suppression and original-expiry outcomes remain separate from retention safety.

`minBidCacheTTL:0` / `minTargetedBidCacheTTL:0` is a reasonable collection-retention hypothesis because it preserves at least each bid's original TTL and removes expired history in both versions. `eventHistoryTTL:120` is a measured bounded-window hypothesis, not a validated analytics requirement. The data does not justify enabling these settings as a complete memory fix, enabling expired-render suppression, increasing refresh caps, or changing production defaults. The separate causal control adds evidence of a render-document anchor; full retainer coverage, analytics requirements and an explicit new-runtime pilot remain outstanding.

## CI proposal

Run the six pure metric/artifact-safety checks and one `--quick --versions 11.34.0` OFF/ON pair using the already-built pinned native artifact in `site-editor-checks.yml`'s `bid-cache-prebid` job. This checks fixture/native integration and exercised cache competition with eight opportunities per slot. The current fixture preparer deliberately requires both native versions for this complete experiment; before wiring that CI step, add a reviewed single-version fixture entry/filter rather than rebuilding the other version inside each existing matrix job. This is a proposal; no workflow is changed here. Quick mode does not claim long-page memory coverage. Keep the complete 30-profile experiment a deliberate manual investigation with a disk/host budget; do not add it to every PR or weaken existing runtime/consent/dispatch checks.
