# MBA-54: first isolated runtime-selection editor

This is the next increment on PR31, not a main/live release. Do not change the existing Cloudflare Build branch merely to try this draft. The previously verified TEST workspace and stored packages remain intact until a reviewed test-only promotion.

## Implemented boundary

`/runtime-selection` is an authenticated screen using the existing TEST session, host/origin checks and CSP. It displays the one actual bundled runtime and saves its exact pin, with explicit Preview opt-in. There are no fictional Stable versions. `GET /test-api/runtime-selection` returns only public site details, a reviewed revision, a code-owned catalog and a validated pin; it never returns arbitrary config or connector fields. POST accepts only `expectedRevision` and the narrow selection object.

The service reads the real saved snapshot, prepares the selection using the existing planner, then compares ALL eight snapshot projections inside the SAME D1 batch as the config update and audit record. It reuses the existing checksum-locked test schema's assertions table. No migration, schema reset or production seed import is performed. Every SQL identifier/projection is code-owned; values are bound. A stale configuration, unit, size map, rule, bidder/override or current Prebid record aborts the transaction. Other sites are never updated. Unchanged settings do not create another audit record. An uncertain transport outcome requires rereading settings, not destructive recovery or a blind retry.

D1 batching contract: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch

Once a saved pin exists, Generate and reviewed Save validate and use it; missing/modified runtime bytes do not fall back. The config snapshot hash already binds review receipts, so saving a different selection invalidates an older generated receipt. Historical downloads still read original immutable files. The original UNPINNED synthetic GPT-only demo remains compatible; that limited bootstrap default is not a policy for future real sites.

## Deliberate limits

This increment still accepts ONLY `test-site` / `example.invalid` / `/123/test/`, GPT-only, with no bidders, overrides or Prebid builds. The screen does not edit the domain, GAM path, units or size maps. Prebid upload/selection, a broader site editor and multi-version compilation remain subsequent MBA-54 work. Stored version verification is not proof of actual ad delivery. No publisher publishing, email/CMS request, remote storage deletion or new credentials are introduced.

The settings page is directly accessible at `/runtime-selection`; the original Generate page is unchanged. This avoids broad layout changes while testing the new writer. The settings page includes Back to Generate.

## Verification to perform before TEST promotion

The updated existing workspace workflow also runs on PRs targeting the isolated test branch. It retains read-only permissions, existing pinned actions and no hosted credentials/deployments. It exercises the original Node cases plus selection planner tests, 42 SQLite compare-and-swap cases and HTTP integration cases; compiles both configurations without deploying; checks local workerd/D1/R2 including restart; and runs Chromium with two tabs and loopback-only networking. The browser cases add Preview opt-in, stale-tab conflict, explicit reload, idempotence, persisted selection and responsive layout, then execute Generate/Save/reopen/download using the saved pin. Reports/screenshots contain synthetic state only, no cookies/credentials/receipts/database files.

Local syntax and SQLite CAS checks can run before CI. CI/Chromium and hosted success must be recorded from actual results, not this planned checklist. Do not tell Marko to test before a new TEST build is confirmed. No repeated infrastructure setup, isolation audit of unchanged bindings or earlier ZIP test is required here.
