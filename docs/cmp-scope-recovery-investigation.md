# CMP recovery and known out-of-scope traffic — investigation

MBA-25 / MBA-190, 3 October 2026. Read-only baseline: main `685d90b`.
No runtime change, country list, new version or deployment is proposed here.

**Recommendation:** first test recovery of the existing CMP connection. If the
CMP never works, a positively established out-of-scope pageview can follow an
explicit publisher policy without inventing consent. Current Tessera has no
independent geographic scope input to make that decision yet.

## What the code currently does

| Area | Finding |
| --- | --- |
| Readiness | `worker/runtime-readiness-v1/browser-readiness.mjs`, `accept`: successful CMP `gdprApplies:false` releases waiting work without requiring a TC string. Unknown scope does not. |
| Recovery | `discover` polls while `__tcfapi` is absent and retries a thrown registration. After a registration succeeds it stops discovering: a silent, non-forwarding stub replaced later is not automatically reattached. |
| Prebid | The approved reference builder uses IAB TCF with `defaultGdprScope:true` when an API exists. Its no-API configuration is disabled, but 3.14's outer readiness gate prevents missing-CMP traffic reaching initial startup. Simply changing a Prebid timeout/default cannot open that outer gate. |
| GPT | `worker/runtime-readiness-v1/compiler.mjs`, `compileReadiness`, removes legacy NPA overrides and leaves GPT to consume the actual CMP decision. Its `startATF` and dispatch paths wait for readiness. |
| Other privacy paths | The reference has legacy USP/GPP helper code, but 3.14 replaces `resolveConsent`, so that old fallback is not evidence of a working modern regional privacy integration. Inventory actual GPP/US, storage, user-sync and GPT privacy settings before broadening traffic. |
| Geo | Search of tracked Worker, browser and script sources found no `request.cf.country`, `CF-IPCountry` or country routing input. The decoded reference also has no country branch. MBA-25's dynamic loader/endpoint remains planned; static Pages files do not currently supply this input. |

The builder was decoded in memory and its approved SHA-256 verified:
`2f0e5c93a9c1dc2137fac63e08d0b0f493f74b91c5df4419a8403886d28b91ec`.
See `vendor/reference391/README.md` and `scripts/prepare-builtin-runtime.mjs`.
This was source inspection, not a publisher browser test.

## Scope is different from permission

`gdprApplies:false` says this pageview is outside that framework's scope. It does
not say the visitor accepted tracking, authorize fake purpose/vendor grants, or
turn off every other privacy setting. Prebid's official
[CMP best practices](https://docs.prebid.org/dev-docs/cmp-best-practices.html)
supports publisher-aware out-of-scope configuration, including a CMP returning
false or aligned Prebid configuration when the CMP is geographically omitted.
It warns against a global false default because timeouts would inherit it.
The [TCF module documentation](https://docs.prebid.org/dev-docs/modules/consentManagementTcf.html)
describes `defaultGdprScope` as the fallback when the CMP does not supply scope;
it does not discover geography. Check behavior against the exact installed
Prebid builds (including the existing 11.11.0 package), not only current docs.

Cloudflare [provides country on the incoming Worker request](https://developers.cloudflare.com/workers/runtime-apis/request/),
which is a possible future input, not a browser signal already integrated here.
Use a trusted server result for this navigation and an explicit publisher policy;
do not infer scope from language, timezone, a query flag or silence. Do not put
per-visitor country into a shared static script/cache, reuse it from a prior
pageview, or cache a failed/unknown lookup as false. Prefer an existing trusted
publisher/CMP signal; otherwise measure a small dynamic bootstrap/endpoint.

Proposed precedence for an isolated experiment: an authoritative CMP response
wins over geographic fallback. If a late CMP says true or changes a decision,
stop newly queued work, invalidate old targeting/cache and let the current CMP
decision control resumption. An already-sent request cannot be undone; therefore
the race must be tested before enabling fallback, not described as retroactively
safe. Missing, stale or conflicting geographic data stays unknown.

Google [distinguishes CMP-driven and manual Limited Ads](https://developers.google.com/publisher-tag/samples/display-limited-ad).
Manual Limited Ads requires its dedicated GPT URL; a timeout followed by an NPA
flag is not the same mechanism. Existing
[GPT privacy settings](https://developers.google.com/publisher-tag/samples/configure-privacy)
such as age treatment or restricted data processing must remain independent of
the GDPR-scope decision.

## Small experiment before any version proposal

Use the current isolated readiness harness and synthetic demand; intercept every
network request. First measure no API → late API, same stub → late callback,
non-forwarding stub → replacement API, thrown registration → recovery, and
loading → usable decision. A recovery candidate must ignore obsolete callbacks,
keep one active listener and release each initial slot once. Waiting for a user
on an open banner remains distinct from a broken CMP connection.

Only after that, test a proposed scope policy with synthetic trusted input:
explicit false / true / unknown; missing or stale geo; late CMP disagreement;
reject and later withdrawal; separate regional privacy controls. Compare wrapper
readiness, native Prebid behavior, storage/user-sync activity and mocked GPT
dispatch together. Preserve old runtime hashes. No country list, publisher
configuration change or new runtime registration follows automatically from
these results; PM first reviews the demonstrated behavior and remaining gaps.
