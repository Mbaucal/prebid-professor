# SChain and full request inspection (MBA-337)

In a site's **Debug Console**, choose **Ad unit scope** (one position or all)
and optionally **Bidder scope**, then search for `SChain`.

- **SChain position report** prints a readable request table and a SChain node
  table. Run it in the DevTools Console **top** context on the publisher page.
  An iframe (including a cross-origin ad frame) is reported as
  `wrong-console-context`: no hooks are installed and no request/SChain is
  checked. Missing Prebid in the top page is `prebid-unavailable`, with a rerun
  instruction. The inspector never reads or switches to a parent frame.

  Select one position above or enter an exact ad unit name/full GAM path in the
  card. The explicit entry overrides the selected position for this command.
  An optional bidder narrows selection. The latest matching retained auction
  is selected, preferring an exactly mapped supported HTTP call in that same
  auction; otherwise the report clearly says **Prebid input only**. Exact GPID,
  adserver adslot or current GPT path + slot element ID are supported. Ambiguous
  matches are reported without guessing. A chain in configuration is never
  substituted for a missing chain in the selected request.

  The table shows identifiers, sizes, endpoint/method, SChain presence, its exact
  field paths and basic SChain 1.0 checks. Every node is visible in a second
  table. Full chain JSON and the **complete selected original payload** are in
  collapsed groups. A request with several impressions remains an unchanged
  batch: filtering it would no longer be the original sent body. HTTP details
  retain method, URL, query, raw body and decoded body. Headers/browser-added
  transport fields are not recorded; use DevTools/HAR for those.

  `snapshot()` / `ready()` return the small summary. `details()` / `copy()` /
  `download()` include that summary and the one selected original request,
  without all historical requests. Before HTTP capture this is the retained
  Prebid input, explicitly labeled; unsupported values replaced during capture
  are disclosed. `copySummary()` copies a readable Markdown table with all
  node IDs and no full payload. `summaryText()` returns that table as text.
  The generated command uses `void` so the Console does not duplicate the
  report after printing the tables. Labels, helper and export filenames are
  neutral: `__AD_REQUEST_DEBUG`, `ad-request.json` (position mode),
  `ad-requests.json` (full mode). Previously copied commands are unchanged;
  copy a fresh command after refreshing the dashboard.

  Capture watches future OpenX/PubMatic calls and stops after the first exactly
  mapped call or five minutes. It never triggers an auction. No match, unavailable
  decoding or wrong context is not evidence of missing SChain. `basic-fields-pass`
  is only a check of the supported SChain fields, not validation of the entire
  request or the commercial chain. ads.txt, sellers.json, payment relationships
  and SSP acceptance are explicitly **not checked**; this does not mean missing.
  `complete=0` is disclosed; unsupported/conflicting chains cannot pass.
  Very large chain evidence requires the full snapshot.
- **SChain and full requests** copies a one-shot, read-only console command.
  Run it on the publisher page after Prebid loads. It shows recorded
  `bidRequested` inputs, per-position SChain paths and the original full batch.
  Requests without SChain remain visible. Prebid 9 `bids[].schain` and current
  `ortb2.source.schain` / `ortb2.source.ext.schain` are inspected separately from
  global and bidder configuration. Presence is not a schema/commercial-validity
  verdict, a final HTTP payload, or evidence of SSP acceptance.
- **SChain network capture** additionally observes subsequent page `fetch` and
  XHR calls for these exact endpoints:
  - `rtb.openx.net/openrtbb/prebidjs` (OpenX)
  - `hbopenbid.pubmatic.com/translator` (PubMatic)
  It prints each captured full batch locally. JSON, URL-encoded payloads and
  gzip byte/Blob payloads are decoded when supported. The original body remains
  available as text or base64. `imp.id = bidId` associates a captured request
  with a position/auction; unmapped or ambiguous batches stay separate from
  a selected position. Identical slot names across refreshes are not enough.

All three commands install the following **local** helper:

```js
__AD_REQUEST_DEBUG.print()       // print the current report
__AD_REQUEST_DEBUG.snapshot()    // summary in position mode
__AD_REQUEST_DEBUG.details()     // selected summary + complete original payload
await __AD_REQUEST_DEBUG.copySummary() // readable table in position mode
__AD_REQUEST_DEBUG.fullSnapshot() // full batches, including in short mode
await __AD_REQUEST_DEBUG.ready() // wait for currently pending decoding
await __AD_REQUEST_DEBUG.copy()  // JSON clipboard; returns JSON if unavailable
__AD_REQUEST_DEBUG.download()    // local JSON export
__AD_REQUEST_DEBUG.stop()        // remove this inspector's live hooks
```

Full requests can include identifiers and consent strings; review before
sharing. The inspector does not send reports anywhere, generate auctions,
refresh slots, set configuration/targeting, or call the CMP.

## Evidence boundaries

`filteredBids` contains the selected position; `originalRequest` is the complete
Prebid batch, including other positions if batched together. Network payloads
are also kept intact. The observation time is distinct from Prebid's recorded
`elapsedTime` and auction metadata. Configuration is sampled when the command
runs; later event payloads are the evidence for later requests.

Network capture covers **future calls only** to the listed endpoints, for up to
five minutes. It does not recover past POST bodies. Other endpoints, iframes,
workers, beacons and previously saved API references need browser DevTools/HAR.
Request streams and unsupported body types remain explicitly unavailable;
the inspector does not consume or clone a Request stream. A call observed by a
wrapper is not proof of delivery or downstream acceptance. Capture failure,
unavailable decoding and empty history are not treated as missing SChain.

The report discloses drops: at most 200 retained entries of each kind, a 512 KiB
per-body/snapshot limit, and an 8 MiB approximate retained-data budget with
reservations for concurrent decoding. Gzip expansion is bounded. Request
snapshots containing non-JSON values are explicitly marked incomplete. Starting
either command again stops the previous instance. Stop restores a patched API
only if that API is still owned by this inspector, preserving later tools.

## Verification

- `node --test tests/runtime/schain-inspect.test.mjs tests/runtime/experiment-inspect.test.mjs`
- `node scripts/prepare-schain-debug-fixture.mjs`
- `python scripts/verify-schain-debug.py` (Playwright 1.55.0 Chromium)
- `npm run typecheck` and `npm run build`, using the checked-in toolchain locks.

The browser check uses the real minified Debug component and intercepts every
request. It exercises downloaded/copied commands, one/all selection, complete
batch retention, local JSON exports, clipboard failure, option loading/retry,
desktop/mobile, same-origin and opaque iframes, neutral tables and full selected
payload exports, native fetch/XHR, unchanged gzip request bytes and cleanup.
Evidence is generated under `.generated/schain-debug-evidence/` and retained by
the existing site editor CI workflow. No paid traffic is generated.

This is a dashboard-only feature. Frozen runtime sources, saved packages,
publisher settings, GEO, consent enforcement and PPS are unchanged. Local/CI
proof is separate from TEST/production deployment verification.

References:
- https://docs.prebid.org/dev-docs/modules/schain.html
- https://docs.prebid.org/dev-docs/publisher-api-reference/getEvents.html
- https://github.com/InteractiveAdvertisingBureau/openrtb/blob/main/supplychainobject.md

Console context reference: https://developer.chrome.com/docs/devtools/console/reference#context
