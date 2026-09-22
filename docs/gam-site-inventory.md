# Complete size maps and GAM → Site inventory — MBA-91

## User flow

Size maps has **Add 7 default maps**, plus its own CSV import/download. The
catalogue contains Sticky, Billboard, InFeed, P, InText, Branding_Map and
Under_Article: exactly 25 breakpoint rows from the supplied table. `fluid`,
1×1, viewport 910 and the empty Branding_Map mobile breakpoint are retained.
The Billboard 469 row follows SIZES_JSON, including 468×60. Height is zero.
The TEST site editor adds defaults to its unsaved draft; Save site settings
persists that draft. Main adds missing maps directly. Neither action replaces
an existing definition. Explicit CSV import still previews/replaces named maps.

Ad units has its own CSV import, with 26 starter positions matching GAM presets.
Shared canonical data drives those map references, CSV sizes and GAM size unions.
The user can delete surplus entries or edit a preset's map, names and sizes.

In **API integracije → Ad uniti**, choose an actual Tessera site and the matching
GAM parent. The local site GAM path must match the selected parent exactly
(trailing slash ignored). No site path or identity is silently rewritten.
The preview shows local additions and existing positions before confirmation.
There is also an explicit **Samo GAM — bez upisa u sajt** choice.

After create, confirmed Google rows are added to the selected site's inventory.
Existing codes retain their type, map, enabled state, sort order, notes, IDs and
display/loading settings. Missing default maps are added. Custom names retain
their explicitly chosen preset map. Without one, recognized position names use
the matching default; other names receive a static GAM_<code> map built from
their actual GAM sizes. Existing GAM inventory is never resized by this flow.
Concrete map/GAM size differences are shown for review before Generate/Publish.
GAM inventory stores available sizes; responsive viewport rules remain in Tessera/GPT.

In History, **Proveri upis u sajt** can attach an earlier result or recover a
pending local save. It reads the confirmed IDs from Google, verifies status/code/
path, then presents the destination and additions. **Potvrdi upis u sajt** only
commits the reviewed local inventory. It never creates anything in Google.
Missing/unconfirmed GAM rows require a fresh GAM preview instead.

## Persistence and concurrency

Google's immutable R2 result is stored before the local transaction. Google and
D1 are separate operations; a failed local save returns `siteSync.state=pending`
alongside the preserved Google outcome. Retrying the same GAM job reads its saved
result and local receipt, never reruns Google create. A partial Google batch adds
only confirmed rows. Fresh Google review can finish the unconfirmed portion.

Local preview captures site identity (including creation timestamp), configuration,
units and maps. D1 compares that snapshot inside an atomic batch. One audit row
with deterministic job/site ID and a per-attempt nonce gates all subsequent
inserts. Units, maps, invalidated draft config hash and the GAM ID/path receipt
commit together. Concurrent edits, SQL failure and request replays cannot leave
a receipt without its inventory or overwrite existing records. A lost response
is resolved by reading the persisted receipt. No schema migration is required.

The immutable audit receipt records the GAM IDs, full paths, actual sizes, local
unit IDs and effective map references. Old result attachments are rediscovered
from those receipts when History loads. No runtime version, bidders, rules,
configuration JSON, releases or published packages are modified. Generate/Publish
is a separate owner action after reviewing the new inventory.

TEST adds its exact site restriction, database/schema identity inspection and
existing site-draft validation to the authenticated same-origin boundary. The
new route cannot target a production site or loosen the TEST schema guard.

## Validation

`tests/gam/site-inventory.test.mjs` exercises complete CSV/catalogue coverage,
GAM-to-D1 sync, strict preservation, duplicate/replay prevention, wrong path/site,
stale local state before/during Google calls, atomic rollback, partial Google
batches and attaching earlier GAM-only history. It uses SQLite plus synthetic
Google/R2 fixtures. It reads the saved data through the existing TEST site editor.

`tests/gam/test-routes.test.mjs` exercises real Worker authentication, scope,
schema, defaults and the existing editor. TEST CSV route tests import all seven
maps and 26 units through the revision-checked draft editor, including fluid and
empty breakpoints. `scripts/verify-gam-ui.py` checks the shared React flow against
synthetic Google and SQLite, resulting IDs/paths and local save status at desktop
and mobile sizes. No real Google inventory is created by development checks.

Rollout: deploy to isolated TEST first. The main PR remains a draft until owner
acceptance of this new write flow. No existing site is automatically seeded on
deployment; the map/import/create controls are explicit user actions.
