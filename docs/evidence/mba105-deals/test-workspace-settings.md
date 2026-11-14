# Isolated TEST settings adapter — 2026-10-11

The fixed `/test-api/deals` and `/test-api/outstream-settings` GET/POST endpoints call the existing shared services for literal `test-site`, after the existing TEST activation/resource, authenticated-session, same-origin, schema and site-scope checks. Query-selected sites and arbitrary publisher routes are not introduced. Existing defaults stay unchanged; the fixture explicitly selects the revenue preview.

Legacy site and Prebid editors preserve Deals/Formats metadata and reject referenced-position removal, rename, disable or incompatible partner changes even with demand switched OFF. OFF remains an explicit supported setting that preserves valid metadata. Optimistic revisions prevent stale cross-form writes.

Actual local HTTP testing reproduced two integration defects: the Formats eligibility response read the wrong runtime-pin field, and stored-draft file inventory rejected the revenue compiler's `deals-plan.json`. The response now reads `runtimeVersion`. Storage accepts/requires this plan only for the exact revenue runtime ID/version with its Deals capability, while retaining the previous file sets. Reopening verifies every original byte and hash; arbitrary extra files and mismatched runtime contracts remain rejected.

Validation on local Node 24.19.0, Linux x64, TZ=UTC:

- Checked-in locked bootstrap, `npm run typecheck` (three strict projects), and `npm run build`: passed, including the historical 63-output verification.
- `node --experimental-strip-types --test tests/runtime/test-revenue-settings.test.mjs tests/runtime/test-prebid-settings.test.mjs tests/runtime/site-draft.test.mjs tests/runtime/draft-release-store.test.mjs`: 146 passed.
- The three new HTTP cases use actual Worker routing, SQLite transactions and in-memory private R2. They cover session/origin/resource boundaries, both setting saves, stale revision rejection, explicit runtime retention, native 11.34.0 file upload, generate → save → reopen → download, exact ZIP/R2 byte equality, unsupported package inventories, and legacy edits while OFF. Outbound fetch throws in the fixture.
- Final focused three-case rerun passed after adding the initial runtime-ineligible assertion. Final strict/build passed after all server edits.

React desktop/narrow coverage is maintained by the separate revenue-workspace browser verifier. These results do not claim hosted deployment, live bidder/GAM operation, publisher activation, paid traffic, or production readiness. No historical runtime source, lock, default selection or stored release was rewritten.
