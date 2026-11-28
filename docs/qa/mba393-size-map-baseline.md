# MBA-393 independent runtime QA baseline

Source: MAIN `b88a7950bc16b6ab18fd0d2d6fe9118f7cbaff6e`, runtime 3.19.0.
Date: 9 November 2026. No production code, publisher settings or paid ad traffic changed.

## Executed checks

```sh
node scripts/bootstrap-toolchain.mjs
node scripts/isolated-toolchain.mjs prepare
node scripts/qa-size-map-fixtures.mjs 319
python scripts/qa-size-map-browser.py 319
```

The fixture preparation builds complete actual packages, not isolated helper copies.
It preserves and checks source snapshots, then runs both readable and minified output
in Chromium. All external network is blocked. GPT, Prebid, CMP and GEO responses are
synthetic. The GPT comparison emulates the largest fitting width/height row contract;
this is not a Google or SSP wire-acceptance check.

Generated evidence is `.generated/qa-size-map-319/cases.json` and
`.generated/qa-size-map-319/browser-results.json`.

33 configurations were attempted. Nine Banner configurations were refused at build
time. Twenty-four configurations generated, giving 144 browser phase checks across
readable/minified output and 1440×900, 1440×1100, then 390×900. Twenty-six checks reported
failures. Source settings were unchanged in all 33 preparation attempts.

## Findings and classification

| Configuration | Observed result | Classification |
|---|---|---|
| Banner height maps | Generate rejects with generic `Height-based size-map breakpoints are not supported by this candidate.` | Unsupported 3.19 capability; UI/preflight should make it explicit rather than failing late. |
| Conditional Banner height map | Generate rejects with the separate unique-width/height-zero error. | Same capability limitation through another path. |
| Sticky `[0,0] → 320×50`, `[768,1000] → 728×90` at 1440×900 | GPT fitting row is 320×50; actual Prebid unit advertises 728×90. | Confirmed runtime mismatch, not malformed input. |
| Sticky duplicate width, different height | At 1440×1100, `[768,1000] → 970×90` is eligible but Prebid remains 728×90 from `[768,0]`. Reordering saved rows does not fix it. | Confirmed runtime mismatch after height resize. |
| Sticky upper height row empty | At 1440×900 the lower 320×50 row is eligible, but neither auction nor GPT request starts. | Confirmed unintended suppression. |
| Sticky lower row fluid | At 1440×900 a fixed 728×90 Prebid size from the ineligible tall row is advertised. | Confirmed runtime mismatch; fluid does not justify a different fixed size. |
| Sticky no fallback row, only `[768,1000] → 728×90` | At 1440×900 there is no fitting row, but Prebid and GPT request. | Confirmed request outside the configured viewport. |
| Sticky conditional height map | Same mismatch as direct assignment. | Confirmed bug through conditional map selection. |
| Exact duplicate `[w,h]` pairs | Sticky accepts two conflicting rows at the same coordinate. | Ambiguous input should be rejected; do not treat its arbitrary output as a supported feature. |
| Banner legacy `pageType=home` prefix with height map | Base `P2` is width-only, but `home_P2` has height breakpoints. Generate succeeds; at 1440×900 Prebid sends 728×90 while GPT fits 320×50. | The height restriction can be bypassed through effective prefix-map selection; confirmed runtime mismatch on Banner too. |
| Banner legacy width-only prefix | Effective home map is 970×250 but CSS reserves 90 px from the base map; mobile is 300×250 but reserves 50 px. | Confirmed placeholder mismatch; CSS must follow the effective map. |

The empty-upper-row fixture also remained silent on later resize to 390×900, where
the 320×50 row becomes eligible again. The initial suppression prevents a future
request from starting. This is recorded separately from map-size parity; no claim
is made that existing runtime resize behavior is generally complete.

## Passing controls

- Width-only Banner/Sticky maps.
- Crossed width/height priorities where the wider fitting row must win.
- `category=Naslovna`, article category and missing category fallback; changing the
  category after slot definition does not change its selected map.
- Only-RS rules: RS allowed, DE/unknown/timeout disabled.
- Pending CMP makes no ad requests; completed decision resumes Banner and Sticky.
- No browser errors, no external network attempts.

## Candidate verification

The same scripts accept a runtime suffix such as `320`. For a candidate, use
`node scripts/qa-size-map-fixtures.mjs 320 --require-pass` and
`python scripts/qa-size-map-browser.py 320 --require-pass`. The fixture gate requires
all supported inputs to generate and exact duplicate coordinates to be rejected;
the browser gate fails on any mismatch. It must not silently skip rejected valid
fixtures or count an unexecuted live check as a pass.
