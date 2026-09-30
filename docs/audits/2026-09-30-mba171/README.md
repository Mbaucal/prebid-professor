# MBA-171: consent and request readiness candidate

Version `3.14.0` (`tessera-readiness-v1`) is an explicit selection for newly
generated packages. The default stays `3.10.0-tessera.preview.1`. This candidate
does not migrate site settings, overwrite archived artifacts, change a published
channel or deploy a publisher wrapper. The new source closure extends the frozen
3.13 reporting compiler; every older source hash and release record is retained.

## Behavioral contract

- A successful `gdprApplies: false` TCData callback is ready without fabricated
  eventStatus/cmpStatus fields (the CMP API deliberately omits those outside scope).
- In scope, readiness requires loaded CMP, a completed `tcloaded` or
  `useractioncomplete` event and a nonempty TC string. This is a readiness check,
  not consent-string validation or a legal determination of permission.
- Missing CMP, unknown scope, loading and `cmpuishown` remain pending. There is
  no 1,200 ms listener removal, guessed `gdprApplies=false`, timeout-to-NPA or
  forced nonPersonalizedAds mapping. The persistent listener accepts later
  decisions and changes. Missing API discovery polls locally every 250 ms.
- Rejection is a completed CMP decision. Native GPT consumes the real CMP signal
  and determines limited/no-ad delivery; native Prebid TCF and TCFControl retain
  activity enforcement and `defaultGdprScope: true`. This code does not fabricate
  consent, disable TCF, or assert a particular Google wire parameter.
- Prebid has a 3-second library-readiness deadline after consent. Every request
  path configures a newly loaded Prebid instance before requesting bids, including
  late libraries after the initial ATF GAM fallback and TakeOver before ATF.
- Pre-auction hooks have a distinct 10-second watchdog. The auction's configured
  bidder timeout plus 500 ms watchdog starts only on the matching `auctionInit`;
  a synthetic unique request auctionId prevents unrelated auctions from starting it.
- Completion and fallback settle once. Only a completed current auction can supply
  hb targeting: every hb_adid must belong to a positive bid for this slot in that
  callback. Fallback and consent changes clear stale hb and aq values. Late
  callbacks are rejected before the existing reporting helper can record them.
- A pending decision coalesces deferred GPT requests per slot; destroyed/replaced
  slots are rechecked before dispatch. ATF slots start once. Existing lazy, Sticky,
  TakeOver and GAM-only entry points use the same readiness gate.
- The direct ID5 localStorage-to-PPID copy is disabled in this new version pending
  MBA-108. Configured Prebid ID modules remain subject to native TCF enforcement.

`window.__tesseraReadiness.snapshot()` exposes page-local phase/timing, epoch,
auction ID and slot-code diagnostics. It retains at most 100 events and excludes
TC strings, vendor/purpose maps, user IDs, bids and prices. It sends no telemetry.

## Verification

Reproduce with the checked-in scripts and original vendored Prebid 11.34.0:

```sh
npm ci --ignore-scripts
node scripts/prepare-builtin-runtime.mjs
node scripts/prepare-test-workspace.mjs
node --experimental-strip-types --test tests/runtime/consent-readiness.test.mjs
node --experimental-strip-types scripts/prepare-readiness-browser-fixtures.mjs
python scripts/verify-consent-readiness.py
python scripts/verify-readiness-setup.py
```

The browser harness intercepts every request, uses a controlled CMP, synthetic
GPT and synthetic bidder/currency responses; it never calls paid ad endpoints.
Readable and minified generated wrappers execute with the original Prebid bytes.
Browser results are recorded in `.generated/readiness-evidence/browser-results.json`.
The separate readiness CI workflow runs this harness plus desktop/mobile setup
checks. Node regressions cover listener lifetime, missing/late Prebid, separate
deadlines, current-auction targeting, changed decisions, actual reporting-helper
cancellation, the minimal out-of-scope CMP payload and deferred-request coalescing.

Broader checks exercise old/new Generate/read/download/Pages verification, pinned
selection, concurrent settings changes, old reporting and ad-position behavior.
The new 3.14 package must preserve a previously generated 3.10 package byte for
byte, leave the publisher channel unselected, and retain all seven reporting keys.

Local source checkpoint (2026-09-30): 187/187 selected Node regressions pass,
including 12 readiness regressions and both 3.13/3.14 package flows. Production
Vite/Worker build passes. The append-only history comparison passes and preparation
reproduces every retained runtime source checksum. Frozen generator modules,
vendored Prebid and package-lock bytes are unchanged. The native-Prebid browser matrix passes 34/34 cases (17 scenarios in readable
and minified output), with all bidder/currency traffic intercepted. It includes
changed-decision cancellation, late-bid callbacks, positive targeting tied to
completed native auctions, and exact initial ATF/BTF/Sticky/TakeOver counts.
Desktop (1280px) and mobile (390px) setup checks pass with real React plus local
Worker/SQLite save and reload, 3.10 retained as default, clear unsaved-selection
state, and no page errors, overflow or external requests. See checked-in
[browser-results.json](browser-results.json) and [setup-results.json](setup-results.json).
The root PM visually inspected the setup screenshots before recording acceptance.

## Remaining acceptance boundaries

The first GitHub run passed the new readiness browser job but found four stale
catalog-count assertions in the existing compiled Worker/editor checks. These now
verify the exact four-version list and unchanged default. The three affected local
compiled workerd checks pass (12 selection, 27 Prebid, 17 editor checks). The
targeted editor HTTP suite also passes. No runtime source/hash changed for this
test correction. The combined PM integration of PR109/110/111/112 passes strict
type checks, the production build and 61 targeted security/runtime/package tests;
its single package-test merge overlap retains both security and 3.14 assertions.
The existing browser history check also now expects five retained records with
four selectable builds, and explicitly checks that 3.14 is first. Its full
loopback-TLS browser run remains a GitHub CI gate; this workspace's browser proxy
does not support that DNS remapping. The separate intercepted 3.14 setup and
runtime browser checks above do run locally.

Hosted publisher TEST with the actual CMP and Google GPT is required before
production promotion. Offline tests cannot verify Google request privacy fields,
real ad delivery, fill rate or revenue. The saved-package Test page has no
publisher CMP; 3.14 correctly remains `cmp-missing` there until a real approved
CMP is present. Do not inject fake consent to make that page appear successful.

The pre-auction watchdog cannot cancel external work already started by Prebid;
its late result cannot re-enter this wrapper's targeting or duplicate initial GAM
requests. Native TCF enforcement remains responsible for bidder activities.
Inherited refresh scheduling counts scheduling attempts before actual GPT dispatch;
a long reopened CMP UI can therefore consume a refresh cap despite request
coalescing. This change does not claim to redesign refresh caps or the global
mixed-owner GPT refresh patch. Those remain separate audit follow-ups.

Only the new release record's sourceCommit is finalized after the exact source
tree is published to GitHub; it must reference a remotely available source commit,
not an unavailable local-only SHA. Run the append-only provenance gate after that
registration update. No historic sourceCommit or checksum may be rewritten.

Primary references:

- https://docs.prebid.org/dev-docs/modules/consentManagementTcf.html
- https://docs.prebid.org/dev-docs/publisher-api-reference/requestBids.html
- https://developers.google.com/publisher-tag/samples/display-limited-ad
- https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/IAB%20Tech%20Lab%20-%20CMP%20API%20v2.md#tcdata
