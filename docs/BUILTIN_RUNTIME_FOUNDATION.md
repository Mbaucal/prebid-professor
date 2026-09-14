# Built-in runtime foundation — MBA-44 / MBA-45

This draft is the first implementation step, not an enabled runtime release.
No Worker routes, databases, production bindings, public scripts or operator UI
are changed. The existing upload-based generator continues to work until the
complete built-in path is wired and accepted. Never mark this branch Stable.

## Implemented

- Pure exact-version pins: runtime ID, version, bundle hash, configuration schema
  and explicit capabilities. Neither `latest` nor `stable` can be stored as a
  version. Promoting a channel does not change existing pins.
- Changed bytes/capabilities or an incompatible schema cause an explicit error;
  no fallback silently substitutes a newer engine. Preview selection is opt-in.
- A developer migration tool extracts only `buildScript` from the approved
  v3.9.1 reference. It replaces its Apps Script clock dependency with an explicit,
  validated UTC build timestamp. It does not execute or modify the browser code.
- An offline verifier compares complete browser output byte-for-byte, checks
  repeatability, parses JavaScript without executing it, and compares validation
  errors with the approved original. It does not claim to test ads in a browser.

## Reproducible commands

The dependency-free foundation tests run in the PR workflow:

```sh
node --test tests/runtime/foundation.test.mjs
```

The following developer-only commands use the original conversation attachment
`Pasted text(2).txt`. This is not an operator upload requirement. The full reference
has not yet been vendored into this repository; CI foundation tests do NOT run or
claim to run these parity checks without it. A missing/different input fails; it
is never treated as a pass.

```sh
node scripts/extract-reference391.mjs /path/to/reference.txt /new/path/reference391.mjs
node scripts/verify-reference391.mjs /path/to/reference.txt reference-parity-report.json
```

Approved reference SHA-256:
`40e1ac4e546f0786fff95e236d9fd5fab36fcdf57ff3ff22ce8198c4751aea57`.

On the original attachment, local verification passed eight valid configurations
and four invalid configurations. The generated candidate is a normal ES module,
not a runtime `eval`/`new Function` loader. The original browser output, including
TakeOver, remains unchanged for the same configuration and timestamp. That also
preserves existing reference limitations; parity is NOT an endorsement of every
existing behavior. The generated module is not connected to the live app yet.

## Still required before operator acceptance

1. Vendor the reviewed source and generated candidate with verified hashes; the
   new module's hash must cover the complete bundled engine, not just the input
   reference. These metadata helpers are not a code-signing/authentication layer.
2. Map existing Tessera configuration to the candidate and preserve advanced
   refresh, consent, bidder overrides, IDs, floors, maps and GPT-only behavior.
3. Connect the built-in registry to generation/release APIs and the version picker
   without changing legacy release references or silently choosing a newer version.
4. Verify real browser/GPT/Prebid behavior, readable/minified artifact equivalence,
   standard sticky, TakeOver and cross-account staging/rollback on isolated data.

## Geo decision

Geo is optional and is not a pilot prerequisite. At auction start, use an already
available country signal or standard sticky immediately. No global geo wait is
added. The separate Worker endpoint is an alternative to measure, not a proven
performance defect. Prefer existing publisher edge/HTML/bootstrap data where
available; do not personalize a shared cached `ads.js` with one visitor's country.
TakeOver delivery targeting stays in GAM. Geo does not alter CMP/consent decisions.
