# Explicit regional scope during CMP loading — experimental proof

This branch adds test/support code only. It creates no endpoint, publisher setting, shipping timeout or runtime version. Frozen runtime/compiler/registry/defaults and publisher `__tcfapi` remain untouched.

## Concrete branch demonstrated

A publisher explicitly opts a country into its server-owned allowlist (empty by default). The isolated edge handler takes country only from Cloudflare's `request.cf.country`, and returns a private `no-store` JSON reply for the requested site, page ID and nonce. Query parameters and country headers cannot supply geography. EEA countries, GB/UK and CH are denied even if listed; unknown/non-ISO codes are denied. These are conservative experiment constraints, not a finding that every other jurisdiction permits every advertising/storage operation.

The browser fetches a publisher-configured HTTPS endpoint with credentials omitted, no cache and no redirects. It validates actual endpoint origin/path, JSON/no-store response, schema, bindings and timestamps. CORS is not authentication; configured endpoint/TLS is the trust boundary. Tests inject transport and synthetic Cloudflare metadata; no deployed endpoint authenticity has been observed. Same-origin requests may omit Origin; cross-origin calls require the configured publisher Origin.

Freshness is checked both when the reply is received and when a controller adopts it. The reply expires after 60 seconds for adoption/replay purposes. A freshly adopted, immutable scope decision remains tied to that navigation for subsequent refreshes; it is not shut off after 60 seconds and does not cause a geo lookup per slot. A different page ID/nonce or delayed adoption must obtain new evidence. No shared static script, localStorage or cross-page scope cache is used.

With this accepted signal, **ongoing successful `cmpStatus:loading` callbacks whose GDPR scope is unknown** can select regional out-of-scope after an explicitly supplied experimental `waitMs`. Repeated identical loading does not reset the wait. There is no shipping wait default. Silence alone, failed callbacks, a user choosing on an open banner, unknown geography, empty allowlist or binding mismatch cannot activate fallback.

**`gdprApplies:true` while loading is a conflict and does not qualify.** This may be Marko's actual current case; this branch does not claim to fix it. A valid CMP decision, including Reject, takes precedence. Only observed decisions can be preserved: a saved rejection which a broken CMP never returns cannot be discovered by this controller.

## Minimal API

- `handleGeoScopeRequest(request, {siteId, allowCountries, allowedOrigin, now})`: pure synthetic edge-handler proof.
- `fetchTrustedGeo({endpoint, siteId, pageId, nonce, now, fetchImpl})`: fetch once per navigation; returns frozen internally branded evidence or null.
- `createGeoCmpFallback({geo, siteId, pageId, nonce, now, waitMs, onInvalidate})`: `observeCmp`, `snapshot`, `selectNativeMode`, `canRequest(epoch)` and `dispose`.

Select native mode once, **before native initialization**. A current valid CMP decision selects IAB; eligible geographic fallback selects static `{gdprApplies:false}` only. The native fixture maps that data into the documented native Prebid shape. No TC string, acceptance, purpose/vendor grants, NPA setting or publisher CMP overwrite is manufactured. This is a scope decision, not consent to all processing; unrelated privacy requirements remain independent.

After static initialization, a later CMP true/Reject blocks new requests, invalidates the epoch and invokes the clearing hook. The caller must test the current epoch at request and dispatch boundaries and discard old targeting/cache. Already-sent requests cannot be undone. The controller never hot-switches native consent mode or automatically restarts. A prior IAB initialization cannot later become static through this controller.

`observeCmp` assumes events from the current authoritative CMP listener. This module does not itself install listeners or reject events from replaced APIs; generation filtering from the separate recovery investigation must be integrated and reviewed before any product use. The invalidation hook sees committed current state and can safely inspect it.

## Evidence limits and next product boundary

Run `node tests/runtime/geo-cmp-fallback-experiment.test.mjs`. Fourteen deterministic tests cover opt-in activation, continuous loading, protected/unknown countries, origin/endpoint/cache/schema errors, page binding, receipt and adoption freshness, same-page refresh lifetime, true/loading conflict, Reject precedence, late conflict and reentrant invalidation. They establish policy/controller behavior, not an actual GAM request. Native Prebid and actual intercepted GPT evidence belong to the companion fixture, not this document.

A controller-level `ready` result alone cannot open GPT when the existing publisher CMP remains stuck. A future viable integration must resolve publisher-owned regional scope **before initializing CMP/GPT/Prebid**, and supply consistent documented signals to each. That may require changing the publisher CMP's geographic behavior/configuration; the experiment neither replaces its API nor fakes its answer. No end-to-end recovery, publisher compatibility or deployability is claimed here.

## Early publisher-owned startup plan

`planRegionalStartup` is a separate, test-only pre-init contract. It requires fresh verified page-bound eligible geography, `publisherOwnsCmpStartup:true` (an explicit declaration of exclusive startup control), and explicit `existingTcfApi:false`, `existingPrebidInitialized:false`, `existingGptInitialized:false`, `hasObservedCmp:false`. Missing declarations, existing/previously observed CMP, prior native initialization, conflict or stale geography return `{route:'cmp'}`. Only the qualifying branch returns `{route:'regional', consentData:{gdprApplies:false}}`. The caller must consume this plan before any library initialization; it must never delete or conceal an existing CMP to qualify.

This plan does not repair an already stuck CMP and does not implement library injection. It gives the companion native fixture a concrete no-existing-CMP regional initialization branch. Later CMP appearance still requires the controller's invalidation guards and native mode lock. Publisher configuration must actually provide this exclusive startup ownership; it cannot be inferred from the API being temporarily absent.
