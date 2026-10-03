# Native Prebid CMP recovery experiment — 3 October 2026

**Result: not ready for a runtime version.** The isolated browser suite passes
11 of 14 scenarios and exposes three native consent lifecycle blockers. The
wrapper's recovered readiness alone does not guarantee native Prebid has adopted
the same CMP decision. No production runtime, registry, release or publisher
configuration was changed.

## Exact experiment

- Base experiment: `7fcd3d8`; guarded adapter `01cc639` plus real-window timer
  binding fix `2ab7767`. Both are test-support changes only.
- Frozen `worker/runtime-readiness-v1/browser-readiness.mjs`, loaded unchanged.
- Original vendored Prebid 11.34.0, SHA-256
  `384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b`.
- Playwright 1.55.0; Chromium 140.0.7339.16 (build 1187), headless.
- Native TCF consent module, auction, enforcement and targeting code execute.
  The existing synthetic adapter fixture supplies intercepted demand, with
  matching vendor IDs; CMP and GPT dispatch are simulated. This is not stock
  bidder request serialization or real GPT/network privacy verification.
  The fixture records a simple simulated `rawDispatch`; it does not execute
  `createGamReporting` or its downstream `slot.setConfig` → GPT refresh handoff.
- Accept/Reject use distinct synthetic TCF v2 core strings and matching maps.
  Reports classify those strings as accept/reject/absent rather than exporting
  them. All page requests are intercepted; unexpected destinations abort and
  fail the case. No real ad traffic was sent.

The initial native configuration is deferred until wrapper readiness, matching
3.14's configure-once lifecycle. Exploratory `native-reconfigure*` cases explicitly
reapply IAB configuration; this is a test operation, not a proposed fix.

## Observed matrix

| Scenario | Result | Observation |
| --- | --- | --- |
| Silent CMP | Pass | No native bidder request or GPT dispatch during 1.8 s observation |
| Same API, delayed Accept | Pass | One native accepted request and one dispatch |
| Same API, delayed Reject | Pass | No bidder request; one clean dispatch |
| Non-forwarding stub replaced with Accept | Pass | Native starts from new API; one accepted request/dispatch |
| Stub replaced with Reject | Pass | No bidder request; one clean dispatch |
| Stub replaced with explicit `gdprApplies:false` | Pass | Native request carries false and no TC string; one dispatch |
| Immediate replacement before request | Pass | No dispatch while new CMP has no decision; Reject then clean dispatch |
| Replacement after work queued | Pass | Same suppression and single-dispatch result |
| Late response from old native auction | Pass | Replacement invalidates epoch; late response adds no bidder targeting |
| Same API, prior Accept then Reject | Pass | Native honors updated Reject; no second bidder request |
| New API Reject after prior native Accept | **Fail** | Native second request still carries Accept; bidder targeting reaches epoch 3 dispatch |
| Old API callback after new API Reject | **Fail** | Same stale native Accept and targeting; facade rejects old callback independently |
| Reapply IAB config after replacement Reject | Pass | Native adopts current Reject for the next auction |
| Old callback after that reconfiguration | **Fail** | Old native listener restores Accept; second accepted request and targeting |

In each failure the old API retained one native listener after the facade removed
its own listener. The new API had one facade listener, or two listeners after
native reconfiguration. Reconfiguration did not detach the original native
listener. The two stale-callback cases also incremented the facade's discarded
callback count: ignoring the callback in the facade did not stop native Prebid
from receiving it through its own subscription.

The browser suite first exposed an additional host-binding defect: inheriting
`window.clearTimeout` through the facade caused `Illegal invocation`, recorded as
`prebid-config-error`. Fix `2ab7767` binds it to the real host. Assertions now
require actual dispatch and native request evidence, not just `ready:true`.

## Reproduce and retained evidence

Install the checked-in dependencies with `npm ci`, then provision
`playwright==1.55.0` and its Chromium through the existing CI installation pattern.
Run:

```sh
python scripts/verify-cmp-recovery-experiment.py
```

Optional `CHROMIUM_PATH` selects an installed executable;
`CMP_RECOVERY_CASES` selects comma-separated scenario names. The script validates
the Prebid hash before launching. It writes sanitized per-case traces to
`.generated/cmp-recovery-native/results.json` and intentionally exits **1** while
any acceptance assertion fails. Do not convert the known failures into expected
passes to claim recovery is complete.

A compact receipt from the observed run is retained in
[cmp-recovery-native-receipt.json](cmp-recovery-native-receipt.json).
`npm ci`, `npm run typecheck`, `npm run build`, and the existing experiment plus
readiness test files passed. Build emitted the existing chunk-size warning and a
sandbox log-write warning; it completed successfully. No CI, TEST deployment or
publisher run is claimed.

## Remaining decision

A recovery design must coordinate the wrapper and native CMP subscriptions and
cached consent, including obsolete native callbacks. Repeating `setConfig` alone
is demonstrably insufficient. No static consent substitution or global
`defaultGdprScope:false` was used. Real GPT behavior, the complete generated
wrapper/reporting handoff, and the separate 11.11.0 Politika package remain outside
this harness. No new runtime should be registered from these results alone.
