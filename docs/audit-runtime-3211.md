# Independent audit corrections in 3.21.1

This release addresses MBA-404 and its four implementation issues. It is based
on 3.21.0. The separate bidder-rule feature remains paused. Existing selected
versions and saved packages are unchanged; selecting 3.21.1 is explicit.

## Behaviors to verify

| Audit finding | Corrected behavior | Regression evidence |
| --- | --- | --- |
| SM-1 | An unmatched conditional rule or an action without a map retains the already selected category/page map and independent Prebid map. An explicit map still overrides both. | Generated-function matrix, package round trip, native wrapper checks |
| CTX-1 | The wrapper preserves an existing RTD configuration. A foreign-only or changed provider list produces an actionable diagnostic instead of a false activation claim. All providers configured together before the wrapper can participate in the auction. | Native Prebid 11.11.0 and 11.34.0, intercepted adapter payloads, readable/minified wrappers |
| CRIT-1 | TakeOver frequency storage is consulted only after the current CMP decision permits it. Otherwise the cap stays in page memory. Debug opt-in no longer reads or writes localStorage. | Consent, revocation, storage-denial and generated-code tests |
| SM-2 / GEN-F2 | Saved rule references count as map usage. Rename updates all references atomically; delete explains which references must be removed. Safe validation details survive generation errors. | SQLite/HTTP tests and desktop/narrow interaction checks |
| GEN-F1 | Default/group conditional rules apply to Banner and Sticky. TakeOver/Outstream exclusions are named in output warnings; exact unsupported rules return an actionable error. | Mixed-format generation tests and UI scope explanation |

## Contextual integration contract

The native RTD module consumes its initial provider configuration. A later
`setConfig` merge can change the public configuration without activating the
additional provider. When another RTD integration is present, its first
`realTimeData.dataProviders` list must also contain `contextualSignals`, and the
Prebid bundle must contain both `rtdModule` and the custom
`contextualSignalsRtdProvider` module. The integration kit describes that setup.

Diagnostics distinguish the saved configuration, module metadata, provider
activation and observed auction enrichment. Missing optional support does not
block ads. Synthetic adapter payload evidence proves what the adapter sends;
it does not prove SSP acceptance of a taxonomy or a revenue improvement.

## Operator retest

1. In TEST, explicitly select and save script version **3.21.1**, then generate
   a new package. Confirm the version in its `config.json` and `manifest.json`.
2. Set `window.adsKeywords` before loading the generated script. For the map
   regression, use the configured homepage category, retain a conditional rule
   that does not match, and inspect the chosen map and request sizes. Repeat with
   an explicit matching map override and with no category value.
3. For contextual signals, use the selected supported Prebid bundle and exact
   category mapping. Inspect `window.__AD_CONTEXT.snapshot()` and the selected
   adapter request. Repeat with a combined initial RTD provider list and a
   missing-module fixture; the latter must show an explanation while ads continue.
4. In the map editor, verify rule-only usage, rejected deletion, successful
   rename, and the preserved rule after reopening the editor.
5. For TakeOver, verify pending, outside-scope, consented and revoked CMP states
   against the configured frequency interval. Use synthetic demand for automated
   checks.

Production promotion follows review of the exact TEST build and is a separate
release action. A passing configuration preview alone is not a runtime test.
