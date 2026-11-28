# Opt-in Prebid observer lifecycle candidate

This is a new, separately identified Tessera build based on upstream Prebid
**11.34.0**, not a new official Prebid release. The JS header and `pbjs.version`
remain 11.34.0. The filename, selected build ID and SHA256 distinguish this variant.

`prebid.js` SHA256:
`d58129a05e32ea325cbbb8bbf8531b4676b7df5ace5b32a3f8474beb8dff5889`.

The reviewed **20-module profile is derived from Tanjug's frozen module list**.
Its bidder adapters are criteo, openx, pubmatic and teads. It is not a universal
build and does not cover all enabled Politika bidders. Do not remove configured
bidders or privacy modules to make this file pass validation.

For another site, export/check that site's complete module list and build a
separate candidate with the same source patch:

```sh
node scripts/build-prebid-observer435.mjs \
  --modules /path/to/explicit-prebid-11.34-profile.json \
  --build-date 2026-11-28 \
  --out .generated/site-observer435-build
```

The profile must explicitly name version `11.34.0`; this command does not upgrade
or rewrite an older profile. It preserves the exact requested module set, checks
module names and source availability, retains TCF modules and refuses the
synthetic audit provider. Every resulting build gets its own module list/hash.
The reviewed UTC banner date is `2026-11-28`. Upstream normally stamps the day
of compilation; `--build-date` normalizes only that date comment line, validates
the date and verifies unchanged executable-body bytes. Produced/selected dates
and the executable-body hash are recorded in the manifest. Match the recorded
source/lock/module/tool versions as well when reproducing exact file bytes.

Use **Publishers → publisher → site → Prebid.js → Step 2** to inspect the file
and its complete module list, then **Upload approved build to R2**. Review missing
adapter/platform-module warnings; preserve the site's entire existing profile and
do not disable required settings to force this default profile to pass. A valid
upload is archived when a current build already exists. In **R2 build history**,
use **Set current** only after checking compatibility and the candidate hash.
On an empty site, the first valid upload follows the existing automatic-current
contract. Then Generate/Save/reopen/download a new package. Publisher deployment
is separate. No upload, selection or publisher activation is performed by these
repository files.

`manifest.json`, `prebid-config.json` and `observer-lifecycle.patch` record
upstream commit/lock, module selection, canonical custom module and patch/build
hashes. Existing vendor bytes, runtime pins and saved ZIPs are unchanged.

`renderer-display.js` and `renderer-native.js` are standalone compiled
**verification payloads**, not files to upload or serve separately. The current
20-module production bundle embeds the display path; native-format rendering
requires the site's explicit `nativeRendering` module profile. Testing a real
Prebid core with banner creatives is different from native-ad-format acceptance.

See [implementation and evidence](../../../docs/observer435-prebid-lifecycle.md).
