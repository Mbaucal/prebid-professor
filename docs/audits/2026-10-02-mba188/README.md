# MBA-188: atomic consent-change test interval

The browser verifier previously read the request baseline and emitted
`cmpuishown` in separate browser tasks. Its installed clock continues advancing
between tasks. An allowed earlier request could therefore be counted against the
later pending-choice interval. The original failing CI run did not record its
interleaving; attribution of that historical failure remains an inference.

This test-only change checks the active Billboard auction, verifies that its
initial request has not dispatched, takes the baseline, and emits `cmpuishown`
in one browser task. The baseline is **before** the emit, so even an erroneous
synchronous dispatch inside a CMP callback is counted and rejected.

Each observed dispatch and CMP boundary has a monotonic sequence plus the
runtime's `ready`, `phase`, and `epoch`. Failure JSON includes that ordered trace,
the observed requests/auctions, and browser/network errors. TC strings and user
identifiers are not included in the trace. Every existing no-request,
no-auction, canceled-epoch, initial-count and targeting assertion is retained.

`verify-consent-boundary.py` adds bounded controls on readable and minified
unchanged 3.14 output. It holds one actual synthetic TakeOver GPT dispatch and
uses a focused Prebid hook to hold the Billboard pre-auction continuation until
that capture occurs. Capture releases the continuation exactly once; the original
auction-start poll and atomic preconditions then establish a pending native
Billboard auction. Both capture-before-hook and hook-before-capture are supported.
The trace verifies capture and gate before one release before the baseline. The
normal 34-case matrix does not install these hooks. There are no blind retries,
fixed readiness delays or additional waiting in the normal matrix.

| Control | Required observation |
| --- | --- |
| Old split boundary | Allowed ready dispatch between baseline and pending event causes the original assertion to reject; trace confirms no real pending dispatch. |
| Atomic boundary | The same allowed dispatch precedes the atomic baseline; the full original scenario passes. |
| Pending dispatch | Releasing the actual mock GPT request after the pending event fails the original count assertion. |
| Synchronous CMP callback | Releasing it inside the pending CMP callback also fails the original count assertion. |

The held-dispatch and negative injections are explicit test controls, not changes
to runtime consent behavior. Expected rejection is accepted only with the exact
`Pending decision allowed a request` error and the required sequence/phase trace.
Any unrelated error fails the control. The existing readiness CI workflow runs
both the original matrix and these controls, and uploads their JSON evidence.

Reproduce using the locked Node dependencies and CI-pinned Playwright 1.55.0:

```sh
npm ci --ignore-scripts
node scripts/prepare-builtin-runtime.mjs
node scripts/prepare-test-workspace.mjs
node --experimental-strip-types scripts/prepare-readiness-browser-fixtures.mjs
python scripts/verify-consent-readiness.py
python scripts/verify-consent-boundary.py
npm run typecheck
npm run build
```

The initial control used a 20ms clock step to assume the TakeOver dispatch was
already captured. Its owner-branch run passed, but a separate local TEST carry
produced **7/8**, with `atomic-after.js` failing `Control did not capture an actual
ready TakeOver dispatch`. That recorded trace showed the Billboard auction had
started and the Overlay auction completed, but its deferred GPT dispatch had not
run. This was a control-preparation failure, not a pending-consent runtime request.
The event barrier above replaces that timing assumption. The original failure
report was retained by the PM as `boundary-before-barrier-results.json`; the first
8/8 result alone is not presented as proof of deterministic control preparation.

Executed after the correction with Playwright 1.55.0 / Chromium headless 140.0.7339.16:

- Original browser matrix: **34/34 PASS**.
- Focused controls: **8/8 PASS**, including the expected old-boundary rejection
  and both genuine pending-request rejection controls.
- Existing readiness Node regressions: **12/12 PASS**.
- Strict app, Worker and tooling type checks: **PASS**.
- Production build and whitespace/diff checks: **PASS**.

[Compact evidence](evidence.json) records the exact boundary sequence and phase
for each control. Full traces are reproducible in the generated CI artifacts.

No Worker/runtime/compiler/default, publisher configuration, UI, schema, vendor,
package or lockfile changes are included. Generated readable and minified
`prebid` fixture SHA-256 values remain:

- `6081e723656b0620b13bc40ef86ff1dc9f8254510aeb22a61da2e018708c093e`
- `004e044594bf9a0dac16c2b4d5219d773cbf1086fcf43e4ffc89344a9c4c83f1`

All browser demand is synthetic/intercepted. This is browser-test reliability
work, not a new verification of live publisher CMP/GPT privacy or revenue.
