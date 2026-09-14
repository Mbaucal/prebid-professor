# Tanjug compact delivery and historical restore — 2026-09-14

The user requested only minified `ads.js`, original `prebid.js`, and `_headers`
on Cloudflare, retaining current publisher URLs. PR44 implements this delivery
layout without modifying the accepted source archive, settings or runtime.

## Reviewed and deployed code

- [PR44](https://github.com/Mbaucal/prebid-professor/pull/44), reviewed head
  `408b68b437cc46d806c1b46fbabc08f4e77e2f9d`.
- TEST merge `d2ffb7da20311e4919ceedbf48bc7d99224e4b78`, tree
  `4bada238911ee26e10d72bb21c1009b308fe1920` (same as reviewed head).
- Five new focused local delivery tests passed. All six required PR CI checks
  passed. Code Review completed at 15:47:36.997 UTC with no inline findings.
- Tessera TEST Cloudflare build `60647d56-2649-4e20-8882-95e38758364b`,
  Worker version `7b4f882b-36d0-4d5b-b655-47f994bd8dec`, success.

## Actual Pages operations

Target account `6cb2ac6a0a1a0d8b8fc7f9db917cce3d`, project `tanjug`,
preview branch `tessera-test`. Cloudflare API confirmed actual production branch
`main` before every deployment. Each operation was initiated through the
authenticated Tessera TEST UI; all deploy, verify and report jobs succeeded on
their first attempt. No retry or manual ledger reconciliation was needed.

| Operation | GitHub run | Immutable deployment | Public layout |
| --- | --- | --- | --- |
| Publish compact | [34864698144](https://github.com/Mbaucal/prebid-professor/actions/runs/34864698144) | https://99b7390d.tanjug.pages.dev | 2 JS + headers |
| Restore original | [34865064215](https://github.com/Mbaucal/prebid-professor/actions/runs/34865064215) | https://b798c608.tanjug.pages.dev | 10 original files + original headers |
| Restore compact | [34865304443](https://github.com/Mbaucal/prebid-professor/actions/runs/34865304443) | https://f9b56105.tanjug.pages.dev | 2 JS + headers |

All three runs used TEST merge `d2ffb7da20311e4919ceedbf48bc7d99224e4b78`.
The final stable alias is `https://tessera-test.tanjug.pages.dev` and its compact
bytes were verified. Authenticated history showed the final restore as
“Objavljeno i provereno · poslednja potvrđena verzija”, linked to run 34865304443.
The same compact package cannot be republished while it is current. Historical
full-layout rows remain available for restore.

Compact checks covered exact JS SHA/size/MIME, CORS, nosniff, noindex,
`public, max-age=0, must-revalidate`, ETag/304, and absence of excluded source files
on both the immutable URL and stable preview alias. Full restore checked all ten
original files and original no-store headers on both URLs. `_headers` is parsed
by Pages and is not a public downloadable file.

The six original source/public JSON receipts are preserved beside this document.
`artifacts.json` records GitHub artifact IDs, downloaded ZIP SHA-256 and extracted
JSON SHA-256. Every archive digest was verified before copying its one JSON file.

## Preserved identities

- Source package: `ec1b1c51c870b8e2a5583666c5e48d215cf8c3d3bc3a27549930510856c0d6d0`.
- Original ZIP: `eed72a11c2f6db7c90a9ae71f329ba842e34832c91c3e705b1f00469158ba334`.
- Source manifest: `c94d991269f16b09bbc787c73447d1a2a5cc59df154be169aadae64f6ac6a8cc`.
- Compact delivery: `19553aba155e5ce0be6942b06d1b9a3fe7f9d113f10cc8fb872137a9c753d525`.
- Full delivery: `0636bd773cc023c555f53d9a24839460d7a61b1f3127e028f73d5672d80fd7b1`.
- Compact header bytes: `dfec450085218c24c7feaf06098ebe94aca8ea5ccfff4e0bf25cfad04d070165`.

The first and restored compact descriptors are exactly equal. All three source
receipts retain the same original ZIP, runtime `3.9.1-tessera.preview.2`, Prebid
11.34.0, settings and `completeRelease:false`. TakeOver remains OFF. The delivery
profile is versioned independently; no second source configuration was generated.

## Production boundary and remaining work

No production deployment, repository main merge, source upload replacement or
settings reset occurred. GitHub main was read again after the TEST sequence and
remained `ab7b68bbe0bb775a2ec8bcdd5c4f901ef19a1182`.

The read-only production baseline is in `../tanjug-compact-live-baseline.json`:
live `ads.js` already matches the accepted minified source (122756 bytes,
SHA `62fc33c7ece330d87cc3e684b7f3eba5009e36d74e43cc426b636eb956a6d2c4`).
Live `prebid.js` was 10.10.0 (288642 bytes,
SHA `c201f89c622fe33ff5131741750b2d07cf089414b01b8b609efee3ad8ba745b4`),
not the TEST 11.34.0 build. A later local read-only CDN recheck returned HTTP 403;
no post-sequence production byte verification is claimed. Reading publisher HTML
also returned 403 earlier; no browser auction validation was attempted.

Next stage is a reviewed production promotion path for the exact verified files,
with the current live version preserved for rollback, and validation of the
selected Prebid build in its live publisher context. Existing site URLs remain
`https://tanjug.pages.dev/ads.js` and `https://tanjug.pages.dev/prebid.js`.
TEST guards are still enforced; this evidence does not authorize bypassing them
or relabeling the source manifest as a complete production release.

No repeat of completed builder/upload/template/ZIP/user ad tests is required.
Shared Cloudflare and runner secrets already work; do not request them again.
