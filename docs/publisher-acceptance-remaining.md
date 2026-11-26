# Remaining publisher acceptance — 3 October 2026

Owner: MBA-171 (reject and Network/GPT evidence). MBA-46 separately owns
complete-release delivery and rollback. This is a collection plan, not evidence
that either remaining test passed or authorization to change a publisher.

## What is already accepted

Politika's delayed acceptance and ATF continuation passed on 1 October. Do not
repeat that scenario. The existing local override package is
`politika-cmp-3.14-20260930.zip`: runtime 3.14, build `20260930_134500`, profile
`tessera-readiness-v1`, original Prebid 11.11.0.

- ZIP SHA-256: `e8b430e9c680de897a911daf0e7c4d821eb29f58aa21969812d0e20363f8b1ac`
- `ads.js` SHA-256: `482e47e59ef16ddd33dbe31331e8e11fcda106faf8d272a820547cec1ebaae76`

This is the special local publisher preview, not a generated complete release.
The known missing `criteoIdSystem` means full Prebid module validation remains
blocked. Do not repair its manifest or substitute a newer script silently.

## One remaining user-run reject capture

Use the existing package and `provera.js` in the user's Chrome Local Overrides
setup for `https://politika.pages.dev/ads.js`. Agents do not open the live page
or generate paid ad requests as an incidental test.

1. Open DevTools Network before navigating. Clear the request list, turn off
   Preserve log, and confirm the overridden response is the package above.
   Use a fresh consent state through the CMP's normal controls; do not forge
   TCF values. If a fresh decision cannot be obtained, stop and report that.
2. While the banner is visible, capture the existing readiness summary. Click
   **Reject all** once and run the same diagnostic after the initial activity
   settles. Do not accept again, scroll, refresh, or click an ad. Record the
   observation interval; the original refresh rules are still active.
3. In Network inspect Google ad requests (commonly `gampad/ads`) and their
   Initiator and Payload. Record requests before the decision and after it,
   and which slots each covers. Grouped/SRA requests may contain several slots;
   request count alone cannot establish one initial request per slot. Separate
   later refreshes and unrelated publisher scripts; report unknown attribution
   as unknown, not a Tessera pass/fail.
4. Send only the small summary below. Disable the Local Override when finished.
   Keep raw request URLs, HAR, cookies, identifiers and consent strings local.

| Summary field | What to report |
| --- | --- |
| Identity | Build/profile/Prebid version; exact override confirmed or not |
| CMP decision | `gdprApplies`, `cmpStatus`, `eventStatus`, and only whether `tcString` is present |
| Timeline | Before/after readiness phase and epoch; `decision-ready` timestamp and first auction timestamp |
| Google dispatch | Per-slot initial counts before/after the decision, observation end time, grouping and attribution limits |
| Wire privacy | For each relevant request: `gdpr`, `npa`, `ltd` values or **absent**; `gdpr_consent` and `addtl_consent` **present/absent only** |
| Outcome | Empty/filled/blocked or error; sanitized error text if any |

The existing readiness snapshot keeps only the latest 100 events. A truncated
log cannot prove that earlier dispatch was absent. Network start times and
readiness timestamps must be aligned to the same navigation before comparing.
Do not send the entire CMP object, vendor maps or raw `provera.js` output without
removing private fields.

Reject can be a valid completed CMP decision: `ready=true` means the decision is
available, not that consent was granted. Preserve native Prebid/GPT enforcement.
An empty auction is not a failure; `completed=true` is not proof of bids or an
impression. Missing `npa`/`ltd` does not by itself prove incorrect privacy
behavior. PM reviews wire observations against the selected GPT/CMP setup before
closing MBA-171; uncertainty remains open instead of adding an NPA bypass.

## MBA-46: prepare the exact complete release, then obtain production approval

Cross-account preview publish and restore already passed on 14 September; use
[the stored receipts](evidence/tanjug-compact-restore/README.md). Their
`completeRelease:false` package is not production acceptance, and the Politika
CMP preview above does not replace it.

Before requesting approval, PM records one selected publisher, destination,
current public version and rollback package. Use existing
`worker/site-runtime/releases.mjs` package verification and
`scripts/pages-release-verification.mjs` source verification: exact release ID,
`completeRelease:true`, runtime/Prebid/config pins, manifest digest and complete
file inventory. Reuse configured secret references; never request token values.
Confirm the target's actual production branch and that the old public bytes
are recoverable. An arbitrary saved ZIP is not an eligible rollback: the current
channel API requires an archived, previously published package with audit history.
If the live baseline has no such package, resolve that recovery plan before
promotion, without relabeling an old preview.

After explicit approval for that publisher and destination, use the existing
Stage → Publish → external production flow, then the existing rollback and
external delivery flow. Internal channel changes alone do not restore Pages.
Retain source/public hash receipts, workflow run/correlation IDs and UI outcome
for both operations. Complete-release delivery currently serves only `ads.js`
and optional `prebid.js` plus Pages `_headers`; source archive completeness does
not mean every archive file is public. The runner verifies the immutable Pages
URL. Acceptance must additionally confirm the real stable publisher URL, matching
bytes, MIME/CORS/cache behavior after publication and after rollback; immutable
URL success alone is insufficient. Use passive file reads, not ad execution.

Do not reuse the old preview profile's `max-age=0`/ETag expectations blindly:
the complete-release runner currently emits `no-store`. If delivery succeeded
but verification/reporting failed, inspect that result and retry only the
appropriate verification/report job, not a second publish.
