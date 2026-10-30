# SChain and full request inspection (MBA-337)

In a site's **Debug Console**, choose **Ad unit scope** (one position or all)
and optionally **Bidder scope**, then search for `SChain`.

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

Both commands install the following **local** helper:

```js
__TESSERA_SCHAIN_DEBUG.print()       // table and complete current report
__TESSERA_SCHAIN_DEBUG.snapshot()    // report object
await __TESSERA_SCHAIN_DEBUG.ready() // wait for currently pending decoding
await __TESSERA_SCHAIN_DEBUG.copy()  // JSON clipboard; returns JSON if unavailable
__TESSERA_SCHAIN_DEBUG.download()    // local tessera-schain-debug.json
__TESSERA_SCHAIN_DEBUG.stop()        // remove this inspector's live hooks
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
desktop/mobile, native fetch/XHR, unchanged gzip request bytes and cleanup.
Evidence is generated under `.generated/schain-debug-evidence/` and retained by
the existing site editor CI workflow. No paid traffic is generated.

This is a dashboard-only feature. Frozen runtime sources, saved packages,
publisher settings, GEO, consent enforcement and PPS are unchanged. Local/CI
proof is separate from TEST/production deployment verification.

References:
- https://docs.prebid.org/dev-docs/modules/schain.html
- https://docs.prebid.org/dev-docs/publisher-api-reference/getEvents.html
