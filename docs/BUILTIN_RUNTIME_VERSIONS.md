# Built-in ads.js versions

Tessera generates ads.js from saved site settings. Users do not upload an ads.js
template. Development of the generator and its release notes happens in this
repository, goes to TEST first, and requires a separate explicit production release.

The TEST **Script version** screen at `/runtime-selection` shows the currently
bundled build, the site's exact saved choice, and version history. History is
informational: opening it does not select a version or write site settings. Only
the bundled generator can build a new package. Earlier saved packages remain
available with their original bytes; history does not recreate old generators.

## Recording an upgrade

1. Make the generator change on a development branch targeting TEST.
2. Give the changed engine a new exact version and ID. Prepend a record to
   `worker/runtime/runtime-releases.json` with its source checksum, release date,
   source commit, schema, channel, capabilities, title and useful change notes.
   The source commit identifies the preceding commit containing the engine change.
3. Retain every previous record unchanged. Do not reuse a version number for
   different source bytes. `check-runtime-release-history.mjs` compares the register
   with the PR base, and runtime preparation checks the latest recorded checksum
   against the actual generator dependency closure.
4. Run relevant verification, review and deploy TEST. Viewing the new release
   never upgrades a site's saved choice. A user explicitly selects it before
   generating a new package. Preserve other site and Prebid settings.

The source checksum is SHA-256 of the JSON serialization of the sorted source
component list in `scripts/prepare-builtin-runtime.mjs`. When preparing a new
record, calculate it from that same list; never remove the preparation assertion.
Release notes and the history UI do not affect generated ads.js and are outside
that source closure. Build metadata and runtime pins continue to identify exact
bytes independently of these notes.

## Historical version correction

Before this register existed, two TEST builds shared `3.9.1-tessera.preview.2`:

| Source build | Source checksum | Change |
| --- | --- | --- |
| 2026-09-13, `03b96e1` | `222569881b377c085f0b5d373523d092d64e2ac5dab05d421c3cc9f371078de9` | Prebid configuration and currency support |
| 2026-09-11, `047aa10` | `71fddef7fb9e7c3a23eca8a1098776e0b1c4c7e299e2cc5766e8a649e7e94939` | Built-in generator and complete TEST package |

Both identities are recorded honestly, with dates and checksums distinguishing
them. This is a fixed historical exception. Future changed engine bytes must use
a new version. A saved older pin is displayed as such and is never silently
replaced or treated as a match for the current build. Selecting the available TEST
build explicitly is necessary to generate again from that earlier pin.
