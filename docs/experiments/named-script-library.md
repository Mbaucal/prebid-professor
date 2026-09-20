# Named scripts and optional A/B tests

Tanjug → Releases → Scripts and A/B tests separates a saved script from the test
that uses it. A script has a required, user-chosen name and its own auction/cache
and standard refresh settings. Save script version creates an immutable standalone
ZIP and record. Download uses the chosen name plus a short version suffix.

An A/B test only chooses a name, two existing script versions and traffic split.
The same version may appear on both sides for A/A. Each page executes one selected
runtime. The test package includes the exact saved runtime files; it never rebuilds
them from current settings. A saved script can participate in multiple tests and
remain independently usable. Standalone delivery does not add Variant targeting;
A/B delivery adds exactly Variant=A or Variant=B.

The existing accepted baseline is still Tanjug A/A 1.0.2: 19 positions, Prebid
11.34.0 and its reviewed inventory, bidders and CMP behavior. Other Config edits
and arbitrary site packages are not silently accepted. Composition verifies shared
dependencies and baseline identity. Adaptive refresh and cache-first remain separate
features. Standard cache mode continues to run an auction at each opportunity.

## Identity and persistence

New script and test profiles use `tanjug-script-1.0.0-<hash>` and
`tanjug-test-1.0.0-<hash>`. Script identity includes its name, canonical settings,
pinned inputs and compiled output. A different name or configuration saves a new
version; identical input returns the original record. The UI makes full identifiers
available in details, using the chosen name as the primary label.

The runtime checks its selected **script** identity independently of the delivery
package/test identity. Both modes retain the existing duplicate-start guard,
integrity verification and CMP entry flow. Debug reports delivery mode, script
name/version, optional test name, allocation and cache/refresh settings.

`/api/publishers/:site/script-library` is authenticated. POST `/scripts` and `/tests`
require same-origin, strict bounded JSON and the site/baseline revision. Tests accept
only script IDs saved under the same site. R2 uses a new `site-script-library/v1/`
prefix; conditional writes, checksummed metadata and archive verification precede
registration. Incomplete or corrupt packages cannot be downloaded or composed.
Listings are paginated. No database migration or channel change is performed.

Earlier A/B ZIPs remain available in a collapsed Earlier A/B packages section,
with their original storage/API/compiler profiles unchanged. New generation uses
the named script library instead of repeating cache/refresh forms inside a test.

## Activation and verification

Saving and downloading do not publish. Upload the complete standalone or test ZIP
to the existing Pages project; its ads.js URL stays the same. The platform does not
claim to know which manual Pages deployment is active.

Verification covers named/idempotent saves, immutable references, A/A composition,
cross-site/stale/corrupt input rejection, exact offline/compiled Worker ZIP parity,
real React save/select/download flows, long names on mobile and native Prebid
delivery for standalone fresh/cache, A/B and A/A packages. External ad traffic is
blocked in these tests. They do not establish revenue improvement.
