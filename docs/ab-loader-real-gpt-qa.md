# Generic loader: offline real-GPT checks

After the normal locked install and built-in runtime preparation/build, run:

```sh
node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs scripts/prepare-ab-loader-real-gpt.mjs
python scripts/verify-ab-loader-real-gpt.py
```

The verifier needs the repository's pinned Playwright/Chromium setup. Both scripts
default to `.generated/ab-loader-real-gpt`; the preparer accepts `--out <directory>`
and the verifier accepts that directory as its first argument.

The fixture composes two explicitly selected native 3.25.1 GAM-only packages with
the current generic loader. Arm bytes retain their original SRI and hashes. GPT
comes from `vendor/gpt/m202611120201`, verified against its checked-in pins.
Every browser request is intercepted: scripts are local bytes, GAM is local 204,
and other requests are aborted. No publisher configuration or ad account changes.

Eight cases inspect actual `cust_params` and `prev_scp`: clean first requests and
native refreshes, early publisher keywords, modern GPT `setConfig` during CMP
waiting, both slot targeting APIs, expired B before/after A, existing publisher
labels, and a late reserved setter followed by native refreshes. An observational
call-through accessor records startup assignments without rewriting either arm.
Original keyword objects and unrelated page/slot metadata must survive.

`browser-report.json` contains the cases, exact observed requests, startup counts,
checkpoints and errors. `failed-cases.json` is written on success and failure,
including fixture/setup failures. Upload both plus `manifest.json` in CI.

This is GAM-only native runtime and pinned real-GPT serialization evidence. It
does not establish Prebid demand, hosted acceptance, paid impressions or revenue.
The separate native Prebid browser matrix remains necessary for that boundary.
