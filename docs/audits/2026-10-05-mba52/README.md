# MBA-52: dependency audit and frozen-lock blocker

**Unresolved. No root dependency upgrade or vulnerability suppression is shipped.**
Base: main `685d90b`. Fresh npm registry audit on 2026-10-05 reports six high
package nodes, zero critical; production-only reports zero. These are not six
independent exploits or evidence of account compromise. The three parent nodes
Cloudflare Vite plugin, Wrangler and Miniflare inherit findings from their tree.
Full machine reports are alongside this document.

## Exposure assessment

| Component | Locked / fixed | Conditions and observed usage |
|---|---|---|
| Nano ID | 3.3.16 / 3.3.18 | Zero-size custom generators can loop. Installed PostCSS `lib/input.js` imports `nanoid/non-secure` and calls `nanoid(6)`, not the vulnerable custom generator. No application import found. This observed path does not meet the advisory trigger; it is not a blanket exemption for arbitrary plugins. |
| Sharp | 0.35.2 / 0.35.4 | Untrusted HEIF/AVIF processing can reach vulnerable libheif, including possible RCE under the upstream conditions. Miniflare contains image transform/metadata handlers calling Sharp on request bodies. No application Sharp import or Images binding was found in checked configurations. Exposing an image-enabled development service to untrusted input would change that assessment. |
| Undici | 7.28.0 / 7.29.1 | Actual Miniflare fetch and Pool usage exists. High findings require a shared cache interceptor with malformed upstream cache directives, an Undici WebSocket handshake with an unrequested subprotocol, or BalancedPool with function-valued custom TLS verification. No direct app import or Miniflare calls to shared cache/BalancedPool/Undici WebSocket were found in the inspected bundle. This is bounded code inspection, not a whole-program reachability proof; bundled tool code and future configuration can expose additional paths. |

Other Undici advisories in the complete report cover retry, decompression, cookie,
cache and response parsing conditions. Upgrading to 7.29.1 covers the reported
ranges; none are hidden. Build/deploy tooling handles network traffic and may run
with credentials, so production-only zero does not make this risk irrelevant.
No permanent exception is approved here. Until a reviewed upgrade is possible,
keep local tooling bound to trusted/local environments, do not process untrusted
images or enable affected cache/custom TLS/WebSocket paths, and do not run
untrusted builds with deployment credentials. These conditions reduce exposure;
they do not remediate installed packages or prove an absence of exploitation.

Primary maintainer evidence:

- [Nano ID patch release](https://github.com/ai/nanoid/releases/tag/3.3.18) and [advisory](https://github.com/advisories/GHSA-2v37-7h3g-55p8).
- [Sharp maintainer advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).
- Undici maintainer advisories: [shared cache](https://github.com/nodejs/undici/security/advisories/GHSA-4cwx-7wf7-3272), [WebSocket](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5), [BalancedPool](https://github.com/nodejs/undici/security/advisories/GHSA-w293-vg96-wgc3).

## Isolated candidate, not an approved upgrade

`candidate.patch` applies only to package.json/package-lock.json in a disposable
copy of this base. It pins plugin 1.54.7 and Wrangler 4.131.0, the first parent
pair inspected beyond the baseline audit's affected parent ranges. Their upstream
Miniflare 5.20260910.0-alpha fixes Sharp to 0.35.4 but still pins Undici 7.29.0.
The experiment therefore explicitly overrides Undici to **7.29.1**; this patch
substitution needs full integration validation before adoption. Nano ID resolves
to 3.3.20 within PostCSS's existing range. Workers types is pinned to 5.20260910.1, the minimum Wrangler peer; retaining
the baseline version caused npm ci to reject the candidate. Syntax highlighting
remains at baseline. Terser, Vite, React and
application dependencies remain unchanged. No `audit fix --force` was used.
This is a bounded low-churn candidate, not a claim of a globally minimal upgrade.

The declared plugin peers accept Vite 8 and Wrangler ^4.131.0; Wrangler also
requires workers-types ^5.20260910.1. Wrangler/Miniflare
require Node >=22; existing Vite requires >=22.12 on Node 22. Resolution and
`npm ci --ignore-scripts --no-audit` succeeded on Node 24.19.0/npm 11.9.0;
Node 22 CI and complete candidate behavior are **not** validated. Candidate audits
all/production are zero at the recorded time. Advisory databases can change.

## Exact blocker and preservation

`prepare-builtin-runtime.mjs` hashes the entire root package-lock.json and calls
`assertRuntimeReleaseSource` before output. Next/reporting/readiness preparers
also include it. Merely substituting candidate lock bytes with identical worker,
vendor and script inputs reproduces the recorded rejection in
`signature-blocker.json`. Existing history and all signature inputs remain
untouched. Changing only package.json cannot update npm ci's installed tree.

Repository search found no supported separate toolchain lock/build route. The
existing cross-account packaging guide pins Wrangler 4.118.0, and historical
review explicitly preserves lockfile signatures. A separate reviewed design is
needed to preserve reproducible historical builds while allowing future toolchain
updates; it must retain old inputs/records and establish an explicit new build
identity where needed. Simply rewriting historical hashes, dropping lock inputs,
or registering a new default does not satisfy preservation.

Baseline npm ci, strict app/Worker/tooling typechecks, full app+Worker build,
114 runtime tests (builtin preview, reference bridge, consent timer, artifact
candidate, artifact bundle, runtime history), and Wrangler local dry-run packaging
passed. Root package/lock, frozen sources/registry and existing generated inputs
are unchanged. Candidate npm ci and audits passed, but candidate preparation is
blocked before artifacts can be generated, so candidate build, dry-run and byte
parity are **not** claimed. No hosted resources, tokens or production deployments
were changed. Existing dependency CI remains report-only.

## Reproduce the boundary

In a disposable worktree at the base, apply `candidate.patch`, then copy its two
package files into an isolated candidate directory. Run npm ci and audits there.
From the unchanged base worktree:

```sh
node scripts/verify-toolchain-signature-boundary.mjs /absolute/candidate/package-lock.json
```

This verifier exits 0 only when the expected frozen-signature rejection reproduces;
that is a blocker assertion, not upgrade acceptance. Receipt SHA-256 values bind
the exact lockfiles. The committed patch preserves the resolved graph without
relying on future registry resolution. Keep MBA-52 open.
