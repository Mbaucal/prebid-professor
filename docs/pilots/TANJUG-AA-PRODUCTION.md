# Complete Tanjug A/A delivery 1.0.0

Marko requested a complete deployable package on 18 September, with identical A
and B scripts first, public `Variant=A/B`, all positions, and quick rollback on
the small live site. This supersedes the prior local-only two-position test
workflow. The deliverable is a new static Pages package, not another partial
override kit. Preparing/downloading it does not itself deploy it.

The input is the complete pinned Tanjug source that matched the accepted live
ads.js hash `62fc33c7ece330d87cc3e684b7f3eba5009e36d74e43cc426b636eb956a6d2c4`.
All 19 configured positions, fluid/1x1 size maps, CMP, bidder settings, floors,
lazy behavior and refresh settings remain in the base. Both arms use the same
vendored Prebid 11.34.0. This is an A/A comparison between those two arms; it is
not an isolated comparison to the historic live Prebid 10.10.0 setup. New cache
and country/CMP behavior are outside this package.

`scripts/prepare-tanjug-aa.mjs` verifies the full readable/minified source hashes
and dependency hash, then creates two identical copies with two additive guarded
insertions: enter exactly once under the new loader, and apply the literal
Variant to each owned slot before any ad request. Existing source files,
version records, packages and old loaders are untouched. The delivery version
is `tanjug-aa-1.0.0`; its base runtime identity is separately reported, never
misrepresented as the newer partial 3.14.1 cache runtime.

The browser picks A/B 50/50 with cryptographic randomness once per document.
The shared static loader is cache-independent and needs no Worker, database,
cookies, storage, IP, country or user identifier. Refreshes/SPA reinsertion and
BFCache restoration keep the document assignment. Full reloads may choose
again. This is page-level assignment, not persistent user bucketing.

Existing async ads.js + prebid.js tags remain supported in either order. The
loader waits for the existing dependency; if only ads.js exists, it loads the
versioned dependency with SRI. A wrong ready Prebid version, duplicate pending
dependency tags, legacy runtime, failed fetch/integrity or timeout stops loading
and exposes an error; it never starts a second arm as a fallback. Child scripts
carry nonce/SRI/CORS. An entry guard also blocks direct arm reexecution. The
already-present HTML dependency is version-checked; it is not retroactively
SRI-verified. A full deployment must include the packaged root prebid.js.

`AdVariant.inspect()` prints release, selected script, Variant, Prebid, runtime
entries, blocked duplicates and actual owned-slot labels. `snapshot()` returns
the same bounded data without logging. It stores no consent strings, bids or
user IDs and sends no telemetry. Script loaded/entry counts are not proof of
filled impressions or revenue. Existing basic debugger in the base is retained.

Production ZIP has assets at its root. Stop ZIP restores the full uninstrumented
base with the same Prebid 11.34.0 and no labels. It is explicitly not a copy of
the old CDN dependency. Exact previous deployment rollback uses Cloudflare
Pages' existing production deployment history; a full reload is needed for
already-open tabs. Never choose the partial two-position deployment as the
complete rollback target.

Build:

```sh
node scripts/prepare-builtin-runtime.mjs
node --experimental-strip-types scripts/prepare-tanjug-pilot.mjs
TZ=UTC node --experimental-strip-types scripts/prepare-tanjug-aa.mjs
node --test tests/runtime/static-aa.test.mjs
```

CI runs native pinned Prebid and both exact compiled arms in Chromium with
synthetic GPT/TCF and blocked external ad traffic. It checks desktop/mobile,
all 19 slots including fluid/1x1, first/lazy/refresh labels, both dependency
orders, ads-only integration, duplicate insertion and failure/SRI handling.
Actual GAM Publisher Console and Funding Choices behavior on live Tanjug are
verified after the user's deployment; no live result or revenue gain is claimed.
