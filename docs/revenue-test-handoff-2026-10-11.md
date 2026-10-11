# Deals and Banner + Outstream: isolated TEST candidate

This candidate is based on TEST `4e3307ff40834b378358b9338b5ce8de8bc6b084`.
It appends `3.16.0-revenue.preview.1` to the six existing TEST choices, preserving
their order, source pins and the default. It does not merge MAIN into TEST or
change TEST bindings, build settings, credentials, routes or cron configuration.

The revenue source pin remains `2af57b54847f77f9d180a242e76890b93d355064` and its
source checksum remains `4ef15a0ac9e97c6de58a0bd0e1bd9a3428c6f29394c970c99626c09a76f0925c`.
All 24 previously existing source inputs are identical across the branches;
the eleven new revenue source files are copied exactly from the reviewed source.

## What is now testable

`/site-workspace` uses the actual Deals and Formats panels, with fixed TEST-only
endpoints. They authenticate through the existing TEST boundary and operate only
on the checked synthetic site. Existing Loading rules, creative-template links,
hash navigation and all other TEST workspace features remain available.

The real save flow exposed and fixed two defects: runtime eligibility read the
wrong saved-pin field, and the draft store did not recognize `deals-plan.json`.
The extra package file is accepted only for the exact revenue runtime contract;
arbitrary files and missing plan files are rejected. Historical packages retain
their old file sets and byte verification. Legacy position/bidder editors cannot
orphan saved Deals or Formats settings, including while Prebid is off.

## Local evidence and reproducible gates

Strict App/Worker/tooling checks and build passed with the TEST profile. All 66
historical generated outputs matched their unchanged receipt. All eight release
records passed provenance/history checks. The history guard validates the exact
seven-record baseline against its existing receipt hash, then permits only new
versions before that unchanged history; mutation tests reject edits, deletion,
reordering, duplicate-version additions and a changed baseline snapshot.

Actual Worker/SQLite checks cover settings, stale revisions, generation, Save,
reopen and byte-identical download. Browser checks passed at 1440 and 390 pixels,
including real concurrent-write conflict recovery, retained input and return to
Banner. Network is intercepted into synthetic storage; no partner ads are loaded.
These results are local, not hosted acceptance or proof of revenue.

```sh
node scripts/bootstrap-toolchain.mjs --profile test
node scripts/isolated-toolchain.mjs typecheck --profile test
node scripts/isolated-toolchain.mjs build --profile test
node scripts/prepare-test-workspace.mjs
node --experimental-strip-types --test tests/runtime/test-revenue-settings.test.mjs
python scripts/verify-revenue-workspace.py
node scripts/isolated-toolchain.mjs test-build --profile test
node scripts/isolated-toolchain.mjs test-deploy-check --profile test
```

The final two commands prepare/check sealed Worker bytes locally. They do not
deploy. The receipt, historical locks, profile and all 66 output expectations
must stay unchanged.

## Hosted acceptance after the reviewed candidate is deployed to TEST

1. Open the existing TEST `/site-workspace` and choose the new version explicitly.
2. Confirm the intended Prebid file and PubMatic settings, then save/reopen a Deal
   and one position's Formats settings. Use a player size included in every
   nonempty enabled GPT size-map row.
3. Generate and save a package, reopen it, and download its original bytes.
   Verify the runtime version and `deals-plan.json`. Saving does not activate ads.
4. Before a live creative test, obtain the partner's actual activated renderer ID
   and agreed Deal ID, plus a controlled GAM friendly-iframe creative. The IDs
   in automated fixtures are synthetic and must not be used as live credentials.

Real BlueBillywig lifecycle, GAM eligibility, billable impressions, layout shift
and revenue remain unverified. The pilot has no automatic position refresh and
does not support SafeFrame, Sticky/TakeOver video or additional video partners.
Do not claim those acceptance items from synthetic adapter/PUC success.

No TEST deployment, MAIN merge, publisher activation or GAM write is part of this
record. Preserve existing TEST storage for any code rollback; do not reset it.
