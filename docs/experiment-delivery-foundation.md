# Experimental delivery foundation (MBA-57)

Status: isolated implementation, **not connected to any hosted /ads.js**.
Pilot chosen by Marko: Tanjug. CMP: Google Funding Choices / Privacy & messaging,
managed by Marko. No production activation is authorized by this development step.

## Compatibility boundary

`worker/experiments/delivery.mjs` defines a separate `experiment-preview-v1`
delivery profile. The authenticated TEST Worker now imports it for private preview routes only. The main application Worker does not import it. The local fixture Worker
is under `tests/support`, requires an explicit fixture binding and only serves
`experiment.invalid`. It has no production bindings, credentials or deployment config.

Both complete input packages are copied and verified against the existing
manifest and exact package hash. The public asset selection reuses the accepted
publisher layout: original `ads.min.js` bytes exposed as `ads.js`, plus the exact
Prebid file when present. Original ZIPs, runtime records and source files are not
rewritten. A/A can pin the same package in both groups.

The `/ads.js` loader uses per-request weighted assignment and a page-local guard.
Duplicate tags, an SPA re-insertion or a stopped/new revision cannot launch another
runtime on that document. A real new document can receive a new assignment. No
cookie, localStorage, fingerprint or IP identifier is used. Failure never starts a
second runtime after potentially partial execution. `loaded` is a script load event,
not proof of successful ad initialization or a billable impression.

The loader records country only as diagnostic metadata. It does not change
`gdprApplies`, load/hide a CMP or synthesize consent. All dynamic responses prohibit
browser and CDN caching. Public asset paths include the full source package hash;
asset responses are immutable and the entry script has SRI. Config and manifest
files are not exposed. Caller-selected URLs, query overrides and write methods
are not accepted.

## Private TEST controls

The TEST home links to `/experiments`: choose saved A/B packages and B percentage,
save an immutable experiment, then explicitly Start or Stop its private preview.
State and events use the separate `test-experiments/v1/state.json` R2 key, guarded
by revision and conditional writes. A stale tab must refresh; it cannot overwrite
newer decisions. Starting verifies both archives; stopping retains history.
Saving new rules does not change the running experiment. New private loads after
Stop select control A. Existing documents keep their original assignment.

Delivery is login-protected under `/test-api/experiments/preview/<site>/ads.js`.
All private responses, including pinned assets, prohibit shared caching. No public
publisher path is added. These controls are not live traffic activation or revenue
reporting; the interface does not automatically execute publisher ads.

## Verified locally

Run after installing the existing locked dependencies:

```sh
node scripts/prepare-builtin-runtime.mjs
node scripts/prepare-test-workspace.mjs
node --experimental-strip-types --test tests/runtime/experiment-delivery.test.mjs tests/runtime/experiment-workerd.test.mjs tests/runtime/experiment-controls.test.mjs
```

Tests cover allocation boundaries and a controlled 10,000-sample distribution,
A/A and A/B identities, Stop on a new document, duplicate loading, load failure,
country isolation, no consent writes, cache headers, SRI, invalid manifests/pins,
cross-site rejection, caller mutation races, and original Tanjug asset preservation.
The second test uses compiled **local workerd/Miniflare HTTP** with all outbound
traffic forbidden. Loader execution is simulated in Node VM, not a real browser;
this is not a hosted test, live auction, GAM report or revenue result.

## Next integration gates

1. Verify the private editor in CI using `scripts/verify-experiment-ui.py` with
   synthetic storage, loopback TLS, stale tabs and desktop/mobile layouts.
2. Add a separate preview delivery build and verification before any hosted route.
   Do not replace the existing Pages delivery profile or publisher URL by default.
3. Verify real script loading in a browser including CSP, SRI, legacy-tag collisions,
   SPA lifecycle and dependency URLs. Existing packages may rely on separately
   loaded GPT/Prebid or configured absolute paths: these are **not rewritten** by
   this loader. New runtime versions must support pinned dependency loading;
   unsuitable old packages must be rejected for the experiment, not silently edited.
4. Implement MBA-58 assignment/render/error measurement and GAM reportable keys;
   count assigned pageviews even with no-fill or errors. Verify A/A reporting before
   comparing cached bidding strategies.
5. After TEST evidence and explicit activation, use the agreed publisher URL.
   Rollback must restore the original saved package/delivery. No live traffic has
   been changed by this foundation.

## CMP regional proposal (MBA-25)

For Google's European message, use its own targeting preset **Countries subject
to GDPR (EEA, UK, and Switzerland)**, rather than implementing a competing list
in the wrapper. EEA includes the EU plus Iceland, Liechtenstein and Norway.
For other countries, preserve the CMP's applicable regional policy; this preset
does not establish that Serbia or the rest of the world needs no privacy controls.
Unknown geography or unavailable/conflicting CMP data must not produce a forced
false flag. Actual Tanjug settings still need verification before any changes.
US state messages and other applicable obligations remain separate.

Sources checked 2026-09-17:

- [Google message targeting](https://support.google.com/admanager/answer/10076098)
- [Google EEA, UK and Switzerland CMP requirements](https://support.google.com/admanager/answer/13554116)
- [Google EU user consent policy](https://www.google.com/about/company/user-consent-policy/)

New behavior requires new script/runtime releases. Existing release history,
selected versions and Tanjug's active script remain untouched.
