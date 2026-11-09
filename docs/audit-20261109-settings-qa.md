# Independent settings QA — MBA-393

Date: 2026-11-09. Baseline: `b88a795`. API/preflight candidate: `1a7af18` (same patch cherry-picked locally as `70c8c7c`). Final integrated runtime lifecycle candidate: `2da5645`, runtime 3.20.0 source hash `a468982d57fce645d55da66c584726cb680d50ba3433578b74fd44e51a453b7a`. This is a bounded audit using synthetic local SQLite data, real worker handlers, saved snapshots and generated JavaScript. No publisher settings, live ad traffic, CI or runtime registry were changed by this QA work.

## Results

| Area | Baseline observation | Candidate verification |
| --- | --- | --- |
| Disabled position with exact bidder override | Save succeeds; Generate incorrectly reports existing disabled `P1` as missing and blocks enabled `P2`. Also reproduced with bidder disabled. | Independently verified in integrated 3.20: disabled/DRAFT rows are excluded only from the generated package, saved override remains, reactivation restores its parameters. Missing targets remain invalid. |
| Per-bidder and keyed floors | Save accepts `1001`; compiler rejects it later. Negative/non-numeric map values could be dropped during save. | Invalid values return 422 before config, batch or audit writes. `0`, `0.01`, `1000` round-trip exactly. |
| Top Sticky / portal | Built-in selection accepts activation; generator deliberately rejects unsupported behavior. | New activation rejected; existing unsupported values survive unrelated edits and can be explicitly cleared. Existing Top Sticky cannot switch to another unit. Legacy template activation remains available. |
| Raw video/native media type | Built-in selection accepts active raw media; generator supports banner units and separately configured Outstream. | Create/change/enable/undraft/copy blocked before writes. Inactive/DRAFT values remain allowed. Existing records preserve their media type on unrelated edits and permit explicit Banner recovery. Legacy create/copy remains available. |
| Disabled override row | Disabled override is ignored during generation. | Actual 3.19 generated-output positive control passes. |
| Timeout inheritance | Default/group/exact layers produce expected effective values. | Actual emitted helper returns `1200`, `2200`, `1200` for Billboard, P1, Sticky. |
| Lazy inheritance | Explicit `false` and zero margins override inherited `true` and positive margins. | Actual emitted `tesseraLazyRule` preserves those values. |
| Bidder override precedence | Global → device → group → exact merge preserves unrelated parameters. | Actual emitted `adUnitFromCode` returns expected bids at mobile viewport. Size/revenue hooks are fixture stubs for this isolated control. |
| Conditional size-map compatibility | Checked assigned, inherited, disabled, unused and legacy-prefix maps. | Six preflight cases pass, including exact position/map/row feedback and explicit Outstream width-only limitation. Full new-runtime size selection is covered by the separate runtime QA. |

## Executed coverage

On the API candidate, **119/119 tests passed**, no skipped tests:

```sh
node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs --test \
  tests/runtime/admin-rules-and-sync-audit.test.mjs \
  tests/runtime/outstream-settings.test.mjs \
  tests/runtime/country-rules.test.mjs \
  tests/runtime/test-workspace-unit-rules.test.mjs \
  tests/runtime/ad-position-runtime.test.mjs \
  tests/runtime/outstream-position-scope.test.mjs \
  tests/runtime/compiler-input-compatibility.test.mjs \
  tests/runtime/reference-bridge.test.mjs \
  tests/runtime/consent-readiness.test.mjs \
  tests/runtime/size-map-compatibility.test.mjs \
  tests/runtime/generator-guard-audit.test.mjs
```

These suites cover refresh ownership and concurrent save conflicts; timeout bounds; country normalization, fallback and version protection; rule route authorization; Outstream verification/renderer guards and Standard/TakeOver coexistence; actual save/reload/generate/reopen artifact flows; compiler input guards; disabled floors; zero/false options; and consent pending/loading/late callback/cancellation behavior. They exercise their own pinned runtime fixtures, not every historical runtime permutation.

The independent added suite contains 13 cases. Its first nine cases were first run on baseline: 5 passed, 4 failed, detecting the guard gaps. All 13 pass after the candidate changes.

Four generated-output positive controls also passed on the API candidate:

```sh
node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs \
  scripts/audit-settings-20261109.mjs --positive-controls
```

The script's default mode is a historical baseline reproducer: it asserts eight original defect/support-mismatch observations and four positive controls. Run that mode on `b88a795`, not as a post-fix CI test. Candidate rejection behavior belongs in `generator-guard-audit.test.mjs`. Local evidence is written under `.generated/qa-settings/` and is not committed.

### UI candidate follow-up

UI commits `511cf58` and `4b67da0` were independently applied over the API candidate. The actual React panels and authenticated local worker were run in Chromium at 1440px and 390px, with every request restricted to the local fixture:

```sh
python scripts/verify-runtime-controls-validation-ui.py
python scripts/verify-inactive-media-ui-qa.py
```

The developer's four desktop/mobile cases passed: invalid global/bidder/keyed floors retain input and show field-specific errors before any PUT; duplicate floor keys cannot silently replace another row; boundary values survive reload; unsupported Top Sticky/portal values are shown, preserved on unrelated save and explicitly removable; raw media error can recover to Banner. Screenshots of the narrow media error and desktop saved-unsupported controls were visually reviewed.

Two additional independent desktop/mobile flows passed: save disabled video; attempt Enable and confirm rejected save leaves both the full persisted row and audit trail unchanged; Cancel and reload retain disabled video; explicitly change to Banner and Enable, restoring the Formats action. No browser page errors or horizontal overflow were observed. At a 390×900 viewport the modal scrolls vertically to its error/actions; scrolling and recovery were exercised. Screenshots are under `.generated/inactive-media-ui-qa/`.

### Final 3.20 package lifecycle follow-up

On integrated candidate `2da5645`, after preparing its registered runtime manifest, four new independent tests passed:

```sh
node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs --test \
  tests/runtime/inactive-override-package-qa.test.mjs
```

The tests select 3.20 through the site settings service, create an exact PubMatic override through the real API handler, then disable the unit or move it to DRAFT. A third case disables both bidder and unit. Generate's HTTP handler produces a stored package; reopening and downloading verifies identical readable, compact, config and Prebid files. Only the other active position is included. Config and stored override rows remain unchanged during generation. After reactivation, a new package includes the position and its exact saved bidder parameters. The earlier package remains byte-identical and no production channel is changed.

A separate corrupted-legacy-data case proves a genuinely missing target still fails before artifact or release writes. The compiler identifies the missing unit precisely. The HTTP wrapper currently reports a generic unsupported-settings message for this corruption; the actionable size-map preflight fix does not generalize all older compiler errors. This is a remaining feedback limitation, not an incorrectly rejected valid configuration.

## Scope and limits

- Historical T17 was reviewed as a migration capability gap: unsupported raw `pageTypeKeys` and absent mobile lazy fields are not relabeled as new regressions. T21 input-compatibility cases pass.
- Existing unsupported values are preserved deliberately. An unchanged unsupported saved value can still block Generate until the user removes it or chooses a supporting script; this audit does not recommend removing protective runtime validation.
- Legacy template tests confirm save/copy compatibility, not execution of every uploaded template.
- No claim is made about buyer acceptance, real GAM delivery, revenue, production consent decisions, or every combination of settings.
- Full size-map viewport/runtime and size-map UI behavior are covered by the other independent QA owner. This settings audit does not claim those checks or a full portfolio/production audit.
