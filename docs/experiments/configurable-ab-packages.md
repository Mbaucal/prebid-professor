# Configurable A/B packages

The `tanjug-configurable-ab-v1` compiler builds a new, complete nine-file package
from the accepted Tanjug CMP package and its hash-pinned readable source. It does
not read or change hosted settings, publish a package, or modify a frozen runtime.

The main dashboard exposes **Tanjug → Releases → A/B testing**. An authenticated
operator can configure both arms, generate a new immutable package, restore saved
settings and download a checksum-verified ZIP. The editor uses the reviewed Tanjug
domain and GAM path; it stays hidden for other sites. Opening the form is read-only.

Generation and download do not publish. Upload the complete ZIP to the existing
Tanjug Cloudflare Pages project to activate it. The editor does not claim to know
which manual Pages deployment is live. The accepted A/A 1.0.2 ZIP remains available
under the starting-point details as a fallback.

## Settings

`worker/experiments/package-settings-v1.mjs` is the strict shared editor/compiler
contract. Unknown fields and unsupported modes fail instead of being ignored.

| Setting | Meaning |
| --- | --- |
| B traffic percentage | Integer 0–100; A receives the remainder, once per document. |
| Arm mode | `fresh-only` or `auction-with-cache`, independently for A and B. |
| Refresh seconds | `null` preserves reviewed position rules; integer 1–7200 explicitly sets a fixed standard interval. |
| Maximum bid age | Cache arms only, integer 1–300 seconds, still subject to the original bid TTL/native checks. |

A manual interval applies to mobile, desktop, sticky timers and the rule consulted
at the refresh boundary. Existing enabled/excluded positions, page activity,
viewability, advertiser exclusions and maximum refresh counts remain enforced.
An interval is a minimum scheduling condition, not a guaranteed wall-clock request
cadence: batching, consent and auction latency can delay the GAM request.

There is no adaptive ready-bid interval or campaign classification in this profile.
Both require separate validation before appearing as enabled controls in the editor.
The default keeps the reviewed refresh schedules for both arms, allowing a cache
comparison without changing cadence at the same time.

## Identity and output

The release suffix fingerprints canonical settings, pinned source/assets, compiled
arms and the compiled loader template. Identical inputs build identical ZIP bytes.
Changed settings or compiler output produce a new release directory and arm SRI.
Build metadata stays outside the public deployment directory. The CLI refuses to
overwrite an existing release with different bytes.

Public targeting remains exactly `Variant=A` or `Variant=B`. The existing
`AdVariant.snapshot()` additionally reports the assigned mode, traffic split,
configured refresh seconds (`null` means preserved rules) and cache age limit.
The dashboard's copied Debug inspector exposes these settings through a bounded
allowlist, including the distinction between a fixed interval and baseline rules.

## Hosted generation and storage

`/api/publishers/:site/ab-experiments` requires authentication; POST additionally
requires the same Origin. The body is bounded to 4 KB and validates the shared
settings schema, note length and site/baseline revision. The site identity is
rechecked after compilation. The service changes no publisher configuration or
delivery channel and requires no database migration.

R2 archives and records are written conditionally, then verified by size and hash.
The record is registered only after the full ZIP has been verified. Identical
settings return the original package, date and note; changed settings produce a
new release. A corrupted or incomplete existing package cannot be overwritten.
The UI shows short release labels with full identities in wrapping details.

Build preparation captures canonical runtime templates before Vite processes the
Worker. Hosted generation therefore does not depend on bundled function.toString()
formatting. Integration tests require the compiled production Worker to return the
exact same ZIP as the offline compiler. The browser runtime test consumes that
downloaded archive, rather than a separately generated approximation.

## Development command

After preparing the reviewed pilot and CMP package:

```sh
node scripts/prepare-configurable-ab.mjs
node scripts/prepare-configurable-ab.mjs tests/runtime/configurable-ab-settings.json
node --test tests/runtime/configurable-ab.test.mjs
```

The second command is a synthetic verification fixture with 10-second refresh on
both arms. It is not a recommendation or an automatically activated live test.
CI exercises this exact minified package with native Prebid 11.34.0, synthetic
GPT/TCF and external ad traffic blocked, including real scheduled refreshes below
the former 30-second value. This verifies delivery mechanics, not live revenue.

## Integration remaining

1. Reviewed input baselines for other sites, including their current inventory,
   bidders and Prebid builds.
2. Adaptive ready-bid refresh and campaign classification, separately from the
   standard interval already configurable in this editor.
3. Direct publication of the same saved bytes, plus verified active deployment
   status. Until that path exists, activation uses manual whole-ZIP upload.

Initial scope is the reviewed Tanjug baseline. Replacing its inventory, bidders or
Prebid build requires a new reviewed baseline, not silently mixing current site
settings into this frozen input.
