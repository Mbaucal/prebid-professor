# Tanjug A/A 1.0.2 — retain TCF integration during CMP startup

Marko's screenshot shows `typeof __tcfapi === 'function'` but Prebid's
`consentManagement.gdpr.enabled === false`. The shipped base selected a disabled
configuration when the API was absent at the earlier setup instant. This is a
startup race consistent with the screenshot, not geo-based CMP suppression.

The new full release explicitly configures `enabled:true`, `cmpApi:'iab'` and
retains the existing `defaultGdprScope:true`, enforcement rules and timeouts.
Its loader discovers the site's real API/stub for up to eight seconds before
starting the selected runtime, retaining the original script URL/nonce through
the asynchronous wait. Pending duplicate loaders share that wait. No artificial
stub, TC string, purpose/vendor grant or country decision is produced.

If the API never arrives, native Prebid still receives the enabled configuration
and handles absent consent; the existing GAM fallback is retained. The explicit
`AdConsent.snapshot().status` is `api-timeout`. A site whose CMP arrives beyond
that deadline needs its CMP loading fixed and a reload; no promise of late
recovery after the deadline is made. API presence alone is not evidence of
usable consent. TC data and enforcement remain the native CMP/Prebid contract.

All 19 positions and identical A/B arms are retained, with minification and the
exact native Prebid 11.34.0 bytes. Old runtime records and 1.0.0/1.0.1 ZIPs stay
unchanged. The new ZIP is `.generated/tanjug-cmp/tanjug-aa-1.0.2.zip`.

Build after the original compact package with `TZ=UTC node scripts/prepare-tanjug-cmp.mjs`.
Unit checks are `node --test tests/runtime/cmp-aa.test.mjs`.
The existing full native-browser harness adds delayed API, missing API and
synthetic in-scope TC-string delivery to actual native bidder requests when
`TANJUG_PACKAGE_DIR=.generated/tanjug-cmp/deploy`. These are intercepted test
responses, not real Funding Choices consent or live bidder calls.

Manual upload replaces the complete Pages deployment; HTML and Variant A/B
values stay the same. The assistant does not deploy or alter GAM/CMP settings.
After upload the native configuration should show `gdpr.enabled:true`.
Whether a TC string is issued still depends on the site's actual Funding Choices
response. This change is not a forced `gdprApplies:true` override.

Reference: https://docs.prebid.org/dev-docs/modules/consentManagementTcf.html
