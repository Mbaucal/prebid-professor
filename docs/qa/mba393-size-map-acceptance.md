# MBA-393 independent runtime QA acceptance

## Verdict

PASS for the reviewed 3.20 behavior: the confirmed 3.19 size-map mismatches and
unnecessary generation blocks covered by this matrix are fixed. This is local
generated-package evidence, not hosted publisher, Google wire, SSP acceptance or
revenue evidence. No production settings were changed and no paid requests ran.

Behavior candidate: root `2da5645`, runtime source `6361ea3` / developer `548bcec`.
Executed descriptor SHA-256:
`a468982d57fce645d55da66c584726cb680d50ba3433578b74fd44e51a453b7a`.
QA integration HEAD recorded by the results:
`82b61a559bc9f41edbc9b37c7831b4e9666af543`.

The subsequent packaging-only correction changed `scripts/prepare-runtime320.mjs`
to a literal source manifest for the strict provenance checker. Independently
checked `git diff 2da5645 4b4bb57 -- worker/runtime-320` is empty. The final release
source is `0da8624fa8e1fe360a3f5edb69a06d752ea4a61d`, descriptor SHA-256
`41d542a0adf9ae22ca557bd4fd36d26dfacd52eee9be5f95a20501e3dd6a4aee`.
Browser cases were not redundantly repeated for that unchanged runtime behavior;
the parent separately ran final hash/provenance and focused release tests.

## Executed checks

```sh
node scripts/isolated-toolchain.mjs prepare
node scripts/qa-size-map-fixtures.mjs 320 --require-pass
python scripts/qa-size-map-browser.py 320 --require-pass
```

- 39 unique configurations: all 37 valid complete packages generated; both
  conflicting exact-coordinate inputs rejected with map and coordinate details.
- All 39 original saved snapshots remained unchanged.
- 238/238 Chromium phases passed across readable and minified scripts.
- Zero browser errors and zero external network attempts.
- Eight additional TakeOver preservation cases passed.

The baseline report remains in `mba393-size-map-baseline.md`. Final local outputs:
`.generated/qa-size-map-320/cases.json`, `browser-results.json`, and
`takeover/browser-results.json`. The matrix records the executed descriptor and
commit so later results cannot silently be attributed to a different runtime.

## What the matrix proves

| Area | Result |
|---|---|
| Direct Banner and Sticky maps | Width and height both participate; duplicate widths with different heights work. |
| Row precedence | Reversed saved order and crossed width/height priorities select the expected fitting row. |
| Missing `[0,0]` | An unmatched viewport makes no ad request; generation records normalization without rewriting saved input. |
| Empty and fluid rows | Empty rows suppress requests; fluid-only rows do not advertise ineligible numeric Prebid sizes. |
| CSS reservation | The matching fixed height follows direct, conditional and legacy page-type maps at desktop/mobile dimensions. |
| Category | Naslovna/article/missing values behave correctly; changing the key after definition does not silently change the selected map. |
| GEO | RS is allowed; DE, unknown and timeout are disabled by the configured Only-RS rule. |
| Inactive draft data | Duplicate coordinates in unassigned maps, disabled-unit maps and disabled mappings do not block active inventory generation. |
| First-request recovery | A never-requested ATF Banner or Sticky starts after a native viewport resize makes its map eligible. |
| Consent during recovery | Resizing while CMP is pending sends nothing; completing the decision then permits the request. |
| Repeated resize | A subsequent resize after first dispatch does not force an extra request. |
| Closed Sticky | Closing before first eligibility prevents later resize activation. |

TakeOver extras used the existing position fixture with `[0,0] → 300×250` and
`[1000,1000] → 800×600`, in both GAM-only and Prebid modes and both script forms.
Fresh 1440×900 pages requested 300×250; fresh 1440×1100 pages requested 800×600.
Exactly one TakeOver GPT request was observed, corresponding Prebid sizes matched,
subsequent resize did not request it again, and placeholder CSS excluded Overlay.
This is eight passing synthetic-browser cases, separate from the 238 matrix phases.

## Limits

- GPT/Prebid/CMP/GEO are synthetic; actual generated scripts run in Chromium.
- The GPT expected-row contract is independently computed; no live GPT mapping
  service or SSP auction was exercised.
- The matrix does not establish general SPA/infinite-scroll behavior or new BTF
  activation semantics. Recovery scope is the reviewed first ATF/Sticky request.
- UI accessibility and save/reload layout are covered by the other QA owner.
- Old source directories 3.19/3.18/3.17/3.16.2 and the shared legacy style helper
  were unchanged in the inspected candidate diff.
