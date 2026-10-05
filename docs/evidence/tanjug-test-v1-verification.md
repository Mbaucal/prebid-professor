# First automatic Tanjug Pages TEST delivery — 2026-09-14

The existing deployment is verified and its original Tessera request confirmed.
No second Pages deployment was created during recovery.

| Evidence | Value |
| --- | --- |
| Target account / project / branch | `6cb2ac6a0a1a0d8b8fc7f9db917cce3d` / `tanjug` / `tessera-test` |
| Actual production branch, checked by Cloudflare API | `main` |
| Immutable deployment | https://276a50d0.tanjug.pages.dev |
| Original Tessera request | `builtin-test-be0c6c81-222a-4d11-8930-0f1e745a1e97` |
| Original deployment run / commit | [34858629084](https://github.com/Mbaucal/prebid-professor/actions/runs/34858629084) / `3052d613eb52838ee4f4e6e1cc7b725ec044d641` |
| Independent verifier run / commit | [34861322056](https://github.com/Mbaucal/prebid-professor/actions/runs/34861322056) / `36651b4bf3fd9ba00abd5aeea1d984e2be9d666f` |
| Public verification | 10 exact files, size/SHA-256/MIME/CORS/nosniff/no-store; 15:19:04 UTC |
| Original ZIP SHA-256 | `eed72a11c2f6db7c90a9ae71f329ba842e34832c91c3e705b1f00469158ba334` |
| Package SHA-256 | `ec1b1c51c870b8e2a5583666c5e48d215cf8c3d3bc3a27549930510856c0d6d0` |
| Manifest SHA-256 | `c94d991269f16b09bbc787c73447d1a2a5cc59df154be169aadae64f6ac6a8cc` |
| Public evidence artifact | `10355270670`, `builtin-reverified-34861322056-1`, expires 2026-12-13 |
| Public artifact archive SHA-256 | `c6073941614699d3bce249f57e911c6b57d45a8e8f6d795702560fe3d37fd997` |
| TEST Worker build / version | `07258bd0-9564-4e28-b65c-a54cdd9de401` / `dedbfdca-04c5-482b-944c-1bdcf9fca6e9` |
| Untouched production main | `ab7b68bbe0bb775a2ec8bcdd5c4f901ef19a1182` |

The initial public verifier rejected Pages' 308 canonical HTML redirect. One
retry of that original verify job reproduced the problem without deploying.
[PR43](https://github.com/Mbaucal/prebid-professor/pull/43) added the narrow HTML
exception and reviewed recovery workflow. Six new local regression scenarios
passed; all six required PR CI checks passed; Code Review completed without
findings at 15:18:23 UTC. Reviewed head `62a43141a4895e00e6116f82c168266992cee3ee`
and TEST merge `36651b4bf3fd9ba00abd5aeea1d984e2be9d666f` share tree
`1336f202c64060bc1c342b6d9c486119a22568b5`.

Recovery verification job `104033990301` succeeded and produced the preserved
receipt. The first report job `104034141683` received HTTP 422. Retrying only
that report job succeeded as `104035040330` at 15:21:52 UTC, using the original
verification artifact. The run finished successfully on attempt 2. No repeated
byte verification, private package generation, Pages deploy or ledger reset was
needed for the report retry. The original deployment run, commit and URL remain
in the row, with separate verifier run/commit audit fields.

The authenticated TEST history was refreshed after confirmation. It displays
“Objavljeno i provereno · poslednja potvrđena verzija”, links the GitHub check to
run `34861322056`, and retains the same immutable Pages URL and package hash.
Publish is disabled with “Izabrani paket je već poslednja potvrđena objava.”
The existing account, project and TEST branch remain visible and unchanged.

Source metadata is preserved verbatim in `tanjug-test-v1-source.json`, and the
public receipt in `tanjug-test-v1-public-verification.json`. The original source
artifact ZIP `10354340938` had SHA-256
`8e013c477c9f91fe80017c0067a149ddfb571a96f0944a2871acd23e24a9d55f`.

Runtime remains `3.9.1-tessera.preview.2`, Prebid `11.34.0`, TakeOver OFF and
`completeRelease:false`. Accepted source bytes and saved ad settings were not
changed. This proves TEST transfer and published byte/header identity, not new
live ad-auction behavior. The user's earlier Tanjug live confirmation remains
separate. A second approved TEST package and real full-package restore are the
remaining acceptance steps for MBA-46/MBA-22.
