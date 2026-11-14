# MBA-54 — isolated Prebid configuration

## Scope

This increment extends the existing TEST copy (`test-site`) only. It does not
change main, production data, reference runtime code, bindings, schema or secrets.
The accepted site settings, explicit runtime selection and historical packages
are retained. `/prebid-settings` is reachable from all three existing screens.

The new raw upload endpoint requires the same host/session/origin protection,
application/javascript and a form-owned upload marker. It counts streamed bytes
up to 8 MiB, checks UTF-8 plus original version/Modules declarations, computes a
SHA-256 content ID, stores at a fixed private TEST R2 key with conditional writes,
then verifies bytes and metadata. This is not a general URL/file fetch or a public
JavaScript endpoint. The library is limited to 50 distinct file registrations.
Header checks are not code-safety certification or a test of actual ad delivery.

Upload registers an archived/unselected file and never changes current settings.
Retrying identical bytes is idempotent. Selection is explicit: one current file,
Prebid ON/OFF, base bidder parameters and device/ATF-BTF/exact-position overrides.
Parameters are JSON data, not executable callbacks; scope and prototype/size
limits are checked. Supported names match the existing runtime module catalogue.
Real partner IDs and correct commercial setup still need a pilot delivery test.

## Persistence and generation

The saved TEST marker and exact runtime pin are required. All eight snapshot
projections plus the selected archived file metadata are compared inside one D1
batch together with current-file switching, bidder/override upserts and audit.
Stale tabs fail409; an uncertain commit asks for rereading rather than deleting or
undoing files. Existing row IDs and unrelated config are retained. Normalized
unchanged saves do not duplicate audit. Upload and selection are separate steps.

The runtime-version form preserves Prebid mode/file; the site editor preserves
bidders and refuses removing an active exact-position override target. Generate
checks the chosen file against its stored checksum/version/modules again and
includes its original bytes in the 10-file candidate ZIP. OFF retains files and
parameters but generates a 9-file GPT-only candidate. Old saved ZIPs are read as
original bytes, never regenerated using new settings. Review receipts are stale
if configuration or current file changes; generating again is then required.

There are no live auctions, public ad-code execution, CMS/email calls, arbitrary
site IDs, production imports, database resets or publishing routes in this work.
TakeOver remains the unchanged reference GPT-only module, not a Prebid position.

## Verified implementation checkpoint

Head00a795c5: local182/182 service/SQLite/regression tests passed before uploading.
After retrieving the locked existing fflate dependency from CI, the new30service
and10HTTP tests also passed locally (40/40). The local staged Git tree matched the
remote tree exactly. The new CI run34756101179 completed successfully. Artifact
10317796704 was downloaded and its SHA256 verified as
31babdc10971a460c2613d424caa1a995599fe671af2d9f6fabdad6df1e6ad90.
Both JSON reports were read:27local compiled-workerd/D1/R2 checks and13real Chromium
checks passed. Desktop/mobile screenshots were visually inspected. No application
outbound requests or uploaded script execution. These are LOCAL/CI checks, not
Marko's hosted acceptance or a fresh Cloudflare binding metadata audit.

The temporary dependency-archive step and previous source-snapshot workflow are
removed before final merge. Inspect final head CI and review, not just this first
checkpoint. Once passed, merge ONLY to feature/isolated-runtime-workspace-v1 and
require the actual Cloudflare test build/version before requesting a user test.
Do not repeat infrastructure, Secrets, audit, runtime choice or accepted editor
and old ZIP chores. Record final evidence and user action in MBA-54/START HERE.

## Remaining release work

A real build uploaded by Marko, saved bidder configuration and resulting ZIP need
hosted acceptance; actual Prebid/GAM auctions and display are a separate pilot.
Cross-account publishing/rollback, toolchain warning resolution and launch
criteria remain separate tasks. This increment is not approval for live use.
