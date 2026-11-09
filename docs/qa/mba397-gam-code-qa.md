# MBA-397 independent inventory QA

## Observed baseline

At MAIN `b88a7950bc16b6ab18fd0d2d6fe9118f7cbaff6e`, the actual
`previewCsvImport` handler rejects both `m.box_3` and `m.InText_1` with the
letter-first / underscore-dash-colon validation message. `applyCsvImport`
returns HTTP 422 and writes no inventory rows. The reproduction uses the
repository SQL migrations with local in-memory SQLite, not a mock validator.

The same restriction also existed in manual inventory writes, the TEST editor,
and the historical runtime snapshot/bridge/CSS generators. Fixing CSV alone is
not sufficient evidence for a working generated publisher script.

## Inventory and TEST storage checks

Executed against the shared GAM helper from `1289039`, UI/API correction from
`3b9a2e9`, and own-overlay lookup correction from `f9b2c96`:

```sh
node --experimental-strip-types \
  --experimental-loader ./tests/support/ts-extension-loader.mjs \
  --test tests/runtime/gam-code-import-regression.test.mjs \
  tests/runtime/site-draft.test.mjs
```

Result: **83 tests passed, zero failed**.

- Actual CSV normalization, preview, apply, update, and list preserve 32 legal
  identities, including periods, a leading digit, permitted punctuation,
  double quotes inside RFC-quoted CSV, backslashes, Unicode letters, and the
  100-character boundary.
- Repeated CSV application updates the original SQL record IDs without creating
  underscore substitutes. `m.box_3` and `m_box_3` stay distinct.
- Manual create, edit, and duplicate accept the same code policy.
- Fourteen invalid inputs, including whitespace, control characters, a leading
  slash, excessive length, and markup/attribute injection strings, reject the
  entire CSV before inventory or audit writes.
- `__proto__`, `constructor`, `prototype`, and `toString` remain ordinary stored
  values. Object prototypes are unchanged.
- The TEST transaction saves/reopens punctuation and prototype-like codes,
  preserves their own lazy rules, and treats a repeat save as a no-op.
- The new reopen test found a real inherited-property bug: an empty overlay map
  treated `constructor` as a TakeOver. It failed before `f9b2c96` and passes after
  checking own properties.
- Existing rollback, stale revision, concurrency, slot/map, and TakeOver
  validation checks pass. Old assertions rejecting the now-legal literal
  `../../other` and `constructor` were replaced with actual GAM-invalid inputs;
  positive tests verify the previously rejected identities.

## Limits

These results cover real application handlers and local SQL transactions. They
do not establish generated runtime behavior, native GPT/Prebid delivery,
publisher deployment, or hosted authentication.

A native Chromium HTML/CSS escaping run was attempted but not executed: the
environment has Playwright without its browser, and the browser download
returned a truncated/invalid archive. This is an environment limitation, not a
passing browser check or a product failure. The generated runtime/browser
review must be reported separately before release.
