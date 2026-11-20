# ReportingObserver fixture probe

This helper isolates one candidate retention path in the existing sealed MBA-430
native display-render fixture. It does not change Prebid, frozen runtime 3.25.1,
the prepared packages, the owner harness, publisher settings or paid traffic.

Only run after the coordinator clears the active shared quiet window. Preparation
alone is not a measured result. The following command runs one pinned 11.34 pair,
20 native opportunities/40 renders per branch, bounded 0/0/120 and cache ON:

```sh
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/gam-ui-ci-browsers \
FONTCONFIG_FILE=/tmp/cache422-fontconfig.conf \
/workspace/work/gam-ui-ci-venv/bin/python scripts/profile-retention430-observer.py \
  /workspace/work/mba430-controlled-retention/.generated/retention430-fixtures \
  --harness-root /workspace/work/mba430-controlled-retention \
  --out .generated/retention430-observer-pair
```

The helper imports the existing runner's local routing, synthetic demand, native
refresh advancement and scalar observation collector. The available branch leaves
`ReportingObserver` untouched. The disabled branch deletes that API in every
context-created realm before scripts run, including the cached native renderer
iframe. Both branches store only boolean availability metadata. Current main,
renderer and creative realms must confirm the original API existed and the
requested availability remains in force.

Both branches drain the same 1.05 s fixture visibility timer after every native render
opportunity. All `clock.run_for` commands are recorded outside the browser. Exact
command sequence, native counters, demand rounds, CPM sequence, applied policy and
virtual duration must match; otherwise the receipt is explicitly unmatched and
cannot support a causal interpretation. A failed branch stops the pair without
retry. Post-GC heap usage and DOM counters are sampled at opportunities 1, 5, 10, 20;
the 5-opportunity warmup crosses the original 120 s bid TTL. Native pool/event counts
are retained as observations. No observer, document or window references are kept
by the probe, and no raw heap snapshots or CPU profiles are taken.

`summary.json` and per-branch JSON retain failures, source/package hashes, current
realm checks, scalar measurements and exact clock steps. Source hashes are checked
again at completion. A matched memory reduction would identify an effect within
this synthetic fixture. It would not by itself establish production impact, a
production memory budget, full retained-size ownership or a safe production fix.
An unchanged result remains useful evidence. One pair is not a replicated study.

## Recorded bounded result

On 2026-11-20, after the coordinator released the main matrix quiet window, the
command above completed its single pair on pinned Chromium 140.0.7339.16 and
Playwright 1.55.0. Both branches passed. All sealed inputs remained unchanged.
No further browser runs were performed for this diagnostic.

| Post-GC measurement | Observer available | Observer disabled |
| --- | ---: | ---: |
| Documents at opportunity 1 | 7 | 7 |
| Documents at opportunity 5 | 15 | 13 |
| Documents at opportunity 10 | 25 | 15 |
| Documents at opportunity 20 | 45 | 15 |
| Final used heap bytes | 24,007,608 | 11,915,772 |
| Used heap growth after opportunity 5 | 14,297,380 | 3,020,304 |
| Final native pool, per slot | 9 | 9 |
| Final retained native events | 118 | 118 |

The exact 237 `run_for` commands and 576,200 ms elapsed virtual duration matched,
as did the applied settings, CPM sequence, four per-bidder/slot demand rounds and
native counters: 40 GAM requests, 40 actual renders, 21 auctions, 42 bidder events and
90 responses. Both branches had zero render failures, expired renders, browser
errors or escaped network requests. At each sampled point all seven current
realms reported the expected API state. In particular, the persistent
`about:srcdoc` realm with native `window.render` confirmed the API originally
existed and remained available in control; the disabled branch confirmed
`deleteSucceeded=true` and `availableNow=false` there.

This result identifies a causal effect of observer availability on document and
heap growth within this fixture. It does not identify an exclusive retained-byte
owner, establish publisher impact or authorize disabling browser reporting in
production. No production fix was implemented.

Receipts remain under `.generated/retention430-observer-pair/` in the QA worktree:

| Receipt | SHA256 |
| --- | --- |
| summary.json | `87bc9b91f401be8318e7c590f4b50bcec8d0356b15977dc77567ea3e6f8b8893` |
| observer-available.json | `83f06b85072fdf807123ab185961e30282dbfb1a4d1d9d866ccbb4b78825f641` |
| observer-disabled.json | `0a7f0026ee0b73aa534003740f56c4860b50f672933e95869a43e99164d265e3` |
| Existing fixture manifest | `2a9074635e4d5b56596234324333aacd163cbca4170465618b1c8072c3fe46c0` |

The manifest pins native 11.34 `prebid.js` SHA256
`5fe83e3e306040e4f33c7f6ce43f95a0d243772af7b60be6383043c6489a20d6`
and the selected frozen-runtime package `ads.min.js` SHA256
`9ae459f6edb451207ca39bd54b9335886ff55670bc38e0437ce8b3ca9cba181f`.
