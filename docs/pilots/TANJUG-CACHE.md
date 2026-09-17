# Tanjug cache pilot — offline review proposal

`tanjug-cache-review-v1` prepares two new 3.13.0 candidate packages for
**Billboard and Sticky only**. It is not deployed, stored as a release or
activated. It does not change the frozen `tanjug-test-v1` package, the TEST
database, existing runtime sources, or live Tanjug delivery.

## Why the full configuration cannot be selected yet

The frozen 14 September source includes `fluid` and `1x1` sizes in the InText
map at all three breakpoints. Runtime 3.13.0 explicitly requires concrete banner
dimensions greater than one. Therefore the full 19-position source is rejected.
The five affected positions are InText_1 through InText_5. Removing those sizes
from a publisher's saved map is not part of this proposal.

The separate two-position proposal retains the original Billboard and Sticky
maps exactly and lists all 17 omitted positions in `review.json` and `review.html`.
It is an intentional small pilot, not automatic fallback from a failed full-site
build. Full mixed-size support needs separate work and, if compiler/runtime logic
changes, a new version rather than editing 3.13.0.

## Comparable arms

| Setting | A — control | B — cache |
| --- | --- | --- |
| Runtime | Exact 3.13.0 pin | Same pin |
| Prebid | Exact reviewed 11.34.0 bytes | Same bytes |
| Positions | Billboard + Sticky | Same positions and maps |
| Mode | `fresh-only` | `auction-with-cache` |
| Maximum bid age | 60 seconds | 60 seconds, also limited by bidder TTL |
| Bidder calls | New auction | New auction, eligible unused old bids may compete |
| TakeOver | OFF | OFF |
| Other settings | Frozen Tanjug bidder IDs, user sync, CMP, floors, currency, schain and refresh | Identical |

The normalized public configurations are asserted equal after replacing only
`bidCache.mode`. This control is **new 3.13.0 without reuse**, not the old live
script. It isolates cache mode, but does not measure all behavior changes between
the old production wrapper and 3.13.0. Two-position results cannot establish
whole-site revenue impact.

The source keeps its 30-second starting refresh, 50% interval growth, 120-second
cap and 20-refresh maximum. Sticky keeps its 30-second interval. The proposed
60-second cache limit is not a refresh change: at longer intervals previous bids
may already be too old. Bidder TTL can exclude them sooner. This is not cache-first.

`plans.aa` uses the identical control package for both arms; `plans.ab` uses the
control and cache packages. Both are **disabled**, with proposed 50/50 allocation.
They are review data for the existing experimental delivery adapter, not a
deployed endpoint or an instruction to load two wrappers together.

## Source and reproducible preparation

The proposal pins `worker/pilots/tanjug-v1.json` by its exact SHA-256 and records
runtime/source/Prebid identity. The preparer copies all input bytes before awaiting
hash checks. Changed source, dependency, runtime, scope or cache rules are rejected
for this reviewed proposal. No network or hosted storage is used.

After the usual locked dependency/runtime preparation:

```sh
node --experimental-strip-types scripts/prepare-tanjug-cache-review.mjs
```

The output directory is `.generated/tanjug-cache-review/`:

- `review.html`: static, responsive comparison with download links; CSP blocks
  scripts, frames and network requests. Opening this review page starts no ads.
- `review.json`: source compatibility, omitted positions, exact package/ZIP/file
  hashes, unchanged settings, disabled experiment plans and remaining gates.
- `tanjug-cache-review-v1-control.zip` and `tanjug-cache-review-v1-cache.zip`:
  complete immutable candidates, including exact original Prebid bytes.
- `README.txt`: preparation/activation distinction.

The ZIPs' `implementation.html` files are real integration examples and can
request ads if served. The actual approved CMP and isolated publisher page must
be established before executing them. The static review never opens those pages.

CI retains a separate `tanjug-cache-review-proposal` artifact containing both ZIPs,
review files and the browser check. Sources in this PR reproduce it after artifact
retention expires. Unit checks verify deterministic bytes, one-rule comparability,
full-source rejection, exact old published ZIP preservation, source/dependency
guards and disabled delivery. Browser checks only render the review and download
ZIPs; they never execute these Tanjug bidder settings.

Verified code commit `911e943fbe2758f771d8e004806a05ed0be9029a` passed all six CI
workflows. [Workspace run](https://github.com/Mbaucal/prebid-professor/actions/runs/35288822304)
passed all five new static review/download browser checks and the existing 19
cache lifecycle, 13 native policy, 14 editor and 35 loader checks. Seventeen local
pilot/history checks and the six-record provenance guard passed. The
[review artifact](https://github.com/Mbaucal/prebid-professor/actions/runs/35288822304/artifacts/10525591665)
contains the two exact ZIPs; it expires on 1 October 2026 and can be reproduced
from the pinned source afterward. No candidate with these actual Tanjug bidder
settings was executed, and no live baseline/CMP/GAM verification is claimed.

## Information still needed for an actual pilot

The available source is the frozen 14 September TEST snapshot. Current live Tanjug
configuration has not been verified in this step. The existing Pages preview CDN
address is recorded in earlier deployment evidence; that does not establish a
publisher test page with a working Google Funding Choices installation.

Before execution, identify the isolated test page URL/hostname and confirm its
actual CMP installation, review the two-position scope and age cap, and compare
the intended settings with the current baseline. Then verify real CMP/GPT,
browser BFCache return, long sessions and instrumented A/A reporting. Only after
that should a measured A/B pilot be activated. No revenue improvement is claimed.
