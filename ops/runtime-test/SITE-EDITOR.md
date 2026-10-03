# MBA-54 — TEST site-copy editor

This increment follows the accepted exact runtime selection and saved ZIP test.
It targets ONLY `feature/isolated-runtime-workspace-v1`, not `main`.

## Intentional scope expansion

`/site-settings` edits the single existing TEST record `test-site`: name, domain,
GAM path, banner position IDs/types/enabled state, width-based size maps, and the
bottom sticky position (or Off). This is a draft COPY; it never imports or edits
production data, fetches the entered domain, executes ads, or enables publishing.
An explicitly saved runtime pin is required before editing. Non-synthetic site
metadata also requires the server-owned `testSiteDraft` candidate-only marker.
The editor does not accept arbitrary site IDs, config/source objects, credentials,
CMS/email integrations, Prebid uploads, or bidders. GPT-only remains enforced.
Existing host/session/origin/request limits, TEST D1/R2 and CSP remain intact.

Navigation between Generate, Script version and Site and ad positions is visible.
The edited GAM path is also used for the generated TakeOver interstitial fallback.
Reference v3.9.1 source and bundled runtime version are not modified.

## Persistence and compatibility

The normalized proposal preserves non-editor configuration and retained row IDs,
notes and creation dates. All eight snapshot projections are compared inside one
D1 transaction, before changes AND after writes, together with the audit entry.
Bulk JSON upserts keep the transaction at ten statements for up to 100 positions
and 32 maps; stale tabs fail with 409, and uncertain writes require a reload.
A normalized repeated save produces no additional audit record.

Deleting a position still referenced by saved per-position rules is refused;
disable it until those rules are reviewed. Height-based maps and non-banner
positions are refused rather than silently flattened. Empty sizes at a breakpoint
are preserved deliberately. A base 0px breakpoint is mandatory.

Old reviewed receipts are invalidated by a settings edit. Historical saved ZIPs
remain original byte-for-byte packages, never rebuilt from current settings.
No schema migration, reset, dependency or binding/secret changes are needed.

## Verification boundary

Local verification before opening the PR: 59 site validation/SQLite transaction
tests and 42 existing runtime-selection CAS tests pass. Local staged Git tree
matched the uploaded source tree a2f9e803537350251591c26c01c4cdbbdf0e6e73 exactly.
Full HTTP, compiled workerd/D1/R2 and Chromium checks are provided by the new
`TEST site editor checks` workflow; inspect actual results before merge.
The existing complete workspace workflow remains unchanged as regression cover.
All browser harness traffic is pinned to loopback TLS, not the hosted Worker.

Before asking Marko to test, require successful review/tests and a confirmed
Cloudflare build of the TEST merge. Update MBA-54 and START HERE with that exact
version and the new editor-only acceptance steps. Do not repeat infrastructure,
Secrets, isolation audit or the previously accepted runtime selection/ZIP chores.

## Still not complete

Prebid upload, bidder parameters/selection and real auction testing are separate
follow-ups, as are cross-account publishing/rollback and full live readiness.
Candidates downloaded here are NOT an approval to install them on a live site.
