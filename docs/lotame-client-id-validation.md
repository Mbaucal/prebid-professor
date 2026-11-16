# Lotame client ID validation (MBA-411)

The User ID editor and TEST Prebid plan now accept an enabled
`{name: 'lotamePanoramaId'}` without inventing a client ID. New Lotame presets omit
the old `clientId: ''` placeholder. Existing configurations are not migrated or
enabled automatically.

When supplied, `params.clientId` must be a nonempty string. The string is retained
exactly. Explicit null, blank strings, numbers, booleans, arrays and objects are
rejected before saving. Disabled rows retain unfinished settings as before.
Reading an earlier saved malformed value preserves it and every other User ID,
returns a warning and performs no writes. A subsequent explicit save requires
correcting or omitting the value.

## Upstream contract checked on 16 November 2026

The official module defaults missing `params` to `{}` and appends request parameter
`c` only when `!isEmpty(clientId)`. This was checked at exact upstream tags:

| Prebid tag | Official module | Git blob |
| --- | --- | --- |
| 9.0.0 | [source](https://github.com/prebid/Prebid.js/blob/9.0.0/modules/lotamePanoramaIdSystem.js) | `64d631c2469229ba5b0a6f874c6b4996a6845a90` |
| 11.11.0 | [source](https://github.com/prebid/Prebid.js/blob/11.11.0/modules/lotamePanoramaIdSystem.js) | `69918de3cc1697c7ba44eb300b11462ae2adc507` |
| 11.34.0 | [source](https://github.com/prebid/Prebid.js/blob/11.34.0/modules/lotamePanoramaIdSystem.js) | `1f6479692f8955f473f50038d68e66d9d94c2344` |
| 11.45.0 | [source](https://github.com/prebid/Prebid.js/blob/11.45.0/modules/lotamePanoramaIdSystem.js) | `1f6479692f8955f473f50038d68e66d9d94c2344` |

A local VM check executed these exact module sources with dependency doubles and
no network: missing params, empty params, string `1001`, and numeric `1001`, for
16 passing cases. Only the string adds `c=1001`; the same synthetic GDPR scope and
consent string reach the request in all cases.

The [official integration documentation](https://github.com/prebid/prebid.github.io/blob/master/dev-docs/modules/userid-submodules/lotame.md)
and [11.34.0 typings](https://github.com/prebid/Prebid.js/blob/11.34.0/modules/lotamePanoramaIdSystem.d.ts)
still describe a required string client ID. Runtime support for omission does not
establish vendor enrollment requirements. The catalog retains registration advice
and the editor returns a warning for omission.

String-only validation also corrects a previous mismatch: the old validator
accepted numeric IDs through `String(value)`, but the
[upstream `isEmpty` implementation](https://github.com/prebid/Prebid.js/blob/11.11.0/src/utils.js)
treats numbers as empty, so the native module silently omitted their `c` parameter.
Use the registered ID as a string; no numeric-to-string conversion is performed.

## Regression coverage and limits

- Production handlers: save/reload, compiled native userSync and generated 3.21.2
  output, exact string preservation, invalid input without writes, disabled rows.
- TEST: plan/save/reload, file activation and generated package without a client
  ID; custom ID preservation and invalid input without writes.
- The new production tests run in the existing site-editor workflow; TEST tests
  remain in the existing Prebid editor workflow.
- Existing consent-readiness tests verify pending/unknown/rejected/changed
  decisions without changing runtime or native Prebid enforcement.

This is an admin validation correction. Frozen runtime files, release records,
package locks, saved packages and publisher settings are unchanged. No hosted
TEST deployment, live Lotame request, identifier issuance or SSP acceptance is
claimed by these local checks.
