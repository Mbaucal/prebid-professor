# Revenue settings in the isolated TEST workspace

The existing `/site-workspace` now mounts the actual Deals and Formats panels against fixed `/test-api/deals` and `/test-api/outstream-settings` routes. Their default MAIN endpoints remain unchanged. This adds no full App router or generic publisher API forwarding.

Local acceptance uses `scripts/site-workspace-browser-fixture.mjs --revenue`: actual TEST authentication, schema setup, explicit revenue runtime selection, checked-in Prebid upload, and HTTP configuration through the real Worker with SQLite and synthetic R2. Browser requests are intercepted into this local fixture; external requests fail.

Run after the locked bootstrap and workspace preparation:

```sh
node scripts/builtin-toolchain.mjs bootstrap
node scripts/isolated-toolchain.mjs prepare
node scripts/prepare-test-workspace.mjs
node scripts/prepare-site-workspace.mjs
CHROMIUM_PATH=/tmp/rei-chromium TZ=UTC /tmp/tessera-browser/bin/python scripts/verify-revenue-workspace.py
```

Both 1440px and 390px passed: held real read/loading, Deals save and page reload, Formats save and page reload, actual concurrent revision conflict (409), visible error with retained draft, reload recovery, and return to Banner. Final reads prove saved inventory/maps and Prebid configuration unchanged. No MAIN publisher requests occurred. The test also caught and now guards against an incorrect runtime eligibility warning from the saved pin's field name.

Evidence is written to `.generated/revenue-workspace-evidence/results.json` and four viewport screenshots. Visual review confirmed the narrow error is visible and the modal remains scrollable; desktop Deals controls are legible without horizontal overflow. Local strict typecheck and App/Worker build passed on Node 24.19; Node 22 CI remains a separate gate.

This proves local TEST settings persistence across page reloads, not hosted deployment, storage process restart, live GAM delivery, or actual vendor player lifecycle. Worker HTTP tests separately cover package generation/save/reopen/download. A future TEST carry must preserve its existing six runtimes and append revenue as the seventh, along with its existing default, pins, and 66-output isolation receipt; this MAIN-based fixture does not prove that carry.
