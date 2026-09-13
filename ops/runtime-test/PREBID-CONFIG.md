# MBA-54 — automatic Prebid build preparation

The TEST Prebid page now follows the existing Download format: `{version, modules}`.
The module list comes from `prebidRequirements(previewInput(...))`, the same rule
used by artifact validation. It includes configured bidders, CMP/TCF, enabled
floors, currency conversion, configured supply chain and supported User IDs.
No partner parameters or other site values are sent to the builder.

`POST /test-api/prebid/plan` prepares the current form without writes or R2 reads.
`POST /test-api/prebid/plan/save` stores a pending preparation under
`testPrebidPlan`, with the existing eight-projection atomic comparison and audit.
It leaves active bidders, overrides, mode, current file and exact pin intact.
Reload restores the pending form. Generate continues using the active selection.
Save Prebid settings applies options and bidders with the verified original file
in the existing transaction and removes the pending preparation. Both planning
and activation reject a stale revision. Correctable validation keeps form edits.

The user can load the available version list from the fixed, read-only official
Prebid endpoint. An entered or already saved version is never silently replaced.
The builder may omit modules or versions it no longer offers. Returned files
must match the planned version and all required modules; extra modules are
allowed. Missing modules name the feature that requires them. Bytes, checksum,
stored metadata and header are still checked; JavaScript is never executed.

Known runtime limits remain explicit: CMP mode only, banner inventory, User ID
params/storage (custom value/bidders fields need separate runtime support).
No blind enabling of the old panel's privacy/identity/analytics groups. No schema,
binding, secret, production endpoint or reference runtime source changes.

New checks: `node --test tests/runtime/test-prebid-plan.test.mjs` and
`python scripts/verify-prebid-config.py`. The Chromium fixture uses loopback TLS,
actual Worker handler, SQLite and fake R2. It is not a hosted-session or auction
test. The local test setup seeds a disposable database; never rerun setup on the
user's existing TEST database. The previous accepted user tests stay accepted.

Sources inspected 2026-09-13:
- https://github.com/prebid/prebid.github.io/blob/master/assets/js/download.js
- https://docs.prebid.org/download.html
- https://js-download.prebid.org/versions

TEST deployment and final evidence must be confirmed before requesting the new
user round-trip. Main and production are outside this change.

## Catalog outage recovery and shorter flow

Catalog loading is automatic and owns only its retry button. A failure never sets
`stale` or disables download/save/editing. If the same-origin lookup fails, a
bounded CORS GET reads the same fixed official public endpoint directly, without
credentials, referrer, request body or site parameters. Only the Prebid page CSP
permits that exact data URL; external scripts remain blocked. Both routes use the
same size, timeout, redirect and version validation. A failed fallback is an
inline note. Version selection always remains explicit.

`Save & download prebid-config.json` stores the pending preparation and downloads
its exact returned configuration in one action. It needs no separate save or
checkbox; the button and adjacent text explicitly state TEST preparation saving.
Final activation retains its TEST checkbox. The response includes the revision
of the committed snapshot, so the page keeps its form fields and cannot adopt a
concurrent edit from another tab. A save failure still marks the form uncertain;
a successful catalog retry must never clear that protection.

Build options, module details, other versions and save-for-later are collapsible.
The main flow is three numbered steps. Opening the builder obtains a fresh plan
in a single click and closes the new tab on failure. This operation is read-only;
only a real revision conflict, not a read outage, makes its form stale.

New browser checks reproduce the reported 503, a delayed lookup while editing,
the public fallback, combined save/export, and a catalog retry after an uncertain
write. Public catalog responses in the harness are inert fixtures; no external
request or user setting is used. The actual server-to-Prebid failure reported by
the user is not independently diagnosed; recovery does not depend on its cause.
