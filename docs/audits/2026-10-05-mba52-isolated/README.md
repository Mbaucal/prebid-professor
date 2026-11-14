# Opt-in isolated toolchain — MBA-52 remains In Progress

This implementation provides a guarded local/CI build path. It does **not** migrate
the default development/deployment pipelines or authorize a deployment. The
historical root package and lock, frozen source inputs, release entries, runtime
versions and site defaults are unchanged.

## Two dependency roots

The repository root remains the historical compiler root. Bootstrap installs its
exact checked-in lock with `npm ci --omit=dev --ignore-scripts`. `tools/` has a
separate pinned lock for the modern Vite/Cloudflare/Wrangler/TypeScript toolchain.
It is installed with `npm ci --include=dev --ignore-scripts`. Its Vite config sets
the application root explicitly; strict configs extend the existing app/Worker
settings without excluding production files or weakening strictness.

The sole package bridge is `node_modules/esbuild` →
`../tools/node_modules/esbuild`. The unchanged preparer imports esbuild to bundle
the browser test-page client. Historical esbuild 0.28.1 wrapper files **and the
Linux x64 platform executable** are compared byte-for-byte with the baseline.
There are no compiler-source symlinks or substitutions for source hash inputs.
The original lock remains inside every existing source-component hash.

Before every supported command, the verifier checks the root lock digest, signed
source-component bytes, all installed files of 16 historical production package
instances, exact package-instance paths (including nested dependencies), and the
bridge. It resolves Terser, its parser/source-map dependency, and fflate from the
actual compiler importer. Extra root development packages and nested package
shadowing fail closed. Running ordinary root `npm ci` reinstalls legacy dev tools
and deliberately makes the isolated command refuse to run until bootstrap is
repeated. Tools commands use explicit tool binary paths; they cannot fall back to
an old root executable or download a missing executable with npx.

## Run the opt-in path

Initial supported platform: Linux x64. Local evidence used Node v24.19.0. The
existing `ci.yml` adds a separate Node 22 job; its result must be checked separately
before claiming Node 22 acceptance. The original CI build job remains visible.

```sh
node scripts/bootstrap-toolchain.mjs
node scripts/isolated-toolchain.mjs typecheck
node scripts/isolated-toolchain.mjs build
node --test tests/runtime/toolchain-isolation.test.mjs
node --experimental-strip-types tools/verify-compiled-parity.mjs
node scripts/isolated-toolchain.mjs dry-run
node scripts/audit-isolated-toolchain.mjs
```

`npm run build --prefix tools`, `npm run typecheck --prefix tools`, and
`npm run dry-run --prefix tools` invoke the same guarded entrypoint. There is no
remote deploy command in this opt-in wrapper. Bootstrap is repeatable: npm ci
replaces the previous root dependency tree and the bridge is recreated/verified.

## Preservation evidence and limits

The full baseline commit is recorded in `tools/historical-inputs.json`:
`685d90b6974133e19e96f7ceb28e60a58b7ce402`.
The receipt contains the original lock SHA-256, the 24 source-component files
shared by the four available historical runtime manifests, and package file hashes.
The four variants are reference 3.9.1 preview.2, positions 3.10 preview.1, reporting
3.13.0 and readiness 3.14.0. All four original source-hash guards still execute.

A fresh preparation with the isolated installation reproduced 63 historical fixed
output files, including readable/minified JS, manifests, CSS, reference data, and
the Tanjug pilot/AA/compact/CMP archives. Hash expectations came from a clean
baseline install and the unchanged preparers, not from the candidate outputs.
Negative tests alter the old lock, installed compiler bytes, esbuild binary,
generated output and root/nested dependency tree and require rejection.

The signed reporting/readiness preparer scripts remain in the permanent source
gate. The mutable `test-page-client.mjs` bundle and the other unsigned preparer script hashes
are **one-time baseline comparison evidence**, separated from the permanent frozen
input/output gate. Ordinary test-page UI development is not required to update a
historical signature. The isolated build records its current test-page bundle hash
and tool-lock identity as consumer-build provenance, separate from runtime source
descriptors. This change does not create a new runtime version.

The compiled-Worker harness invokes the actual Vite-built Worker over local HTTP,
using synthetic local D1/R2. Its authenticated GAM-only + TakeOver fixture produces
nine files and a ZIP byte-identical to the unchanged source compiler for the same
captured timestamp and SQL snapshot; 401/403 and zero external traffic are checked.
That is one compiled HTTP fixture, not proof for every configuration or native
Prebid auction. The outer deployable Worker hash is separate evidence and need not
match the legacy bundler. Existing unavailable historical variants, publisher
saved archives not present locally, and TEST-only 3.15 sources are outside this
main-baseline proof. Do not carry the receipt to TEST or rewrite it to pass there.

To independently reproduce the receipt, make a clean detached checkout of the
receipt's full baseline commit, install with `npm ci --ignore-scripts`, then run:

```sh
node scripts/prepare-builtin-runtime.mjs
node --experimental-strip-types scripts/prepare-site-ab-baseline.mjs
```

From the candidate checkout, run
`node scripts/capture-historical-toolchain.mjs /absolute/clean/baseline`.
It checks exact baseline identity and compares package/source/output evidence. It
never refreshes or rewrites expected hashes. Keep that baseline's `.generated`
directory limited to those preparers when reproducing the receipt.

## Audit and adoption boundary

The fresh local audit reports 0 active-root-production findings and 0 tools-lock
findings. The **unchanged full historical root lock still reports six high package
nodes**, 0 critical. Those development dependencies are omitted from this isolated
installation; they have not been erased, silently accepted, or globally remediated.
Raw audit JSON and build/compiled-route receipts are uploaded by the isolated CI
job from `.generated/toolchain-evidence/` and `.generated/toolchain-validation/`.

Remaining legacy paths include root `npm ci`, `npm run dev/build/typecheck/deploy`,
root `vite.config.ts`, existing workflows using root npm ci and root/ops
`npx --no-install wrangler`, the Cloudflare deploy action pinned to Wrangler
4.118.0, and external Cloudflare Builds automatic install settings (not represented
in repository configuration). The original CI job and those paths retain their
previous exposure. Migrating them needs its own reviewed adoption change and
hosted TEST validation. No Cloudflare setting, token, publisher data or production
resource was changed here; MBA-52 remains In Progress.
